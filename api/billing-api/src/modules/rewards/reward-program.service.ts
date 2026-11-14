import {
  Inject,
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  adDigest,
  adEventJournalMatches,
  validEvidenceSignature,
  evidenceSignature,
} from "@crimfig/shared";
import { AdClearanceService } from "../ecosystem/ad-clearance.service";
import {
  canonicalPaidRewardLoops,
  paidRewardMetric,
  earnedLoopDelta,
  paidBadgeAwards,
} from "../../../../../shared/src/rewards-performance-policy";
import {
  positive,
  conversionQuote,
  reserveFloor,
  gate,
  fundedPolicy,
  RewardCapacityUnavailable,
} from "./reward-program-policy";
const rows = (r: any): any[] => r.rows ?? r;
const camel = (r: any): Record<string, any> =>
  Object.fromEntries(
    Object.entries(r).map(([k, v]) => [
      k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
      v,
    ]),
  );
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
@Injectable()
export class RewardProgramService {
  constructor(
    @Inject("DATABASE_CONNECTION") private readonly db: any,
    private readonly financial: AdClearanceService,
  ) {}
  private id(v: string) {
    if (!uuid.test(v ?? "")) throw new BadRequestException("UUID required");
  }
  private enabled(kind: "funding" | "paid" | "conversion") {
    if (!gate(kind))
      throw new ConflictException(
        "Funded rewards operation disabled pending separate policy, funding and activation approval",
      );
  }
  private async locked<T>(fn: (tx: any, now: Date) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx: any) => {
      await tx.execute(sql`set local lock_timeout='5s'`);
      await tx.execute(sql`set local statement_timeout='8s'`);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended('cfig:global-allocation',0))`,
      );
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended('rewards-fund:USD',0))`,
      );
      const [clock] = rows(
        await tx.execute(sql`SELECT clock_timestamp() AS now`),
      );
      return fn(tx, new Date(clock.now));
    });
  }
  private async replay(tx: any, requestId: string, fingerprint: string) {
    const [r] = rows(
      await tx.execute(
        sql`SELECT * FROM reward_program_issues WHERE request_id=${requestId}`,
      ),
    );
    if (r && r.fingerprint !== fingerprint)
      throw new ConflictException("Reward request identity changed");
    return r?.payload;
  }
  private async settings(tx: any, now: Date) {
    const [s] = rows(
      await tx.execute(
        sql`SELECT * FROM rewards_fund_settings WHERE is_active AND effective_from<=${now} ORDER BY version DESC LIMIT 1 FOR SHARE`,
      ),
    );
    if (
      !s ||
      new Set(s.approved_by ?? []).size < 2 ||
      s.ads_rewards_global_paused
    )
      throw new ConflictException(
        "Approved active unpaused rewards settings required",
      );
    for (const key of [
      "per_user_daily_cap_points",
      "per_user_monthly_cap_points",
      "daily_emission_cap_points",
      "monthly_emission_cap_points",
      "pending_hold_hours",
      "points_expiry_days",
    ])
      if (!Number.isSafeInteger(s[key]) || s[key] < 0)
        throw new ConflictException("Invalid rewards configuration");
    if (s.pending_hold_hours < 72)
      throw new ConflictException("Minimum audit hold cannot be reduced");
    for (const reviewer of s.approved_by)
      await this.financial.authorize(reviewer, tx);
    return s;
  }
  private async fund(tx: any) {
    const [fund] = rows(
      await tx.execute(
        sql`SELECT * FROM rewards_fund WHERE currency='USD' FOR UPDATE`,
      ),
    );
    if (!fund)
      throw new ConflictException("Existing reconciled Rewards Fund required");
    return fund;
  }
  private async backing(
    tx: any,
    id: string,
    fund: any,
    amount: bigint,
    reviewers?: string[],
  ) {
    const [r] = rows(
      await tx.execute(
        sql`SELECT * FROM billing_provider_events WHERE id=${id} AND processed=true AND event_type='rewards.backing.reconciled.v1' FOR SHARE`,
      ),
    );
    const envelope = r?.raw_payload,
      p = envelope?.payload;
    if (
      !p ||
      p.fundId !== fund.id ||
      positive(p.amountCents) < amount ||
      !p.fundLedgerId ||
      !Array.isArray(p.reviewers) ||
      new Set(p.reviewers).size !== 2 ||
      p.reviewers.length !== 2 ||
      !p.reference ||
      !Number.isFinite(Date.parse(p.expiresAt)) ||
      Date.parse(p.expiresAt) <= Date.now() ||
      !validEvidenceSignature(
        { ...p, keyId: envelope.keyId },
        envelope.signature,
      )
    )
      throw new ConflictException(
        "Verified signed backing receipt required; admin amounts are not funding",
      );
    for (const who of p.reviewers) await this.financial.authorize(who, tx);
    if (reviewers && reviewers.some((who) => !p.reviewers.includes(who)))
      throw new ForbiddenException(
        "Backing reconciliation requires matching independent reviewers",
      );
    const [ledger] = rows(
      await tx.execute(
        sql`SELECT * FROM rewards_fund_ledger WHERE id=${p.fundLedgerId} AND fund_id=${fund.id} FOR SHARE`,
      ),
    );
    if (
      !ledger ||
      !["sweep_in", "adjust_in"].includes(ledger.type) ||
      BigInt(ledger.amount_cents) < amount
    )
      throw new ConflictException(
        "Reconciliation does not bind actual inbound fund ledger",
      );
    return p;
  }
  async propose(actor: string, input: any) {
    this.id(input.requestId);
    this.id(input.proofId);
    if (!["paid_performance", "house_conversion"].includes(input.program))
      throw new BadRequestException("Unknown reward program");
    const amount = positive(input.amountCents);
    const policy = fundedPolicy();
    if (
      typeof input.effectiveFrom !== "string" ||
      !Number.isFinite(Date.parse(input.effectiveFrom))
    )
      throw new BadRequestException(
        "Explicit prospective effective date required",
      );
    if (input.program === "house_conversion") this.id(input.housePolicyId);
    const snapshot = {
      ...policy,
      effectiveFrom: new Date(input.effectiveFrom).toISOString(),
      cfigPerPoint:
        input.program === "house_conversion"
          ? positive(input.cfigPerPoint).toString()
          : null,
      housePolicyId: input.housePolicyId ?? null,
      paidLoops: canonicalPaidRewardLoops(),
    };
    const fingerprint = adDigest({
      actor,
      requestId: input.requestId,
      proofId: input.proofId,
      program: input.program,
      amountCents: amount.toString(),
      effectiveFrom: snapshot.effectiveFrom,
      housePolicyId: snapshot.housePolicyId,
      cfigPerPoint: snapshot.cfigPerPoint,
    });
    return this.locked(async (tx, now) => {
      await this.financial.authorize(actor, tx);
      const [prior] = rows(
        await tx.execute(
          sql`SELECT * FROM reward_program_allocations WHERE request_id=${input.requestId}`,
        ),
      );
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new ConflictException("Allocation identity changed");
        return prior;
      }
      this.enabled("funding");
      if (new Date(snapshot.effectiveFrom) <= now)
        throw new BadRequestException(
          "New allocation terms must be prospective",
        );
      const fund = await this.fund(tx),
        settings = await this.settings(tx, now);
      reserveFloor(fund, settings);
      const backing = await this.backing(tx, input.proofId, fund, amount);
      if (input.program === "house_conversion") {
        const [p] = rows(
          await tx.execute(
            sql`SELECT * FROM cfig_policies WHERE id=${input.housePolicyId} AND approved_at IS NOT NULL`,
          ),
        );
        if (
          !p ||
          String(p.terms.houseRewards.proposedCfigPerFundedPoint) !==
            snapshot.cfigPerPoint
        )
          throw new ConflictException(
            "Conversion must preserve original approved cohort valuation",
          );
      }
      const id = randomUUID();
      await tx.execute(
        sql`INSERT INTO reward_program_allocations(id,request_id,fingerprint,program,fund_id,proof_id,backing_source_ref,amount_cents,policy_snapshot,created_by) VALUES(${id},${input.requestId},${fingerprint},${input.program},${fund.id},${input.proofId},${backing.fundLedgerId},${amount.toString()}::bigint,${JSON.stringify(snapshot)}::jsonb,${actor})`,
      );
      return { id, status: "awaiting_independent_approval", snapshot };
    });
  }
  private async fundMovement(
    tx: any,
    fund: any,
    delta: { available: bigint; pending: bigint; allocated: bigint },
    source: string,
    actor: string,
  ) {
    const available = BigInt(fund.available_usd_cents) + delta.available,
      pending = BigInt(fund.funded_pending_usd_cents) + delta.pending,
      allocated = BigInt(fund.allocated_usd_cents) + delta.allocated;
    if (
      [available, pending, allocated].some((v) => v < 0n) ||
      available + pending + allocated !== BigInt(fund.cash_balance_usd_cents)
    )
      throw new ConflictException("Backing cannot be consumed twice");
    await tx.execute(
      sql`UPDATE rewards_fund SET available_usd_cents=${available.toString()}::bigint,funded_pending_usd_cents=${pending.toString()}::bigint,allocated_usd_cents=${allocated.toString()}::bigint,version=version+1,updated_at=clock_timestamp() WHERE id=${fund.id}`,
    );
    await tx.execute(
      sql`INSERT INTO rewards_fund_ledger(fund_id,type,amount_cents,from_bucket,to_bucket,cash_balance_after_cents,available_after_cents,allocated_after_cents,funded_pending_after_cents,source_ref,description,actor_id) VALUES(${fund.id},'allocate',${(delta.allocated || delta.pending).toString()}::bigint,${delta.available < 0n ? "available" : "funded_pending"},${delta.allocated > 0n ? "allocated" : "funded_pending"},${String(fund.cash_balance_usd_cents)}::bigint,${available.toString()}::bigint,${allocated.toString()}::bigint,${pending.toString()}::bigint,${source},'Backed program allocation/issuance',${actor})`,
    );
  }
  async approve(actor: string, id: string, input: any) {
    this.id(id);
    this.id(input.requestId);
    return this.locked(async (tx, now) => {
      await this.financial.authorize(actor, tx);
      const [a] = rows(
        await tx.execute(
          sql`SELECT * FROM reward_program_allocations WHERE id=${id} FOR UPDATE`,
        ),
      );
      if (!a) throw new NotFoundException("Allocation not found");
      if (a.created_by === actor)
        throw new ForbiddenException(
          "Independent allocation approver required",
        );
      if (a.approved_at) {
        if (
          a.approved_by !== actor ||
          a.approval_request_id !== input.requestId
        )
          throw new ConflictException("Approval identity changed");
        return a;
      }
      this.enabled("funding");
      const settings = await this.settings(tx, now),
        fund = await this.fund(tx),
        amount = BigInt(a.amount_cents);
      await this.backing(tx, a.proof_id, fund, amount, [a.created_by, actor]);
      if (
        BigInt(fund.available_usd_cents) - amount <
        reserveFloor(fund, settings)
      )
        throw new ConflictException(
          "Insufficient uncommitted fund above reserve requirements",
        );
      await this.fundMovement(
        tx,
        fund,
        { available: -amount, pending: amount, allocated: 0n },
        "program-reserve:" + id,
        actor,
      );
      await tx.execute(
        sql`UPDATE reward_program_allocations SET approved_by=${actor},approval_request_id=${input.requestId},approved_at=${now} WHERE id=${id}`,
      );
      return { id, status: "funded_reserved", amountCents: amount.toString() };
    });
  }
  private async capacity(
    tx: any,
    a: any,
    userId: string,
    points: bigint,
    now: Date,
  ) {
    if (!a?.approved_at || new Date(a.policy_snapshot.effectiveFrom) > now)
      throw new ConflictException(
        "Approved effective program allocation required",
      );
    const settings = await this.settings(tx, now),
      fund = await this.fund(tx);
    reserveFloor(fund, settings);
    await this.backing(tx, a.proof_id, fund, BigInt(a.amount_cents), [
      a.created_by,
      a.approved_by,
    ]);
    const [reserved] = rows(
      await tx.execute(
        sql`SELECT coalesce(sum(a.amount_cents-(SELECT coalesce(sum(points),0) FROM reward_program_issues i WHERE i.allocation_id=a.id)),0)::text AS units FROM reward_program_allocations a WHERE a.approved_at IS NOT NULL`,
      ),
    );
    const [liabilities] = rows(
      await tx.execute(
        sql`SELECT coalesce(sum(pending_points),0)::text AS pending,coalesce(sum(available_points+reserved_points),0)::text AS available FROM rewards_points_balances`,
      ),
    );
    if (
      BigInt(fund.funded_pending_usd_cents) <
        BigInt(reserved.units) + BigInt(liabilities.pending) ||
      BigInt(fund.allocated_usd_cents) < BigInt(liabilities.available)
    )
      throw new ConflictException(
        "Existing point backing requires reconciliation",
      );
    const [spent] = rows(
      await tx.execute(
        sql`SELECT coalesce(sum(points),0)::text AS units FROM reward_program_issues WHERE allocation_id=${a.id}`,
      ),
    );
    if (BigInt(a.amount_cents) - BigInt(spent.units) < points)
      throw new RewardCapacityUnavailable("Program backing exhausted");
    const [balance] = rows(
      await tx.execute(
        sql`SELECT * FROM rewards_points_balances WHERE user_id=${userId} FOR UPDATE`,
      ),
    );
    if (balance?.is_rewards_suspended)
      throw new ConflictException("User rewards are suspended");
    const [owner] = rows(
      await tx.execute(
        sql`SELECT status FROM users WHERE id=${userId} FOR SHARE`,
      ),
    );
    if (owner?.status !== "ACTIVE")
      throw new ForbiddenException("Active reward owner required");
    const period = now.toISOString(),
      day = period.slice(0, 10),
      month = period.slice(0, 7),
      base =
        BigInt(fund.available_usd_cents) +
        BigInt(reserved.units) -
        reserveFloor(fund, settings),
      awardable = base > 0n ? base : 0n;
    for (const kind of ["day", "month"] as const) {
      const value = kind === "day" ? day : month,
        percent =
          kind === "day"
            ? a.policy_snapshot.dailyEmissionPercent
            : a.policy_snapshot.monthlyEmissionPercent,
        absolute =
          kind === "day"
            ? settings.daily_emission_cap_points
            : settings.monthly_emission_cap_points;
      const calculated = (awardable * BigInt(percent)) / 100n,
        cap = calculated < BigInt(absolute) ? calculated : BigInt(absolute);
      await tx.execute(
        sql`INSERT INTO reward_issuance_periods(period,kind,cap_points,snapshot) VALUES(${value},${kind},${Number(cap)},${JSON.stringify({ settingsVersion: settings.version, base: awardable.toString(), percent, absolute })}::jsonb) ON CONFLICT DO NOTHING`,
      );
      const [budget] = rows(
        await tx.execute(
          sql`SELECT cap_points FROM reward_issuance_periods WHERE period=${value} AND kind=${kind}`,
        ),
      );
      const [usage] = rows(
        await tx.execute(
          sql`SELECT coalesce(sum(delta_points),0)::text AS total,coalesce(sum(delta_points) FILTER(WHERE user_id=${userId}),0)::text AS personal FROM rewards_points_ledger WHERE delta_points>0 AND activity_code<>'reward_clearance_available' AND (earned_at AT TIME ZONE 'UTC')::text LIKE ${value + "%"}`,
        ),
      );
      const userCap =
        kind === "day"
          ? settings.per_user_daily_cap_points
          : settings.per_user_monthly_cap_points;
      if (
        BigInt(usage.total) + points > BigInt(budget.cap_points) ||
        BigInt(usage.personal) + points > BigInt(userCap)
      )
        throw new RewardCapacityUnavailable("Funded emission cap reached");
    }
    if (
      points <= 0n ||
      points > 2147483647n ||
      BigInt(balance?.available_points ?? 0) + points > 2147483647n ||
      BigInt(balance?.lifetime_earned_points ?? 0) + points > 2147483647n
    )
      throw new ConflictException("Point integer capacity exceeded");
    return { settings, fund };
  }
  private async credit(
    tx: any,
    userId: string,
    points: bigint,
    source: string,
    now: Date,
    expiryDays: number,
  ) {
    const id = randomUUID();
    await tx.execute(
      sql`INSERT INTO rewards_points_balances(user_id) VALUES(${userId}) ON CONFLICT(user_id) DO NOTHING`,
    );
    await tx.execute(
      sql`UPDATE rewards_points_balances SET available_points=available_points+${Number(points)},lifetime_earned_points=lifetime_earned_points+${Number(points)},version=version+1,updated_at=${now} WHERE user_id=${userId}`,
    );
    await tx.execute(
      sql`INSERT INTO rewards_points_ledger(id,lot_id,user_id,delta_points,state,activity_code,source_ref,idempotency_key,valuation_microusd,rate_version,expires_at,cleared_at,earned_at) VALUES(${id},${"program:" + id},${userId},${Number(points)},'available','reward_program_available',${source},${source},${(points * 10000n).toString()}::bigint,1,${new Date(+now + expiryDays * 86400000)},${now},${now})`,
    );
    return id;
  }
  async convert(userId: string, input: any) {
    this.id(userId);
    this.id(input.requestId);
    this.id(input.allocationId);
    this.id(input.policyId);
    const fingerprint = adDigest({
      userId,
      requestId: input.requestId,
      allocationId: input.allocationId,
      policyId: input.policyId,
      microCfig: input.microCfig,
    });
    return this.locked(async (tx, now) => {
      const prior = await this.replay(tx, input.requestId, fingerprint);
      if (prior) return prior;
      this.enabled("conversion");
      const [a] = rows(
        await tx.execute(
          sql`SELECT * FROM reward_program_allocations WHERE id=${input.allocationId} AND program='house_conversion' FOR SHARE`,
        ),
      );
      if (!a || a.policy_snapshot.housePolicyId !== input.policyId)
        throw new ConflictException("Conversion cohort terms do not match");
      const [promoter] = rows(
        await tx.execute(
          sql`SELECT * FROM ads_promoters WHERE user_id=${userId} AND is_active AND NOT is_suspended FOR SHARE`,
        ),
      );
      if (!promoter) throw new ForbiddenException("Active promoter required");
      const lots = rows(
        await tx.execute(
          sql`SELECT event_id,sum(available_delta)::text AS units FROM cfig_ledger WHERE promoter_id=${promoter.id} AND policy_id=${input.policyId} GROUP BY event_id HAVING sum(available_delta)>0 ORDER BY event_id`,
        ),
      );
      const [monthly] = rows(
        await tx.execute(
          sql`SELECT coalesce(sum(points),0)::text AS points FROM reward_program_issues WHERE user_id=${userId} AND kind='cfig_conversion' AND (created_at AT TIME ZONE 'UTC')::text LIKE ${now.toISOString().slice(0, 7) + "%"}`,
        ),
      );
      const quote = conversionQuote(
        input.microCfig,
        Number(a.policy_snapshot.cfigPerPoint),
        lots.reduce((sum, r) => sum + BigInt(r.units), 0n),
        BigInt(monthly.points),
      );
      const { settings, fund } = await this.capacity(
        tx,
        a,
        userId,
        quote.points,
        now,
      );
      let remaining = quote.debited;
      const sources = [];
      for (const lot of lots) {
        if (!remaining) break;
        const amount =
          BigInt(lot.units) < remaining ? BigInt(lot.units) : remaining;
        const id = randomUUID();
        await tx.execute(
          sql`INSERT INTO cfig_ledger(id,request_id,fingerprint,event_id,promoter_id,policy_id,kind,pending_delta,available_delta,invalid_delta,converted_delta,actor_id,reason,created_at) VALUES(${id},${randomUUID()},${fingerprint},${lot.event_id},${promoter.id},${input.policyId},'convert',0,${(-amount).toString()}::bigint,0,${amount.toString()}::bigint,${userId},'Approved cohort funded conversion',${now})`,
        );
        sources.push({
          eventId: lot.event_id,
          microCfig: amount.toString(),
          ledgerId: id,
        });
        remaining -= amount;
      }
      await this.fundMovement(
        tx,
        fund,
        { available: 0n, pending: -quote.points, allocated: quote.points },
        "cfig-conversion:" + input.requestId,
        userId,
      );
      const ledgerId = await this.credit(
          tx,
          userId,
          quote.points,
          "cfig-conversion:" + input.requestId,
          now,
          settings.points_expiry_days,
        ),
        id = randomUUID();
      const receipt = {
        authorityVersion: "rewards-program-v1",
        id,
        requestId: input.requestId,
        userId,
        allocationId: a.id,
        policyId: input.policyId,
        points: quote.points.toString(),
        debitedMicroCfig: quote.debited.toString(),
        residualMicroCfig: quote.residual.toString(),
        pointsLedgerId: ledgerId,
        sources,
      };
      await tx.execute(
        sql`INSERT INTO reward_program_issues(id,request_id,fingerprint,allocation_id,user_id,kind,points,micro_cfig,source_ref,payload,created_at) VALUES(${id},${input.requestId},${fingerprint},${a.id},${userId},'cfig_conversion',${Number(quote.points)},${quote.debited.toString()}::bigint,${"cfig-conversion:" + input.requestId},${JSON.stringify(receipt)}::jsonb,${now})`,
      );
      return receipt;
    });
  }
  async processPaid(actor: string, eventId: string, input: any) {
    this.id(eventId);
    this.id(input.requestId);
    this.id(input.allocationId);
    return this.locked(async (tx, now) => {
      await this.financial.authorize(actor, tx);
      const fingerprint = adDigest({
        actor,
        eventId,
        requestId: input.requestId,
        allocationId: input.allocationId,
      });
      const [prior] = rows(
        await tx.execute(
          sql`SELECT payload,fingerprint FROM reward_performance_receipts WHERE event_id=${eventId} OR request_id=${input.requestId}`,
        ),
      );
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new ConflictException("Performance receipt identity changed");
        return prior.payload;
      }
      this.enabled("paid");
      const [a] = rows(
        await tx.execute(
          sql`SELECT * FROM reward_program_allocations WHERE id=${input.allocationId} AND program='paid_performance' AND approved_at IS NOT NULL FOR SHARE`,
        ),
      );
      if (!a)
        throw new ConflictException(
          "Approved paid rewards allocation required",
        );
      const [e] = rows(
        await tx.execute(
          sql`SELECT * FROM ads_interactions WHERE id=${eventId} FOR SHARE`,
        ),
      );
      const [v] = e
        ? rows(
            await tx.execute(
              sql`SELECT * FROM ads_serves WHERE id=${e.serve_id} FOR SHARE`,
            ),
          )
        : [];
      const [r] = v
        ? rows(
            await tx.execute(
              sql`SELECT * FROM ads_opportunity_reservations WHERE id=${v.opportunity_reservation_id} FOR SHARE`,
            ),
          )
        : [];
      const [claim] = rows(
        await tx.execute(
          sql`SELECT * FROM ads_settlement_claims WHERE interaction_id=${eventId} FOR SHARE`,
        ),
      );
      const [item] = claim
        ? rows(
            await tx.execute(
              sql`SELECT * FROM ads_promoter_settlement_items WHERE batch_id=${claim.batch_id} AND promoter_id=${claim.promoter_id} AND campaign_id=${v?.campaign_id} AND clearance_status='cleared' AND status='credited' AND cleared_at IS NOT NULL AND hold_expires_at<=${now} FOR SHARE`,
            ),
          )
        : [];
      const [p] = e
        ? rows(
            await tx.execute(
              sql`SELECT * FROM ads_promoters WHERE id=${e.promoter_id} AND is_active AND NOT is_suspended FOR SHARE`,
            ),
          )
        : [];
      const [assessment] = rows(
        await tx.execute(
          sql`SELECT * FROM ads_event_assessments WHERE event_id=${eventId} ORDER BY created_at DESC,id DESC LIMIT 1`,
        ),
      );
      const [journal] = rows(
        await tx.execute(
          sql`SELECT * FROM ads_evidence_records WHERE event_id=${eventId}`,
        ),
      );
      if (
        !e ||
        !v ||
        !r ||
        !p ||
        !item ||
        !assessment ||
        !journal ||
        new Date(e.created_at) < new Date(a.policy_snapshot.effectiveFrom) ||
        +now - +new Date(e.created_at) < 72 * 3600000 ||
        claim.serve_id !== v.id ||
        claim.promoter_id !== p.id ||
        e.serve_id !== v.id ||
        v.promoter_id !== p.id ||
        assessment.actor_id === p.user_id ||
        assessment.campaign_id !== v.campaign_id ||
        assessment.features?.integrity !== true
      )
        throw new ConflictException("Audited settled pricing event required");
      const [cashReceipt] = rows(
        await tx.execute(
          sql`SELECT * FROM billing_transactions WHERE id=${item.billing_transaction_id} FOR SHARE`,
        ),
      );
      let cashMeta: any;
      try {
        cashMeta = JSON.parse(cashReceipt?.metadata ?? "{}");
      } catch {
        throw new ConflictException(
          "Settlement receipt requires reconciliation",
        );
      }
      if (
        !cashReceipt ||
        cashReceipt.provider !== "internal" ||
        cashReceipt.type !== "ads_earning" ||
        cashReceipt.status !== "completed" ||
        cashReceipt.user_id !== p.user_id ||
        cashReceipt.amount_usd_cents !== item.earned_usd_cents ||
        cashMeta.itemId !== item.id ||
        cashMeta.batchId !== claim.batch_id ||
        cashMeta.campaignId !== v.campaign_id ||
        cashMeta.promoterId !== p.id ||
        cashMeta.kind !== "funded_ad_earning" ||
        cashMeta.version !== 3
      )
        throw new ConflictException(
          "Settled cash receipt does not bind the pricing event",
        );
      const { recordHash, createdAt, ...signed } = camel(assessment);
      const j = {
        eventId: journal.event_id,
        partition: journal.partition,
        previousHash: journal.previous_hash,
        payload: journal.payload,
        keyId: journal.key_id,
      };
      const metric = paidRewardMetric(
        {
          inventoryClass: v.inventory_class,
          deliveryMode: v.delivery_mode,
          pricingModel: r.pricing_model,
          type: e.type,
          eventId: e.id,
          serveId: v.id,
          promoterId: p.id,
          claimEventId: r.claim_event_id,
          reservationServeId: r.serve_id,
          reservationPromoterId: r.promoter_id,
          simulated: r.is_simulated,
          isValid: e.is_valid,
          auditOutcome: assessment.outcome,
          evidenceIntegrity:
            adEventJournalMatches(camel(e), {
              eventId: journal.event_id,
              payload: journal.payload,
            }) &&
            validEvidenceSignature(j, journal.record_hash) &&
            validEvidenceSignature(signed, recordHash),
          settledAt: r.settled_at ? new Date(r.settled_at) : null,
        },
        now,
      );
      if (!metric || r.state !== "CLAIMED")
        throw new ConflictException(
          "Reward metric is not an audited billable pricing event",
        );
      const suspended = rows(
        await tx.execute(
          sql`SELECT DISTINCT ON(scope) scope,action FROM ads_rewards_suspension_audit WHERE (scope='global' OR target_user_id=${p.user_id}) AND created_at<=${e.created_at} ORDER BY scope,created_at DESC,id DESC`,
        ),
      );
      if (suspended.some((s) => s.action === "pause"))
        throw new ConflictException(
          "No retroactive credit for paused activity",
        );
      await this.settings(tx, now);
      if (new Date(a.policy_snapshot.effectiveFrom) > now)
        throw new ConflictException("Program allocation not effective");
      const paidFund = await this.fund(tx);
      await this.backing(tx, a.proof_id, paidFund, BigInt(a.amount_cents), [
        a.created_by,
        a.approved_by,
      ]);
      const version = a.policy_snapshot.paidLoops.version;
      const [count] = rows(
        await tx.execute(
          sql`SELECT (count(*) FILTER (WHERE event.is_valid))::text AS total,
            coalesce(sum(issue.points), 0)::text AS issued
          FROM reward_performance_receipts receipt
          JOIN ads_interactions event ON event.id = receipt.event_id
          LEFT JOIN reward_program_issues issue ON issue.source_ref = 'paid-loop:' || receipt.event_id::text
            AND issue.kind = 'paid_loop' AND issue.user_id = receipt.user_id
          WHERE receipt.user_id=${p.user_id} AND receipt.model=${r.pricing_model}
            AND receipt.payload->>'rateVersion'=${version}`,
        ),
      );
      const delta = earnedLoopDelta(
          r.pricing_model,
          BigInt(count.total),
          BigInt(count.total) + 1n,
        ),
        entitlement = BigInt(earnedLoopDelta(r.pricing_model, 0n, BigInt(count.total) + 1n).potentialPoints),
        remaining = entitlement - BigInt(count.issued),
        nextAward = BigInt(delta.potentialPoints),
        points = remaining <= 0n ? 0n : remaining < nextAward ? remaining : nextAward;
      let issued = "0";
      let fundingStatus = points ? "funded" : "below_threshold";
      if (points) {
        let capacity: any;
        try {
          capacity = await this.capacity(tx, a, p.user_id, points, now);
        } catch (error) {
          if (!(error instanceof RewardCapacityUnavailable)) throw error;
          fundingStatus = "unfunded_no_points_issued";
        }
        if (capacity) {
          const { settings, fund } = capacity;
          await this.fundMovement(
            tx,
            fund,
            { available: 0n, pending: -points, allocated: points },
            "paid-loop:" + eventId,
            actor,
          );
          const ledgerId = await this.credit(
              tx,
              p.user_id,
              points,
              "paid-loop:" + eventId,
              now,
              settings.points_expiry_days,
            ),
            id = randomUUID(),
            payload = {
              id,
              eventId,
              userId: p.user_id,
              points: points.toString(),
              pointsLedgerId: ledgerId,
              rateVersion: version,
            };
          await tx.execute(
            sql`INSERT INTO reward_program_issues(id,request_id,fingerprint,allocation_id,user_id,kind,points,source_ref,payload,created_at) VALUES(${id},${input.requestId},${fingerprint},${a.id},${p.user_id},'paid_loop',${Number(points)},${"paid-loop:" + eventId},${JSON.stringify(payload)}::jsonb,${now})`,
          );
          issued = points.toString();
        }
      }
      await this.paidBadges(
        tx,
        p.user_id,
        r.pricing_model,
        BigInt(count.total) + 1n,
      );
      const receipt = {
        eventId,
        serveId: v.id,
        userId: p.user_id,
        metric,
        fundingStatus,
        rateVersion: version,
        pointsIssued: issued,
        loopProgress: delta,
        settlementClaimId: claim.id,
        auditId: assessment.id,
      };
      await tx.execute(
        sql`INSERT INTO reward_performance_receipts(event_id,request_id,fingerprint,serve_id,promoter_id,user_id,model,allocation_id,payload,created_at) VALUES(${e.id},${input.requestId},${fingerprint},${v.id},${p.id},${p.user_id},${r.pricing_model},${a.id},${JSON.stringify(receipt)}::jsonb,${now})`,
      );
      return receipt;
    });
  }
  private async paidBadges(
    tx: any,
    userId: string,
    model: "cpc" | "cpm",
    total: bigint,
  ) {
    for (const badge of paidBadgeAwards(model, total))
      await tx.execute(
        sql`INSERT INTO rewards_badges(user_id,badge_key,badge_title,badge_icon,tier) VALUES(${userId},${badge.key},${badge.title},${badge.icon},${badge.tier}) ON CONFLICT DO NOTHING`,
      );
  }
  async clearLegacy(actor: string, ledgerId: string, input: any) {
    this.id(ledgerId);
    this.id(input.requestId);
    this.id(input.proofId);
    const fingerprint = adDigest({
      actor,
      ledgerId,
      requestId: input.requestId,
      proofId: input.proofId,
    });
    return this.locked(async (tx, now) => {
      await this.financial.authorize(actor, tx);
      const prior = await this.replay(tx, input.requestId, fingerprint);
      if (prior) return prior;
      this.enabled("funding");
      const source = "legacy-clearance:" + ledgerId;
      const duplicate = rows(
        await tx.execute(
          sql`SELECT id FROM reward_program_issues WHERE source_ref=${source}`,
        ),
      );
      if (duplicate.length)
        throw new ConflictException("Original lot already cleared");
      const [lot] = rows(
        await tx.execute(
          sql`SELECT * FROM rewards_points_ledger WHERE id=${ledgerId} FOR UPDATE`,
        ),
      );
      if (
        !lot ||
        lot.state !== "pending" ||
        lot.delta_points <= 0 ||
        lot.user_id === actor
      )
        throw new ConflictException(
          "Independently reviewed original pending lot required",
        );
      const settings = await this.settings(tx, now);
      if (
        +now - +new Date(lot.earned_at) <
          settings.pending_hold_hours * 3600000 ||
        (lot.expires_at && new Date(lot.expires_at) <= now)
      )
        throw new ConflictException("Hold incomplete or lot expired");
      const [record] = rows(
        await tx.execute(
          sql`SELECT * FROM billing_provider_events WHERE id=${input.proofId} AND event_type='rewards.clearance.reconciled.v1' AND processed FOR SHARE`,
        ),
      );
      const envelope = record?.raw_payload,
        p = envelope?.payload;
      if (
        !p ||
        p.grantLedgerId !== ledgerId ||
        p.userId !== lot.user_id ||
        p.points !== String(lot.delta_points) ||
        !Number.isFinite(Date.parse(p.expiresAt)) ||
        new Date(p.expiresAt) <= now ||
        p.outcome !== "eligible" ||
        !Array.isArray(p.reviewers) ||
        new Set(p.reviewers).size !== 2 ||
        p.reviewers.length !== 2 ||
        p.reviewers.includes(lot.user_id) ||
        !p.reviewers.includes(actor) ||
        !validEvidenceSignature(
          { ...p, keyId: envelope.keyId },
          envelope.signature,
        )
      )
        throw new ConflictException(
          "Independent signed source-bound clearance required",
        );
      for (const who of p.reviewers) await this.financial.authorize(who, tx);
      const [balance] = rows(
        await tx.execute(
          sql`SELECT * FROM rewards_points_balances WHERE user_id=${lot.user_id} FOR UPDATE`,
        ),
      );
      if (
        !balance ||
        balance.is_rewards_suspended ||
        balance.pending_points < lot.delta_points
      )
        throw new ConflictException("User pending balance not clearable");
      const [owner] = rows(
        await tx.execute(
          sql`SELECT status FROM users WHERE id=${lot.user_id} FOR SHARE`,
        ),
      );
      if (owner?.status !== "ACTIVE")
        throw new ConflictException("Active reward beneficiary required");
      if (
        !Number.isSafeInteger(balance.available_points) ||
        balance.available_points + lot.delta_points > 2147483647
      )
        throw new ConflictException("Point integer capacity exceeded");
      const fund = await this.fund(tx);
      reserveFloor(fund, settings);
      const [reserves] = rows(
        await tx.execute(
          sql`SELECT coalesce(sum(a.amount_cents-(SELECT coalesce(sum(points),0) FROM reward_program_issues i WHERE i.allocation_id=a.id)),0)::text AS units FROM reward_program_allocations a WHERE a.approved_at IS NOT NULL`,
        ),
      );
      const [liabilities] = rows(
        await tx.execute(
          sql`SELECT coalesce(sum(pending_points),0)::text AS pending,coalesce(sum(available_points+reserved_points),0)::text AS available FROM rewards_points_balances`,
        ),
      );
      if (
        BigInt(fund.funded_pending_usd_cents) <
          BigInt(reserves.units) + BigInt(liabilities.pending) ||
        BigInt(fund.allocated_usd_cents) < BigInt(liabilities.available)
      )
        throw new ConflictException(
          "Existing point backing requires reconciliation",
        );
      const points = BigInt(lot.delta_points);
      if (
        BigInt(fund.funded_pending_usd_cents) - BigInt(reserves.units) <
        points
      )
        throw new ConflictException("Backing is committed elsewhere");
      await this.fundMovement(
        tx,
        fund,
        { available: 0n, pending: -points, allocated: points },
        source,
        actor,
      );
      await tx.execute(
        sql`UPDATE rewards_points_balances SET pending_points=pending_points-${lot.delta_points},available_points=available_points+${lot.delta_points},version=version+1,updated_at=${now} WHERE user_id=${lot.user_id}`,
      );
      for (const state of ["pending", "available"])
        await tx.execute(
          sql`INSERT INTO rewards_points_ledger(lot_id,user_id,delta_points,state,activity_code,source_ref,idempotency_key,valuation_microusd,rate_version,earned_at,cleared_at,expires_at) VALUES(${lot.lot_id},${lot.user_id},${state === "pending" ? -lot.delta_points : lot.delta_points},${state}::rewards_point_state,${state === "available" ? "reward_clearance_available" : "reward_clearance_pending"},${source},${source + ":" + state},${(points * 10000n * (state === "pending" ? -1n : 1n)).toString()}::bigint,${lot.rate_version},${now},${now},${lot.expires_at})`,
        );
      const id = randomUUID(),
        payload = {
          id,
          requestId: input.requestId,
          userId: lot.user_id,
          sourceLedgerId: ledgerId,
          points: points.toString(),
          proofId: input.proofId,
        };
      await tx.execute(
        sql`INSERT INTO reward_program_issues(id,request_id,fingerprint,allocation_id,user_id,kind,points,source_ref,payload,created_at) VALUES(${id},${input.requestId},${fingerprint},NULL,${lot.user_id},'legacy_clearance',${lot.delta_points},${source},${JSON.stringify(payload)}::jsonb,${now})`,
      );
      return payload;
    });
  }
  async list(actor: string) {
    return this.locked(async (tx) => {
      await this.financial.authorize(actor, tx);
      return {
        enabled: {
          funding: gate("funding"),
          paid: gate("paid"),
          conversion: gate("conversion"),
        },
        reconciliations: rows(
          await tx.execute(
            sql`SELECT r.id,r.kind,r.source_id,r.prepared_by,r.source_snapshot,r.expires_at,a.proof_id,a.approved_by FROM reward_reconciliation_reviews r LEFT JOIN reward_reconciliation_approvals a ON a.review_id=r.id ORDER BY r.created_at DESC LIMIT 100`,
          ),
        ),
        allocations: rows(
          await tx.execute(
            sql`SELECT * FROM reward_program_allocations ORDER BY created_at DESC LIMIT 100`,
          ),
        ),
        issues: rows(
          await tx.execute(
            sql`SELECT id,request_id,allocation_id,user_id,kind,points,micro_cfig::text,created_at FROM reward_program_issues ORDER BY created_at DESC LIMIT 100`,
          ),
        ),
      };
    });
  }
  private async reconciliationSource(
    tx: any,
    kind: string,
    sourceId: string,
    now: Date,
  ) {
    if (kind === "backing") {
      const [ledger] = rows(
        await tx.execute(
          sql`SELECT * FROM rewards_fund_ledger WHERE id=${sourceId} FOR SHARE`,
        ),
      );
      const fund = await this.fund(tx),
        settings = await this.settings(tx, now);
      reserveFloor(fund, settings);
      if (
        !ledger ||
        ledger.fund_id !== fund.id ||
        !["sweep_in", "adjust_in"].includes(ledger.type) ||
        ledger.to_bucket !== "available" ||
        !ledger.from_bucket?.startsWith("external") ||
        !ledger.source_ref ||
        BigInt(ledger.amount_cents) <= 0n
      )
        throw new ConflictException(
          "Actual inbound Rewards Fund ledger source required",
        );
      return {
        fundId: fund.id,
        amountCents: String(ledger.amount_cents),
        fundLedgerId: ledger.id,
        sourceRef: ledger.source_ref,
      };
    }
    if (kind === "clearance") {
      const [lot] = rows(
        await tx.execute(
          sql`SELECT * FROM rewards_points_ledger WHERE id=${sourceId} FOR SHARE`,
        ),
      );
      const settings = await this.settings(tx, now);
      if (
        !lot ||
        lot.state !== "pending" ||
        lot.delta_points <= 0 ||
        +now - +new Date(lot.earned_at) <
          settings.pending_hold_hours * 3600000 ||
        (lot.expires_at && new Date(lot.expires_at) <= now) ||
        !lot.source_ref
      )
        throw new ConflictException(
          "Auditable original pending lot beyond the hold required",
        );
      return {
        grantLedgerId: lot.id,
        userId: lot.user_id,
        points: String(lot.delta_points),
        sourceRef: lot.source_ref,
        outcome: "eligible",
      };
    }
    throw new BadRequestException("Unknown reconciliation kind");
  }
  async prepareReconciliation(actor: string, input: any) {
    this.id(input.requestId);
    this.id(input.sourceId);
    if (
      typeof input.reason !== "string" ||
      input.reason.trim().length < 3 ||
      input.reason.length > 500
    )
      throw new BadRequestException(
        "Independent evidence reference and reconciliation reason required",
      );
    const expires = new Date(input.expiresAt);
    if (!Number.isFinite(+expires))
      throw new BadRequestException("Explicit reconciliation expiry required");
    const fp = adDigest({
      actor,
      requestId: input.requestId,
      kind: input.kind,
      sourceId: input.sourceId,
      reason: input.reason,
      expiresAt: expires.toISOString(),
    });
    return this.locked(async (tx, now) => {
      await this.financial.authorize(actor, tx);
      this.enabled("funding");
      const [prior] = rows(
        await tx.execute(
          sql`SELECT * FROM reward_reconciliation_reviews WHERE request_id=${input.requestId}`,
        ),
      );
      if (prior) {
        if (prior.fingerprint !== fp)
          throw new ConflictException("Reconciliation identity changed");
        return prior;
      }
      if (expires <= now || +expires > +now + 30 * 86400000)
        throw new BadRequestException(
          "Reconciliation expiry must be within 30 days",
        );
      const snapshot = await this.reconciliationSource(
        tx,
        input.kind,
        input.sourceId,
        now,
      );
      if (snapshot.userId === actor)
        throw new ForbiddenException(
          "Beneficiaries cannot reconcile their own awards",
        );
      const id = randomUUID();
      await tx.execute(
        sql`INSERT INTO reward_reconciliation_reviews(id,request_id,fingerprint,kind,source_id,source_snapshot,source_hash,prepared_by,reason,expires_at,created_at) VALUES(${id},${input.requestId},${fp},${input.kind},${input.sourceId},${JSON.stringify(snapshot)}::jsonb,${adDigest(snapshot)},${actor},${input.reason},${expires},${now})`,
      );
      return { id, status: "awaiting_independent_reconciliation", snapshot };
    });
  }
  async approveReconciliation(actor: string, id: string, input: any) {
    this.id(id);
    this.id(input.requestId);
    return this.locked(async (tx, now) => {
      await this.financial.authorize(actor, tx);
      this.enabled("funding");
      const [review] = rows(
        await tx.execute(
          sql`SELECT * FROM reward_reconciliation_reviews WHERE id=${id} FOR SHARE`,
        ),
      );
      if (!review)
        throw new NotFoundException("Reconciliation review not found");
      if (review.prepared_by === actor)
        throw new ForbiddenException(
          "Independent reconciliation approver required",
        );
      const [prior] = rows(
        await tx.execute(
          sql`SELECT * FROM reward_reconciliation_approvals WHERE review_id=${id} OR request_id=${input.requestId}`,
        ),
      );
      if (prior) {
        if (
          prior.review_id !== id ||
          prior.request_id !== input.requestId ||
          prior.approved_by !== actor
        )
          throw new ConflictException(
            "Reconciliation approval identity changed",
          );
        return {
          id: prior.proof_id,
          reviewId: id,
          status: "reconciled_evidence",
          replayed: true,
        };
      }
      if (new Date(review.expires_at) <= now)
        throw new ConflictException("Reconciliation review expired");
      await this.financial.authorize(review.prepared_by, tx);
      const snapshot = await this.reconciliationSource(
        tx,
        review.kind,
        review.source_id,
        now,
      );
      if (
        adDigest(snapshot) !== review.source_hash ||
        snapshot.userId === actor
      )
        throw new ConflictException(
          "Original source changed or approver is a beneficiary",
        );
      const payload = {
          ...snapshot,
          reviewId: id,
          reviewers: [review.prepared_by, actor],
          reference: review.reason,
          expiresAt: new Date(review.expires_at).toISOString(),
        },
        keyId = process.env.ADS_EVIDENCE_HASH_KEY_ID || "evidence-v1",
        signature = evidenceSignature({ ...payload, keyId }),
        proofId = randomUUID();
      // Existing internal evidence convention; this is not a new PSP payment or a cash credit.
      await tx.execute(
        sql`INSERT INTO billing_provider_events(id,provider,reference,event_type,raw_payload,processed,processed_at) VALUES(${proofId},'paystack',${"internal.rewards.reconciliation:" + id},${review.kind === "backing" ? "rewards.backing.reconciled.v1" : "rewards.clearance.reconciled.v1"},${JSON.stringify({ payload, keyId, signature })}::jsonb,true,${now})`,
      );
      await tx.execute(
        sql`INSERT INTO reward_reconciliation_approvals(review_id,request_id,proof_id,approved_by,created_at) VALUES(${id},${input.requestId},${proofId},${actor},${now})`,
      );
      return {
        id: proofId,
        reviewId: id,
        status: "reconciled_evidence",
        cashCredited: "0",
      };
    });
  }
  async options(userId: string) {
    this.id(userId);
    const cohorts = rows(
      await this.db.execute(
        sql`SELECT a.id AS allocation_id,a.policy_snapshot,l.policy_id,sum(l.available_delta)::text AS available_micro_cfig FROM cfig_ledger l JOIN ads_promoters p ON p.id=l.promoter_id JOIN reward_program_allocations a ON a.policy_snapshot->>'housePolicyId'=l.policy_id::text AND a.program='house_conversion' AND a.approved_at IS NOT NULL WHERE p.user_id=${userId} AND p.is_active AND NOT p.is_suspended AND (a.policy_snapshot->>'effectiveFrom')::timestamptz<=clock_timestamp() GROUP BY a.id,l.policy_id HAVING sum(l.available_delta)>0`,
      ),
    );
    return {
      conversionEnabled: gate("conversion"),
      minimumPoints: fundedPolicy().conversionMinimumPoints,
      monthlyMaximumPoints: fundedPolicy().conversionMonthlyMaxPoints,
      cohorts: cohorts.map((c) => ({
        allocationId: c.allocation_id,
        policyId: c.policy_id,
        availableMicroCfig: c.available_micro_cfig,
        cfigPerPoint: c.policy_snapshot.cfigPerPoint,
        termsVersion: c.policy_snapshot.policyVersion,
      })),
      notice:
        "Eligibility and reconciled capacity are checked atomically at conversion; displayed totals are not a funding promise.",
    };
  }
  async receipt(userId: string, requestId: string) {
    this.id(userId);
    this.id(requestId);
    const [r] = rows(
      await this.db.execute(
        sql`SELECT payload FROM reward_program_issues WHERE user_id=${userId} AND request_id=${requestId}`,
      ),
    );
    if (!r) throw new NotFoundException("Reward receipt not found");
    return r.payload;
  }
  async recovery(actor: string, input: any) {
    this.id(input.requestId);
    this.id(input.issueId);
    this.id(input.evidenceId);
    if (
      typeof input.reason !== "string" ||
      input.reason.trim().length < 3 ||
      input.reason.length > 500
    )
      throw new BadRequestException("Recovery evidence reason required");
    return this.locked(async (tx) => {
      await this.financial.authorize(actor, tx);
      const fp = adDigest({ actor, ...input });
      const [prior] = rows(
        await tx.execute(
          sql`SELECT * FROM reward_recovery_cases WHERE request_id=${input.requestId}`,
        ),
      );
      if (prior) {
        if (prior.fingerprint !== fp)
          throw new ConflictException("Recovery identity changed");
        return prior;
      }
      const [issue] = rows(
        await tx.execute(
          sql`SELECT * FROM reward_program_issues WHERE id=${input.issueId}`,
        ),
      );
      const [evidence] = rows(
        await tx.execute(
          sql`SELECT * FROM ads_event_assessments WHERE id=${input.evidenceId}`,
        ),
      );
      if (!issue || !evidence || evidence.outcome !== "invalid")
        throw new ConflictException("Invalid source assessment required");
      const { recordHash, createdAt, ...signed } = camel(evidence);
      if (
        !validEvidenceSignature(signed, recordHash) ||
        !(
          issue.payload.sources?.some(
            (s: any) => s.eventId === evidence.event_id,
          ) || issue.payload.eventId === evidence.event_id
        )
      )
        throw new ConflictException(
          "Recovery does not bind original issued source",
        );
      const id = randomUUID();
      await tx.execute(
        sql`INSERT INTO reward_recovery_cases(id,request_id,fingerprint,issue_id,evidence_id,actor_id,reason) VALUES(${id},${input.requestId},${fp},${issue.id},${evidence.id},${actor},${input.reason})`,
      );
      return { id, status: "review_required", automaticCashDeduction: false };
    });
  }
}
