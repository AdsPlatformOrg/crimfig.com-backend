import {
  canonicalHousePolicy,
  houseProgramRequested,
  policyLimits,
  utcWindow,
  allocateDay,
  RewardCandidate,
} from "./cfig-allocation";
import { evidenceSignature } from "@crimfig/shared";
import {
  Inject,
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  adDigest,
  adEventJournalMatches,
  validEvidenceSignature,
} from "@crimfig/shared";
import {
  parsePolicy,
  units,
  transition,
  CFIG_SCALE,
  CFIG_HOLD_MS,
  CfigPolicy,
} from "./cfig-policy";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const rows = (result: any): any[] => result.rows ?? result;
const serveObservation = (s: any) => ({
  id: s.id,
  servedAt: new Date(s.served_at).toISOString(),
  requestId: s.request_id,
  promoterId: s.promoter_id,
  websiteId: s.website_id,
  slotId: s.slot_id,
  inventoryClass: s.inventory_class,
  deliveryMode: s.delivery_mode,
  billingPrice: String(s.billing_price_nanos),
  contentSnapshot: s.content_snapshot,
});
@Injectable()
export class CfigService {
  constructor(@Inject("DATABASE_CONNECTION") private readonly db: any) {}
  private async locked<T>(
    key: string,
    fn: (tx: any) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx: any) => {
      await tx.execute(sql`set local lock_timeout='5s'`);
      await tx.execute(sql`set local statement_timeout='8s'`);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`cfig:${key}`},0))`,
      );
      return fn(tx);
    });
  }
  private id(value: string) {
    if (!uuid.test(value ?? "")) throw new BadRequestException("UUID required");
  }
  private request(input: any) {
    this.id(input.requestId);
    if (
      typeof input.reason !== "string" ||
      input.reason.trim().length < 3 ||
      input.reason.length > 500
    )
      throw new BadRequestException(
        "A reason of 3 to 500 characters is required",
      );
  }
  status() {
    return {
      currency: "CFIG",
      scale: CFIG_SCALE.toString(),
      earningEnabled: houseProgramRequested(),
      housePolicy: canonicalHousePolicy(),
      finalizationHours: 72,
      conversionEnabled: false,
      conversionReason:
        "Conversion requires separately approved terms, reconciled funding and launch authorization.",
      clearanceHours: 72,
    };
  }
  async owner(userId: string) {
    const [p] = rows(
      await this.db.execute(
        sql`SELECT id FROM ads_promoters WHERE user_id=${userId} AND is_active=true`,
      ),
    );
    if (!p) throw new NotFoundException("Active promoter account required");
    return p.id as string;
  }
  async balances(promoterId?: string) {
    const [balance] = rows(
      await this.db.execute(
        sql`SELECT coalesce(sum(pending_delta),0)::text AS pending,coalesce(sum(available_delta),0)::text AS available,coalesce(sum(invalid_delta),0)::text AS invalid FROM cfig_ledger WHERE (${promoterId ?? null}::uuid IS NULL OR promoter_id=${promoterId ?? null}::uuid)`,
      ),
    );
    return {
      ...this.status(),
      balances: { ...balance, converted: "0" },
      units: "micro-cfig",
      backedValue: null,
    };
  }
  async history(promoterId: string | undefined, page: number) {
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000)
      throw new BadRequestException("Invalid page");
    const data = rows(
      await this.db.execute(
        sql`SELECT id,event_id,promoter_id,policy_id,kind,pending_delta::text,available_delta::text,invalid_delta::text,reason,created_at FROM cfig_ledger WHERE (${promoterId ?? null}::uuid IS NULL OR promoter_id=${promoterId ?? null}::uuid) ORDER BY created_at DESC,id DESC LIMIT 26 OFFSET ${(page - 1) * 25}`,
      ),
    );
    return { items: data.slice(0, 25), page, hasNext: data.length > 25 };
  }
  async policies() {
    return rows(
      await this.db.execute(
        sql`SELECT * FROM cfig_policies ORDER BY created_at DESC LIMIT 100`,
      ),
    );
  }
  async propose(actor: string, input: any) {
    this.request(input);
    if (
      input.terms?.qualifyingSupply &&
      input.terms.qualifyingSupply !== "approved_only"
    )
      throw new BadRequestException("TESTING has zero monetary eligibility");
    if (input.terms?.unitsPerView || input.terms?.dailyCapUnits)
      throw new BadRequestException(
        "Use canonical versioned financial configuration, not per-request rates",
      );
    const terms = parsePolicy({
      ...input.terms,
      houseRewards: canonicalHousePolicy(),
    });
    const fingerprint = adDigest({ actor, terms, reason: input.reason });
    return this.locked(`policy-proposal`, async (tx) => {
      const [prior] = rows(
        await tx.execute(
          sql`SELECT * FROM cfig_policies WHERE request_id=${input.requestId}`,
        ),
      );
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new ConflictException("Policy request identity changed");
        return prior;
      }
      const existingVersion = rows(
        await tx.execute(
          sql`SELECT id FROM cfig_policies WHERE terms->>'version'=${terms.version}`,
        ),
      );
      if (existingVersion.length)
        throw new ConflictException(
          "Policy version already exists; update canonical version prospectively",
        );
      if (Date.parse(terms.effectiveFrom) < Date.now())
        throw new BadRequestException(
          "Policy effective date must be future; no retroactive rewards",
        );
      const [result] = rows(
        await tx.execute(
          sql`INSERT INTO cfig_policies(request_id,fingerprint,terms,created_by) VALUES(${input.requestId},${fingerprint},${JSON.stringify({ ...terms, proposalReason: input.reason })}::jsonb,${actor}) RETURNING *`,
        ),
      );
      return result;
    });
  }
  async approve(actor: string, id: string, input: any) {
    this.id(id);
    this.request(input);
    return this.locked(`policy:${id}`, async (tx) => {
      const [p] = rows(
        await tx.execute(
          sql`SELECT * FROM cfig_policies WHERE id=${id} FOR UPDATE`,
        ),
      );
      if (!p) throw new NotFoundException("Policy not found");
      if (p.created_by === actor)
        throw new ForbiddenException("Independent policy approver required");
      if (p.approved_at) {
        if (
          p.approved_by !== actor ||
          p.approval_request_id !== input.requestId ||
          p.approval_reason !== input.reason
        )
          throw new ConflictException("Approval identity changed");
        return p;
      }
      if (Date.parse(p.terms.effectiveFrom) <= Date.now())
        throw new ConflictException(
          "Expired approval window; propose future terms",
        );
      const [result] = rows(
        await tx.execute(
          sql`UPDATE cfig_policies SET approved_by=${actor},approved_at=now(),approval_request_id=${input.requestId},approval_reason=${input.reason} WHERE id=${id} RETURNING *`,
        ),
      );
      return result;
    });
  }
  async reviews(page: number) {
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000)
      throw new BadRequestException("Invalid page");
    const data = rows(
      await this.db.execute(
        sql`SELECT e.id AS event_id,e.type,e.promoter_id,e.created_at,e.visible_ratio,e.duration_ms,e.slot_instance_id,v.served_at,v.content_snapshot->'houseRewardContext'->>'websitePolicy' AS website_policy_at_serve,l.kind AS latest_decision,r.outcome AS eligibility_review,a.outcome AS allocation_outcome,CASE WHEN a.event_id IS NOT NULL THEN a.outcome WHEN f.day IS NOT NULL AND e.created_at>=(f.day::timestamp AT TIME ZONE 'UTC')+interval '4 days' THEN 'LATE_EXCLUDED' WHEN f.day IS NOT NULL THEN 'VALIDATION_INCOMPLETE' ELSE 'AWAITING_FINALIZATION' END AS finalization_state FROM ads_interactions e JOIN ads_serves v ON v.id=e.serve_id LEFT JOIN LATERAL(SELECT kind FROM cfig_ledger WHERE event_id=e.id ORDER BY created_at DESC,id DESC LIMIT 1)l ON true LEFT JOIN LATERAL(SELECT outcome FROM cfig_event_reviews WHERE event_id=e.id ORDER BY created_at DESC,id DESC LIMIT 1)r ON true LEFT JOIN cfig_allocations a ON a.event_id=e.id LEFT JOIN cfig_finalizations f ON f.day=(v.served_at AT TIME ZONE 'UTC')::date WHERE e.type IN('viewable_impression','click') AND v.inventory_class='house' AND v.delivery_mode<>'shadow' ORDER BY v.served_at DESC,v.id DESC,e.id DESC LIMIT 26 OFFSET ${(page - 1) * 25}`,
      ),
    );
    return { items: data.slice(0, 25), page, hasNext: data.length > 25 };
  }
  async reviewDetail(eventId: string) {
    this.id(eventId);
    return this.locked(`review:${eventId}`, async (tx) => {
      const [item] = rows(
        await tx.execute(
          sql`SELECT e.id,e.type,e.serve_id,e.promoter_id,e.website_id,e.slot_id,e.created_at,e.visible_ratio,e.duration_ms,e.page_view_id,e.slot_instance_id,e.opportunity_id,e.sdk_init_id,e.assessment_status,v.content_snapshot->'houseRewardContext' AS reward_context,v.inventory_class,v.delivery_mode,v.house_creative_id FROM ads_interactions e JOIN ads_serves v ON v.id=e.serve_id WHERE e.id=${eventId}`,
        ),
      );
      if (!item) throw new NotFoundException("Review candidate not found");
      let eligible = false,
        reason = "Evidence checks unavailable";
      try {
        await this.proof(tx, eventId);
        eligible = true;
        reason =
          "Signed evidence and active supply checks passed; this does not prove human attention or grant a reward.";
      } catch (error) {
        if (
          error instanceof ConflictException ||
          error instanceof NotFoundException
        )
          reason = error.message;
        else throw error;
      }
      const movements = rows(
        await tx.execute(
          sql`SELECT id,kind,actor_id,reason,pending_delta::text,available_delta::text,invalid_delta::text,created_at FROM cfig_ledger WHERE event_id=${eventId} ORDER BY created_at,id`,
        ),
      );
      const reviews = rows(
        await tx.execute(
          sql`SELECT id,outcome,actor_id,reason,created_at FROM cfig_event_reviews WHERE event_id=${eventId} ORDER BY created_at DESC,id DESC`,
        ),
      );
      return {
        item,
        evidenceChecksPassed: eligible,
        reason,
        movements,
        reviews,
      };
    });
  }
  private async proof(tx: any, eventId: string) {
    const [event] = rows(
      await tx.execute(
        sql`SELECT * FROM ads_interactions WHERE id=${eventId} FOR SHARE`,
      ),
    );
    if (!event) throw new NotFoundException("Event not found");
    const [serve] = rows(
      await tx.execute(
        sql`SELECT * FROM ads_serves WHERE id=${event.serve_id} FOR SHARE`,
      ),
    );
    if (
      !serve ||
      serve.inventory_class !== "house" ||
      serve.delivery_mode === "shadow" ||
      BigInt(serve.billing_price_nanos ?? 0) !== 0n ||
      !["viewable_impression", "click"].includes(event.type) ||
      event.promoter_id !== serve.promoter_id ||
      event.website_id !== serve.website_id ||
      event.slot_id !== serve.slot_id
    )
      throw new ConflictException(
        "Only bound zero-charge House event evidence qualifies",
      );
    if (
      (event.type === "viewable_impression" &&
        (!event.page_view_id ||
          !event.slot_instance_id ||
          !event.opportunity_id ||
          !event.sdk_init_id)) ||
      (event.type === "viewable_impression" &&
        (Number(event.visible_ratio) < 0.5 ||
          !Number.isFinite(Number(event.visible_ratio)) ||
          !Number.isSafeInteger(Number(event.duration_ms)) ||
          Number(event.duration_ms) <
            (serve.content_snapshot?.adType === "video" ? 2000 : 1000) ||
          Number(event.duration_ms) > 900000)) ||
      ["invalidated", "suspicious"].includes(event.assessment_status)
    )
      throw new ConflictException(
        "Missing or rejected independent instance measurement",
      );
    const [journal] = rows(
      await tx.execute(
        sql`SELECT * FROM ads_evidence_records WHERE event_id=${eventId}`,
      ),
    );
    const projection = Object.fromEntries(
      Object.entries(event).map(([k, v]) => [
        k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
        v,
      ]),
    );
    const j = journal && {
      eventId: journal.event_id,
      partition: journal.partition,
      previousHash: journal.previous_hash,
      payload: journal.payload,
      keyId: journal.key_id,
    };
    if (
      !journal?.payload?.instanceClaims ||
      !adEventJournalMatches(projection, {
        eventId: journal.event_id,
        payload: journal.payload,
      }) ||
      !validEvidenceSignature(j, journal.record_hash)
    )
      throw new ConflictException("Signed original evidence unavailable");
    const [assessment] = rows(
      await tx.execute(
        sql`SELECT * FROM ads_event_assessments WHERE event_id=${eventId} ORDER BY created_at DESC,id DESC LIMIT 1`,
      ),
    );
    if (assessment) {
      const a: any = Object.fromEntries(
        Object.entries(assessment).map(([k, v]) => [
          k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
          v,
        ]),
      );
      const { recordHash, createdAt, ...signed } = a;
      if (
        a.outcome !== "eligible" ||
        !validEvidenceSignature(signed, recordHash)
      )
        throw new ConflictException(
          "Traffic assessment does not permit rewards",
        );
    }
    const [supply] = rows(
      await tx.execute(
        sql`SELECT p.user_id,p.is_suspended AS promoter_suspended,w.is_suspended AS website_suspended,p.is_active AS promoter_active,w.verification_status,w.verification_expires_at,w.policy_status,w.is_active AS website_active,s.is_active AS slot_active,s.lifecycle_status,(u.status='ACTIVE') AS user_active FROM ads_promoters p JOIN users u ON u.id=p.user_id JOIN ads_promoter_websites w ON w.promoter_id=p.id AND w.id=${event.website_id} JOIN adstation_slots s ON s.website_id=w.id AND s.id=${event.slot_id} WHERE p.id=${event.promoter_id} FOR SHARE OF p,u,w,s`,
      ),
    );
    if (
      !supply?.promoter_active ||
      supply.promoter_suspended ||
      supply.website_suspended ||
      supply.policy_status !== "approved" ||
      !supply.user_active ||
      !supply.website_active ||
      !supply.slot_active ||
      ["paused", "suspended", "disabled", "draft"].includes(
        supply.lifecycle_status,
      ) ||
      supply.verification_status !== "verified" ||
      !supply.verification_expires_at ||
      new Date(supply.verification_expires_at) <= new Date()
    )
      throw new ConflictException(
        "Supply is not currently verified and active",
      );
    const controls = rows(
      await tx.execute(
        sql`SELECT id FROM ads_traffic_controls WHERE is_active=true AND (expires_at IS NULL OR expires_at>now()) AND ((target_scope='slot' AND target_id=${event.slot_id}) OR (target_scope='website' AND target_id=${event.website_id}) OR (target_scope='promoter' AND target_id=${event.promoter_id})) LIMIT 1`,
      ),
    );
    if (controls.length)
      throw new ConflictException("Supply is under traffic review");
    const context = serve.content_snapshot?.houseRewardContext;
    if (
      !context ||
      context.websitePolicy !== "approved" ||
      context.ownershipStatus !== "verified" ||
      !context.programAuthorized ||
      !context.policyId ||
      new Date(context.ownershipExpiresAt) <= new Date(serve.served_at)
    )
      throw new ConflictException(
        "Approved ownership/policy evidence at serve time required; TESTING earns zero",
      );
    const [policy] = rows(
      await tx.execute(
        sql`SELECT * FROM cfig_policies WHERE id=${context.policyId}`,
      ),
    );
    if (
      !policy?.approved_at ||
      new Date(policy.approved_at) > new Date(serve.served_at) ||
      adDigest(policy.terms) !== context.policyDigest ||
      new Date(policy.terms.effectiveFrom) > new Date(serve.served_at)
    )
      throw new ConflictException(
        "Original approved reward policy unavailable",
      );
    parsePolicy(policy.terms);
    const [issued] = rows(
      await tx.execute(
        sql`SELECT * FROM ads_evidence_records WHERE event_id=${serve.request_id}`,
      ),
    );
    const issueEnvelope = issued && {
      eventId: issued.event_id,
      partition: issued.partition,
      previousHash: issued.previous_hash,
      payload: issued.payload,
      keyId: issued.key_id,
    };
    if (
      !issued ||
      issued.payload?.serveId !== serve.id ||
      issued.payload.serverServedAt !==
        new Date(serve.served_at).toISOString() ||
      adDigest(issued.payload.houseRewardContext) !== adDigest(context) ||
      !validEvidenceSignature(issueEnvelope, issued.record_hash)
    )
      throw new ConflictException(
        "Signed issuance status snapshot unavailable",
      );
    if (event.type === "click") {
      if (
        event.actor_ip &&
        serve.ip_hash &&
        serve.ip_hash !==
          require("crypto")
            .createHash("sha256")
            .update(event.actor_ip)
            .digest("hex")
            .slice(0, 16)
      )
        throw new ConflictException("Click IP binding mismatch");
      if (
        new Date(event.created_at) < new Date(serve.served_at) ||
        +new Date(event.created_at) >
          new Date(serve.served_at).getTime() + 15 * 60000
      )
        throw new ConflictException("Click is outside issued event window");
      // Human review must attest self-click/IVT checks; browser interaction is not proof.
    }
    return { event, serve, supply, policy };
  }
  async decide(actor: string, eventId: string, input: any) {
    this.id(eventId);
    this.request(input);
    if (!["accrue", "reject", "clear", "invalidate"].includes(input.action))
      throw new BadRequestException("Invalid reward decision");
    const fingerprint = adDigest({
      actor,
      eventId,
      requestId: input.requestId,
      action: input.action,
      reason: input.reason,
      clickAudit: input.clickAudit ?? null,
    });
    return this.locked("global-allocation", async (tx) => {
      if (input.action === "accrue" || input.action === "reject") {
        if (input.action === "accrue" && !houseProgramRequested())
          throw new ServiceUnavailableException(
            "Virtual earning disabled pending separate activation approval",
          );
        const [prior] = rows(
          await tx.execute(
            sql`SELECT * FROM cfig_event_reviews WHERE request_id=${input.requestId}`,
          ),
        );
        if (prior) {
          if (prior.fingerprint !== fingerprint)
            throw new ConflictException("Decision identity changed");
          return prior;
        }
        let verified: any;
        if (input.action === "reject") {
          const [event] = rows(
            await tx.execute(
              sql`SELECT * FROM ads_interactions WHERE id=${eventId}`,
            ),
          );
          if (!event) throw new NotFoundException("Event not found");
          const [serve] = rows(
            await tx.execute(
              sql`SELECT * FROM ads_serves WHERE id=${event.serve_id}`,
            ),
          );
          if (!serve || serve.inventory_class !== "house")
            throw new ConflictException("House source required");
          const [owner] = rows(
            await tx.execute(
              sql`SELECT user_id FROM ads_promoters WHERE id=${event.promoter_id}`,
            ),
          );
          verified = {
            event,
            serve,
            supply: owner,
            policy: {
              id: serve.content_snapshot?.houseRewardContext?.policyId ?? null,
            },
          };
        } else verified = await this.proof(tx, eventId);
        const { event, serve, supply, policy } = verified;
        if (supply.user_id === actor)
          throw new ForbiddenException("Cannot review your own exposure");
        if (
          input.action === "accrue" &&
          event.type === "click" &&
          input.clickAudit !== true
        )
          throw new BadRequestException(
            "Explicit independent self-click and IVT audit required",
          );
        const [clock] = rows(
          await tx.execute(sql`SELECT clock_timestamp() AS now`),
        );
        const validatedAt = new Date(clock.now),
          id = randomUUID(),
          keyId = process.env.ADS_EVIDENCE_HASH_KEY_ID || "evidence-v1";
        const outcome = input.action === "reject" ? "invalid" : "eligible";
        const payload = {
          id,
          eventId,
          actor,
          outcome,
          reason: input.reason,
          validatedAt: validatedAt.toISOString(),
          servedAt: new Date(serve.served_at).toISOString(),
          eventDigest: adDigest(event),
          serveDigest: adDigest(serveObservation(serve)),
          policyId: policy.id,
          clickAudit: event.type === "click" ? true : null,
        };
        const hash = evidenceSignature({ ...payload, keyId });
        await tx.execute(
          sql`INSERT INTO cfig_event_reviews(id,event_id,request_id,fingerprint,outcome,actor_id,reason,payload,key_id,record_hash,created_at) VALUES(${id},${eventId},${input.requestId},${fingerprint},${outcome},${actor},${input.reason},${JSON.stringify(payload)}::jsonb,${keyId},${hash},${validatedAt})`,
        );
        return { id, outcome, status: "reviewed_not_allocated", validatedAt };
      }
      const [prior] = rows(
        await tx.execute(
          sql`SELECT * FROM cfig_ledger WHERE request_id=${input.requestId}`,
        ),
      );
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new ConflictException("Decision identity changed");
        return prior;
      }
      const entries = rows(
        await tx.execute(
          sql`SELECT * FROM cfig_ledger WHERE event_id=${eventId} ORDER BY created_at,id`,
        ),
      );
      const grant = entries.find((e) => e.kind === "accrue");
      if (!grant) throw new ConflictException("No finalized reward allocation");
      if (entries.some((e) => e.kind === input.action))
        throw new ConflictException("Decision already recorded");
      const [allocation] = rows(
        await tx.execute(
          sql`SELECT a.*,f.created_at AS finalized_at FROM cfig_allocations a JOIN cfig_finalizations f ON f.day=a.day WHERE a.event_id=${eventId}`,
        ),
      );
      if (
        !allocation ||
        BigInt(allocation.allocated) !== BigInt(grant.pending_delta)
      )
        throw new ConflictException("Finalized allocation does not reconcile");
      let holdMs = CFIG_HOLD_MS;
      if (input.action === "clear") {
        const { supply, policy } = await this.proof(tx, eventId);
        holdMs = policy.terms.houseRewards.pendingHoldHours * 3600000;
        if (supply.user_id === actor || grant.actor_id === actor)
          throw new ForbiddenException(
            "Independent clearance reviewer required",
          );
        const [review] = rows(
          await tx.execute(
            sql`SELECT actor_id,outcome FROM cfig_event_reviews WHERE event_id=${eventId} ORDER BY created_at DESC,id DESC LIMIT 1`,
          ),
        );
        if (
          !review ||
          review.outcome !== "eligible" ||
          review.actor_id === actor
        )
          throw new ForbiddenException(
            "Independent eligibility and clearance reviewers required",
          );
      }
      const pending = entries.reduce((a, e) => a + BigInt(e.pending_delta), 0n),
        available = entries.reduce((a, e) => a + BigInt(e.available_delta), 0n);
      // Hold starts at original server event, not a second 72-hour delay after finalization.
      const [original] = rows(
        await tx.execute(
          sql`SELECT created_at FROM ads_interactions WHERE id=${eventId}`,
        ),
      );
      if (!original)
        throw new ConflictException("Original evidence unavailable");
      const delta = transition(
        input.action,
        pending,
        available,
        new Date(original.created_at),
        new Date(),
        true,
        holdMs,
      );
      const id = randomUUID();
      await tx.execute(
        sql`INSERT INTO cfig_ledger(id,request_id,fingerprint,event_id,promoter_id,policy_id,kind,pending_delta,available_delta,invalid_delta,actor_id,reason,created_at) VALUES(${id},${input.requestId},${fingerprint},${eventId},${grant.promoter_id},${grant.policy_id},${input.action},${delta.pending.toString()}::bigint,${delta.available.toString()}::bigint,${delta.invalid.toString()}::bigint,${actor},${input.reason},clock_timestamp())`,
      );
      return { id, kind: input.action };
    });
  }
  async nextDay() {
    const [first] = rows(
      await this.db.execute(
        sql`SELECT min((terms->>'effectiveFrom')::timestamptz) AS starts FROM cfig_policies WHERE approved_at IS NOT NULL`,
      ),
    );
    if (!first?.starts) return null;
    const [last] = rows(
      await this.db.execute(
        sql`SELECT day::text FROM cfig_finalizations ORDER BY day DESC LIMIT 1`,
      ),
    );
    return last
      ? new Date(+new Date(last.day + "T00:00:00Z") + 86400000)
          .toISOString()
          .slice(0, 10)
      : new Date(first.starts).toISOString().slice(0, 10);
  }
  async finalize(actor: string, day: string, input: any) {
    this.request(input);
    let window: ReturnType<typeof utcWindow>;
    try {
      window = utcWindow(day);
    } catch {
      throw new BadRequestException("Valid UTC serve date required");
    }
    const fingerprint = adDigest({
      actor,
      day,
      requestId: input.requestId,
      reason: input.reason,
    });
    return this.locked("global-allocation", async (tx) => {
      const [byRequest] = rows(
        await tx.execute(
          sql`SELECT * FROM cfig_finalizations WHERE request_id=${input.requestId}`,
        ),
      );
      if (byRequest) {
        if (byRequest.fingerprint !== fingerprint)
          throw new ConflictException("Finalization request identity changed");
        return byRequest.snapshot;
      }
      const [closed] = rows(
        await tx.execute(
          sql`SELECT * FROM cfig_finalizations WHERE day=${day}::date`,
        ),
      );
      if (closed)
        throw new ConflictException(
          "UTC day already finalized; it cannot be reopened",
        );
      if (!houseProgramRequested())
        throw new ServiceUnavailableException(
          "Finalization disabled pending explicit activation",
        );
      const [clock] = rows(
        await tx.execute(sql`SELECT clock_timestamp() AS now`),
      );
      if (new Date(clock.now) < window.cutoff)
        throw new ConflictException(
          "Receipt and validation window is still open",
        );
      const [first] = rows(
        await tx.execute(
          sql`SELECT min((terms->>'effectiveFrom')::timestamptz) AS starts FROM cfig_policies WHERE approved_at IS NOT NULL`,
        ),
      );
      if (!first?.starts)
        throw new ConflictException("Approved activation policy required");
      const [latest] = rows(
        await tx.execute(
          sql`SELECT day::text FROM cfig_finalizations ORDER BY day DESC LIMIT 1`,
        ),
      );
      const expected = latest
        ? new Date(new Date(latest.day + "T00:00:00Z").getTime() + 86400000)
            .toISOString()
            .slice(0, 10)
        : new Date(first.starts).toISOString().slice(0, 10);
      if (day !== expected)
        throw new ConflictException(
          "Finalize the earliest unclosed UTC day first: " + expected,
        );
      const [p] = rows(
        await tx.execute(
          sql`SELECT * FROM cfig_policies WHERE approved_at IS NOT NULL AND (terms->>'effectiveFrom')::timestamptz<=${window.start} ORDER BY (terms->>'effectiveFrom')::timestamptz DESC,id DESC LIMIT 1`,
        ),
      );
      if (!p)
        throw new ConflictException("No effective policy for this UTC day");
      const terms = parsePolicy(p.terms),
        month = day.slice(0, 7);
      const [budget] = rows(
        await tx.execute(
          sql`SELECT * FROM cfig_period_budgets WHERE month=${month}`,
        ),
      );
      const monthPolicy = budget ? budget.snapshot : terms.houseRewards;
      if (budget && adDigest(budget.snapshot) !== budget.snapshot_hash)
        throw new ConflictException("Monthly budget snapshot integrity failed");
      const policy = {
        ...terms.houseRewards,
        monthlyBudgetUsdCents: monthPolicy.monthlyBudgetUsdCents,
      };
      const priorRows = rows(
        await tx.execute(
          sql`SELECT promoter_id,sum(allocated)::text AS used FROM cfig_allocations WHERE day>=${month + "-01"}::date AND day<${day}::date GROUP BY promoter_id`,
        ),
      );
      const priorPromoters = new Map<string, bigint>(
        priorRows.map((r) => [r.promoter_id, BigInt(r.used)]),
      );
      const [outstanding] = rows(
        await tx.execute(
          sql`SELECT (coalesce((SELECT sum(allocated) FROM cfig_allocations WHERE day<${day}::date),0)+coalesce((SELECT sum(l.pending_delta+l.available_delta) FROM cfig_ledger l WHERE l.kind='invalidate' AND (l.created_at AT TIME ZONE 'UTC')::date<=${day}::date AND EXISTS(SELECT 1 FROM cfig_allocations a WHERE a.event_id=l.event_id)),0)+coalesce((SELECT sum(l.pending_delta+l.available_delta) FROM cfig_ledger l WHERE NOT EXISTS(SELECT 1 FROM cfig_allocations a WHERE a.event_id=l.event_id)),0))::text AS units`,
        ),
      );
      // Frozen day snapshot: original receipt and signed eligibility must precede cutoff.
      const source = rows(
        await tx.execute(
          sql`SELECT e.*,v.served_at,row_to_json(v) AS serve_record,v.id AS original_serve_id,v.content_snapshot,v.promoter_id AS serve_promoter_id,to_char(v.served_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ordered_serve_time,r.id AS review_id,r.outcome AS review_outcome,r.actor_id AS review_actor,r.payload AS review_payload,r.key_id AS review_key,r.record_hash AS review_hash,r.created_at AS validated_at,row_to_json(fraud) AS final_assessment FROM ads_interactions e JOIN ads_serves v ON v.id=e.serve_id LEFT JOIN LATERAL(SELECT * FROM cfig_event_reviews WHERE event_id=e.id AND created_at<${window.cutoff} ORDER BY created_at DESC,id DESC LIMIT 1)r ON true LEFT JOIN LATERAL(SELECT * FROM ads_event_assessments WHERE event_id=e.id AND created_at<${window.cutoff} ORDER BY created_at DESC,id DESC LIMIT 1)fraud ON true WHERE v.served_at>=${window.start} AND v.served_at<${window.end} AND v.inventory_class='house' AND v.delivery_mode<>'shadow' AND e.type IN ('viewable_impression','click') ORDER BY v.served_at,v.id,e.id LIMIT ${terms.houseRewards.maxCandidatesPerDay + 1}`,
        ),
      );
      if (source.length > terms.houseRewards.maxCandidatesPerDay)
        throw new ServiceUnavailableException(
          "Day exceeds transactional candidate capacity; no prefix allocation was performed",
        );
      const candidates: RewardCandidate[] = source.map((row) => {
        const context = row.content_snapshot?.houseRewardContext;
        let exclusion: string | undefined;
        if (!context) exclusion = "HISTORICAL_STATUS_UNKNOWN";
        else if (context.websitePolicy === "testing")
          exclusion = "TESTING_EXCLUDED";
        else if (context.websitePolicy !== "approved")
          exclusion = "WEBSITE_NOT_APPROVED";
        else if (
          !context.programAuthorized ||
          context.policyId !== p.id ||
          context.policyDigest !== adDigest(p.terms)
        )
          exclusion = "POLICY_INACTIVE";
        let eligible = false;
        if (!exclusion && row.review_id) {
          const payload = row.review_payload;
          if (
            !payload ||
            payload.id !== row.review_id ||
            payload.eventId !== row.id ||
            payload.actor !== row.review_actor ||
            payload.validatedAt !== new Date(row.validated_at).toISOString() ||
            payload.outcome !== row.review_outcome ||
            !validEvidenceSignature(
              { ...payload, keyId: row.review_key },
              row.review_hash,
            )
          )
            throw new ConflictException(
              "Eligibility review signature/binding failed",
            );
          const projection = { ...row };
          for (const key of [
            "served_at",
            "serve_record",
            "original_serve_id",
            "content_snapshot",
            "serve_promoter_id",
            "ordered_serve_time",
            "review_id",
            "review_outcome",
            "review_actor",
            "review_payload",
            "review_key",
            "review_hash",
            "validated_at",
            "final_assessment",
          ])
            delete projection[key];
          if (
            payload.eventDigest !== adDigest(projection) ||
            payload.serveDigest !==
              adDigest(serveObservation(row.serve_record)) ||
            payload.servedAt?.replace(/Z$/, "000Z") !==
              row.ordered_serve_time ||
            payload.policyId !== p.id
          )
            throw new ConflictException(
              "Reviewed event changed after validation",
            );
          eligible = row.review_outcome === "eligible";
          if (!eligible) exclusion = "REJECTED_BY_REVIEW";
        }
        if (row.final_assessment) {
          const converted: any = Object.fromEntries(
            Object.entries(row.final_assessment).map(([k, v]) => [
              k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
              v,
            ]),
          );
          const { recordHash, createdAt, ...signed } = converted;
          if (
            converted.eventId !== row.id ||
            !validEvidenceSignature(signed, recordHash)
          )
            throw new ConflictException(
              "Final fraud assessment integrity failed",
            );
          if (converted.outcome !== "eligible") {
            eligible = false;
            exclusion = "INVALID_TRAFFIC_AS_OF_CUTOFF";
          }
        }
        return {
          eventId: row.id,
          serveId: row.serve_id,
          promoterId: row.promoter_id,
          servedAt: row.ordered_serve_time,
          receivedAt: new Date(row.created_at),
          validatedAt: row.validated_at ? new Date(row.validated_at) : null,
          metric: row.type,
          eligible,
          exclusion,
          policyId: p.id,
        };
      });
      const result = allocateDay(
        day,
        candidates,
        policy,
        {
          promoters: priorPromoters,
          global: priorRows.reduce((a, r) => a + BigInt(r.used), 0n),
          outstanding: BigInt(outstanding.units),
        },
        new Date(clock.now),
      );
      const snapshot = {
        day,
        cutoff: window.cutoff.toISOString(),
        policyId: p.id,
        policy: terms,
        monthlyBudget: monthPolicy,
        candidatesHash: adDigest(candidates),
        candidateCount: candidates.length,
        allocated: result.allocations
          .reduce((a, r) => a + r.allocated, 0n)
          .toString(),
        globalMonthAfter: result.global.toString(),
        outstandingAfter: result.outstanding.toString(),
        priorOutstanding: outstanding.units,
        allocationHash: adDigest(result.allocations),
        actor,
        reason: input.reason,
      };
      if (!budget)
        await tx.execute(
          sql`INSERT INTO cfig_period_budgets(month,policy_id,snapshot,snapshot_hash) VALUES(${month},${p.id},${JSON.stringify(terms.houseRewards)}::jsonb,${adDigest(terms.houseRewards)})`,
        );
      await tx.execute(
        sql`INSERT INTO cfig_finalizations(day,request_id,fingerprint,actor_id,reason,snapshot,snapshot_hash) VALUES(${day}::date,${input.requestId},${fingerprint},${actor},${input.reason},${JSON.stringify(snapshot)}::jsonb,${adDigest(snapshot)})`,
      );
      const sourceById = new Map(source.map((row) => [row.id, row]));
      // Bounded bulk writes avoid one network round trip per event; publication
      // remains one transaction even when the deterministic snapshot is large.
      for (let offset = 0; offset < result.allocations.length; offset += 1000) {
        const batch = result.allocations.slice(offset, offset + 1000);
        const records = batch.map((a) => {
          const c = a.candidate,
            row = sourceById.get(c.eventId)!;
          return {
            event_id: c.eventId,
            day,
            serve_id: c.serveId,
            promoter_id: c.promoterId,
            policy_id: p.id,
            metric: c.metric,
            outcome: a.outcome,
            entitled: a.entitled.toString(),
            allocated: a.allocated.toString(),
            badge_eligible: a.badgeEligible,
            source_key: "event:" + c.eventId,
            review_id: row.review_id ?? null,
            source_snapshot: {
              ...c,
              reviewId: row.review_id,
              reviewHash: row.review_hash,
              rewardContext: row.content_snapshot?.houseRewardContext ?? null,
            },
          };
        });
        await tx.execute(
          sql`INSERT INTO cfig_allocations(event_id,day,serve_id,promoter_id,policy_id,metric,outcome,entitled,allocated,badge_eligible,source_key,review_id,source_snapshot) SELECT event_id,day,serve_id,promoter_id,policy_id,metric,outcome,entitled,allocated,badge_eligible,source_key,review_id,source_snapshot FROM jsonb_to_recordset(${JSON.stringify(records)}::jsonb) AS v(event_id uuid,day date,serve_id uuid,promoter_id uuid,policy_id uuid,metric text,outcome text,entitled bigint,allocated bigint,badge_eligible boolean,source_key text,review_id uuid,source_snapshot jsonb)`,
        );
        const grants = batch
          .filter((a) => a.allocated > 0n)
          .map((a) => ({
            id: randomUUID(),
            request_id: randomUUID(),
            fingerprint: adDigest({
              day,
              event: a.candidate.eventId,
              units: a.allocated.toString(),
            }),
            event_id: a.candidate.eventId,
            promoter_id: a.candidate.promoterId,
            policy_id: p.id,
            kind: "accrue",
            pending_delta: a.allocated.toString(),
            available_delta: "0",
            invalid_delta: "0",
            actor_id: actor,
            reason: "Finalized chronological allocation",
          }));
        if (grants.length)
          await tx.execute(
            sql`INSERT INTO cfig_ledger(id,request_id,fingerprint,event_id,promoter_id,policy_id,kind,pending_delta,available_delta,invalid_delta,actor_id,reason) SELECT id,request_id,fingerprint,event_id,promoter_id,policy_id,kind,pending_delta,available_delta,invalid_delta,actor_id,reason FROM jsonb_to_recordset(${JSON.stringify(grants)}::jsonb) AS v(id uuid,request_id uuid,fingerprint text,event_id uuid,promoter_id uuid,policy_id uuid,kind text,pending_delta bigint,available_delta bigint,invalid_delta bigint,actor_id uuid,reason text)`,
          );
      }
      await this.awardHouseBadges(tx, terms.houseRewards, window.cutoff);
      return snapshot;
    });
  }
  private async awardHouseBadges(
    tx: any,
    policy: ReturnType<typeof canonicalHousePolicy>,
    qualifiedAt: Date,
  ) {
    const counts = rows(
      await tx.execute(
        sql`SELECT a.promoter_id,p.user_id,a.metric,count(DISTINCT a.serve_id)::text AS progress FROM cfig_allocations a JOIN ads_promoters p ON p.id=a.promoter_id WHERE a.badge_eligible GROUP BY a.promoter_id,p.user_id,a.metric`,
      ),
    );
    for (const c of counts) {
      const thresholds =
        c.metric === "click"
          ? policy.houseClickThresholds
          : policy.houseImpressionThresholds;
      for (let i = 0; i < thresholds.length; i++)
        if (BigInt(c.progress) >= BigInt(thresholds[i]))
          await tx.execute(
            sql`INSERT INTO rewards_badges(user_id,badge_key,badge_title,badge_icon,tier,achieved_at) VALUES(${c.user_id},${"house_" + (c.metric === "click" ? "click" : "impression") + "_" + thresholds[i]},${"House " + (c.metric === "click" ? "Click" : "Impression") + " · Tier " + (i + 1)},${c.metric === "click" ? "mouse-pointer" : "eye"},${i + 1},${qualifiedAt}) ON CONFLICT(user_id,badge_key) DO NOTHING`,
          );
    }
  }
  async allocationReport(promoterId?: string, page = 1) {
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000)
      throw new BadRequestException("Invalid page");
    const items = rows(
      await this.db.execute(
        sql`SELECT event_id,day::text,serve_id,promoter_id,metric,outcome,entitled::text,allocated::text,badge_eligible,created_at FROM cfig_allocations WHERE (${promoterId ?? null}::uuid IS NULL OR promoter_id=${promoterId ?? null}::uuid) ORDER BY day DESC,created_at,event_id LIMIT 26 OFFSET ${(page - 1) * 25}`,
      ),
    );
    return { items: items.slice(0, 25), page, hasNext: items.length > 25 };
  }
  async finalizationReport() {
    return rows(
      await this.db.execute(
        sql`SELECT day::text,snapshot,created_at FROM cfig_finalizations ORDER BY day DESC LIMIT 31`,
      ),
    );
  }
  async badgeProgress(promoterId: string) {
    const progress = rows(
      await this.db.execute(
        sql`SELECT metric,count(DISTINCT serve_id)::text AS progress FROM cfig_allocations WHERE promoter_id=${promoterId} AND badge_eligible GROUP BY metric`,
      ),
    );
    const achievements = rows(
      await this.db.execute(
        sql`SELECT b.badge_key,b.badge_title,b.tier,b.achieved_at FROM rewards_badges b JOIN ads_promoters p ON p.user_id=b.user_id WHERE p.id=${promoterId} AND left(b.badge_key,6)='house_' ORDER BY b.achieved_at,b.badge_key`,
      ),
    );
    const p = canonicalHousePolicy();
    return {
      achievements,
      houseImpressions: {
        progress:
          progress.find((r) => r.metric === "viewable_impression")?.progress ??
          "0",
        thresholds: p.houseImpressionThresholds,
      },
      houseClicks: {
        progress: progress.find((r) => r.metric === "click")?.progress ?? "0",
        thresholds: p.houseClickThresholds,
      },
      prestigeOnly: true,
      testingEligible: false,
    };
  }
  async reserve() {
    const data = rows(
      await this.db.execute(
        sql`SELECT currency,cash_balance_usd_cents::text,available_usd_cents::text,allocated_usd_cents::text,funded_pending_usd_cents::text FROM rewards_fund WHERE currency='USD'`,
      ),
    );
    return {
      conversionEnabled: false,
      programAllocation: null,
      existingRewardsFund: data[0] ?? null,
      status:
        "No cfig conversion allocation or funding authority has been established. Existing fund totals are not available cfig backing.",
    };
  }
  conversion(): never {
    throw new ConflictException(
      "Cfig conversion is disabled: approved conversion/recovery policy, reconciled program allocation and separate launch authorization are required",
    );
  }
}
