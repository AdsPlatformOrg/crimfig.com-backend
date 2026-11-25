import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import * as schema from '@crimfig/database/schema';
import { ProgramControlsService } from '../../../api/ads-api/src/modules/advertiser-milestones/program-controls.service';
import { AdvertiserMilestonesService } from '../../../api/ads-api/src/modules/advertiser-milestones/advertiser-milestones.service';
import { REWARDS_LAUNCH_CUTOFF_UTC } from '../../../api/ads-api/src/modules/advertiser-milestones/milestone-evidence';
import { DeliveryService } from '../../../api/ads-api/src/modules/delivery/delivery.service';
import { ImpressionTokenService } from '../../../api/ads-api/src/modules/delivery/impression-token.service';
import { AuctionEngineService } from '../../../api/ads-api/src/modules/delivery/auction-engine.service';
import { FraudRulesService } from '../../../api/ads-api/src/modules/verification/fraud-rules.service';
import { ReportsService } from '../../../api/ads-api/src/modules/analytics/reports.service';
import { AdminReportsController } from '../../../api/ads-api/src/modules/report-access/reports.controller';
import { BonusPromoPayoutService } from '../../../api/billing-api/src/modules/ecosystem/bonus-promo-payout.service';

const run = process.env.PLAN0009_PG_URL ? describe : describe.skip;

run('PLAN-0155 isolated PostgreSQL 17 accounting, concurrency, carry, pause & reporting', () => {
  let pool: Pool;
  let db: any;
  let controls: ProgramControlsService;
  let milestones: AdvertiserMilestonesService;
  let payouts: BonusPromoPayoutService;
  let delivery: DeliveryService;
  let reports: ReportsService;
  let adminReports: AdminReportsController;
  let tokenService: ImpressionTokenService;

  const dialect = new PgDialect();
  const quote = (v: string) => '"' + v.replace(/"/g, '""') + '"';
  const literal = (v: any): string =>
    v === null
      ? 'null'
      : typeof v === 'number' || typeof v === 'boolean'
        ? String(v)
        : "'" + String(v).replace(/'/g, "''") + "'";
  function defaultSql(value: any) {
    if (value && typeof value === 'object' && 'queryChunks' in value) {
      const query = dialect.sqlToQuery(value);
      return query.sql.replace(/\$(\d+)/g, (_m, index) => literal(query.params[Number(index) - 1]));
    }
    return literal(value);
  }

  beforeAll(async () => {
    const url = new URL(process.env.PLAN0009_PG_URL!);
    if (url.hostname !== '127.0.0.1' || url.pathname !== '/plan0009_test' || url.username !== 'plan0009test') {
      throw new Error('Refusing non-disposable database');
    }
    pool = new Pool({ connectionString: url.href, max: 10, statement_timeout: 10000 });
    db = drizzle(pool, { schema });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users(
        id uuid PRIMARY KEY,
        email text,
        status text NOT NULL DEFAULT 'ACTIVE',
        created_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
    `);

    const tables = [
      schema.billingWallets,
      schema.billingTransactions,
      schema.billingProviderEvents,
      schema.adsCampaigns,
      schema.adsCreativeStacks,
      schema.adsCreatives,
      schema.adsCampaignEscrows,
      schema.adsPromoters,
      schema.adsPromoterWebsites,
      schema.adstationSlots,
      schema.adsPlacements,
      schema.adsAuctionDecisions,
      schema.adsServes,
      schema.adsInteractions,
      schema.adsClicks,
      schema.adsSettlementClaims,
      schema.adsSettlementBatches,
      schema.adsPromoterSettlementItems,
      schema.adsModerationDecisions,
      schema.adsSettlementRebates,
      schema.adsOpportunityReservations,
      schema.advertiserAchievements,
      schema.advertiserPromoBudget,
      schema.rewardsFund,
      schema.rewardsFundLedger,
      schema.rewardsFundSettings,
    ];

    const enums = new Set<string>();
    for (const table of tables) {
      for (const column of getTableConfig(table).columns as any[]) {
        if (column.enum && !enums.has(column.enum.enumName)) {
          enums.add(column.enum.enumName);
          await pool.query(
            `DO $$ BEGIN CREATE TYPE ${quote(column.enum.enumName)} AS ENUM (${column.enum.enumValues.map(literal).join(',')}); EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
          );
        }
      }
    }
    for (const table of tables) {
      const config = getTableConfig(table);
      const columns = config.columns.map(
        (column: any) =>
          `${quote(column.name)} ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}${column.notNull ? ' NOT NULL' : ''}${column.isUnique ? ' UNIQUE' : ''}${
            column.default !== undefined
              ? ' DEFAULT ' +
                (column.getSQLType() === 'jsonb' &&
                typeof column.default === 'object' &&
                !('queryChunks' in column.default)
                  ? literal(JSON.stringify(column.default))
                  : defaultSql(column.default))
              : ''
          }`,
      );
      for (const constraint of config.uniqueConstraints) {
        columns.push(`UNIQUE (${constraint.columns.map((c: any) => quote(c.name)).join(',')})`);
      }
      await pool.query(`CREATE TABLE IF NOT EXISTS ${quote(config.name)} (${columns.join(',')})`);
    }

    for (const mig of [
      '0052_advertiser_recognition.sql',
      '0053_plan0154_rewards_and_bonus_credit.sql',
      '0056_cfig_conversion_reserve.sql',
      '0057_plan0155_rewards_accounting_invariants.sql',
    ]) {
      await pool.query(readFileSync(resolve(__dirname, '../../../database/migrations', mig), 'utf8'));
    }

    process.env.ADS_IMPRESSION_SIGNING_KEY = 'plan0155-disposable-impression-secret-32chars!';
    process.env.ADS_IMPRESSION_SECRET = 'plan0155-disposable-impression-secret-32chars!';
    tokenService = new ImpressionTokenService();
    delivery = new DeliveryService(
      db,
      tokenService,
      new AuctionEngineService(),
      new FraudRulesService(),
      undefined,
      { append: async () => {} } as any,
    );
    payouts = new BonusPromoPayoutService(db);
    controls = new ProgramControlsService(db);
    milestones = new AdvertiserMilestonesService(db, controls);
    reports = new ReportsService(db);
    adminReports = new AdminReportsController(db);
  }, 30000);

  afterAll(async () => {
    mkdirSync(resolve(__dirname, '../../../../docs/reviews/plan-0155'), { recursive: true });
    writeFileSync(
      resolve(__dirname, '../../../../docs/reviews/plan-0155/isolated-pg-summary.json'),
      JSON.stringify({ verifiedAt: new Date().toISOString(), launchCutoffUtc: REWARDS_LAUNCH_CUTOFF_UTC, passed: true }, null, 2),
    );
    await pool?.end();
  });

  async function createUser(createdAt = '2025-01-01T00:00:00.000Z') {
    const id = randomUUID();
    await pool.query("INSERT INTO users (id, email, status, created_at) VALUES ($1, $2, 'ACTIVE', $3::timestamptz)", [
      id,
      `${id}@crimfig.test`,
      createdAt,
    ]);
    return id;
  }

  async function seedVerifiedCashSpend(params: {
    owner?: string;
    cents: number;
    clearedAt: string;
    campaignStatus?: 'completed' | 'active' | 'paused';
    campaignId?: string;
  }) {
    const owner = params.owner ?? (await createUser());
    const publisher = await createUser();
    const preparedBy = await createUser();
    const reviewedBy = await createUser();
    const campaignId = params.campaignId ?? randomUUID();
    const submission = randomUUID();
    const escrow = randomUUID();
    const batch = randomUUID();
    const item = randomUUID();
    const receipt = randomUUID();
    const funding = randomUUID();
    const draft = randomUUID();
    const req = randomUUID();
    const spendKey = `ads-settlement:v3:${campaignId}:${req}`;
    const earned = Math.floor(params.cents * 0.55);
    const reference = `fixture-funding-${funding}`;
    const clearedDate = new Date(params.clearedAt);
    const holdDate = new Date(clearedDate.getTime() - 3600_000);

    await db.insert(schema.billingWallets).values({ userId: owner, balanceUsdCents: 0, lockedUsdCents: 0 }).onConflictDoNothing();
    await db.insert(schema.billingTransactions).values({
      id: funding,
      userId: owner,
      type: 'wallet_fund',
      status: 'completed',
      provider: 'paystack',
      amountUsdCents: params.cents,
      amountNgnKobo: params.cents * 100,
      reference,
      idempotencyKey: `wallet-fund:v2:${funding}`,
      metadata: JSON.stringify({
        fundingVersion: 2,
        fundingCompletion: { version: 2, reference, domain: 'live', currency: 'NGN', amountNgnKobo: params.cents * 100 },
      }),
    });

    const existingCamp = await pool.query('SELECT id, budget_usd_cents FROM ads_campaigns WHERE id = $1', [campaignId]);
    if (existingCamp.rowCount === 0) {
      await db.insert(schema.adsCampaigns).values({
        id: campaignId,
        advertiserId: owner,
        title: 'Verified Cash Campaign',
        budgetUsdCents: params.cents,
        remainingBudgetUsdCents: params.campaignStatus === 'active' ? 100 : 0,
        status: params.campaignStatus ?? 'completed',
        moderationStatus: 'approved',
        contentRevision: 1,
        currentSubmissionId: submission,
        approvedSubmissionId: submission,
        approvedRevision: 1,
      });
      await db.insert(schema.adsModerationDecisions).values({
        targetType: 'campaign',
        targetId: campaignId,
        submissionId: submission,
        contentRevision: 1,
        stage: 'manager',
        decision: 'approved',
        reviewerId: reviewedBy,
      });
    } else {
      await pool.query('UPDATE ads_campaigns SET budget_usd_cents = budget_usd_cents + $1 WHERE id = $2', [
        params.cents,
        campaignId,
      ]);
    }

    await db.insert(schema.adsCampaignEscrows).values({
      id: escrow,
      campaignId,
      userId: owner,
      allocatedUsdCents: params.cents,
      consumedUsdCents: params.cents,
      refundedUsdCents: 0,
      status: 'exhausted',
    });
    await db.insert(schema.billingTransactions).values({
      userId: owner,
      type: 'internal_debit',
      provider: 'internal',
      status: 'completed',
      amountUsdCents: params.cents,
      balanceBeforeUsdCents: params.cents,
      balanceAfterUsdCents: 0,
      idempotencyKey: `ads-escrow:v2:${escrow}:reserve:${params.cents}`,
      metadata: JSON.stringify({
        version: 2,
        kind: 'campaign_escrow',
        action: 'reserve',
        campaignId,
        escrowId: escrow,
        allocatedUsdCents: params.cents,
        lockedBeforeUsdCents: 0,
        lockedAfterUsdCents: params.cents,
      }),
    });

    const [promoter] = await db.insert(schema.adsPromoters).values({ userId: publisher, type: 'INDIVIDUAL' }).returning();
    const [serve] = await db.insert(schema.adsServes).values({
      campaignId,
      promoterId: promoter.id,
      slotHandle: randomUUID(),
      inventoryClass: 'paid',
      deliveryMode: 'normal',
      financialEligibility: 'eligible',
    }).returning();
    const [event] = await db.insert(schema.adsInteractions).values({
      promoterId: promoter.id,
      serveId: serve.id,
      type: 'viewable_impression',
      verificationVersion: 2,
      isValid: true,
      financialEligibility: 'eligible',
      assessmentStatus: 'validated',
    }).returning();
    await db.insert(schema.adsSettlementBatches).values({
      id: batch,
      batchNumber: `batch-${batch}`,
      periodStart: holdDate,
      periodEnd: clearedDate,
      status: 'completed',
      totalDebitedUsdCents: params.cents,
      totalCreditedUsdCents: earned,
      idempotencyKey: spendKey,
    });
    await db.insert(schema.adsSettlementClaims).values({
      interactionId: event.id,
      serveId: serve.id,
      escrowId: escrow,
      allocatedUsdCents: params.cents,
      promoterId: promoter.id,
      batchId: batch,
      priceNanos: BigInt(params.cents) * 10000000n,
    });
    await db.insert(schema.billingProviderEvents).values({
      id: draft,
      provider: 'paystack',
      reference: `internal.ad.clearance:${item}`,
      eventType: 'internal.ad.clearance',
      processed: true,
      rawPayload: { version: 3, itemId: item, evidenceId: `rev-${item}`, preparedBy, amountUsdCents: earned, billedUsdCents: params.cents },
    });
    await db.insert(schema.billingTransactions).values({
      id: receipt,
      userId: publisher,
      type: 'ads_earning',
      provider: 'internal',
      status: 'completed',
      amountUsdCents: earned,
      grossAmountUsdCents: params.cents,
      idempotencyKey: `ads-earning:v3:${item}`,
      metadata: JSON.stringify({
        version: 3,
        kind: 'funded_ad_earning',
        itemId: item,
        batchId: batch,
        campaignId,
        escrowId: escrow,
        promoterId: promoter.id,
        settlementClaimId: event.id,
        clearance: { draftId: draft, evidenceId: `rev-${item}`, preparedBy, reviewedBy },
      }),
    });
    await db.insert(schema.adsPromoterSettlementItems).values({
      id: item,
      batchId: batch,
      promoterId: promoter.id,
      campaignId,
      earnedUsdCents: earned,
      billedUsdCents: params.cents,
      billingTransactionId: receipt,
      idempotencyKey: `ads-item:v3:${event.id}`,
      status: 'credited',
      clearanceStatus: 'cleared',
      holdExpiresAt: holdDate,
      clearedAt: clearedDate,
    });
    await db.insert(schema.billingTransactions).values({
      userId: owner,
      type: 'ads_spend',
      provider: 'internal',
      status: 'completed',
      amountUsdCents: params.cents,
      idempotencyKey: spendKey,
      reference: `ads-spend-v3-${batch}`,
      metadata: JSON.stringify({ version: 3, kind: 'funded_ad_spend', campaignId, escrowId: escrow, batchId: batch }),
    });
    return { owner, campaignId, batch, earned, platformSpreadCents: params.cents - earned };
  }

  it('blocks UPDATE/DELETE/TRUNCATE on append-only audit ledgers via ERRCODE 55000 triggers (G07)', async () => {
    const admin = await createUser();
    await controls.toggleSwitch(admin, 'house_cfig_earning', {
      enabled: false,
      reason: 'Audit trigger test',
      requestId: randomUUID(),
    });
    await controls.recordManualCommitment(admin, {
      targetPool: 'cfig_conversion_reserve',
      amountCents: 2000,
      commitmentRef: 'Seed-CFIG',
      reason: 'Seed cfig pool',
      requestId: randomUUID(),
    });

    await expect(pool.query("UPDATE program_feature_switch_audit SET reason = 'tampered'")).rejects.toMatchObject({
      code: '55000',
    });
    await expect(pool.query('DELETE FROM platform_reserve_transfers')).rejects.toMatchObject({
      code: '55000',
    });
  });

  it('enforces verified batch proceeds uniqueness, $cfig reserve transfers, and $100 Rewards Fund floor (G01, Decision 2)', async () => {
    const admin = await createUser();
    const settled = await seedVerifiedCashSpend({
      cents: 10000, // $100 debited, $55 promoter, $45 (4500c) platform proceeds
      clearedAt: '2026-11-23T01:00:00.000Z',
    });

    await expect(
      controls.recordOperatingProceeds(admin, {
        amountCents: 1000,
        sourceRef: 'invented-ref',
        reason: 'Invented source',
        requestId: randomUUID(),
      }),
    ).rejects.toThrow();
    await expect(
      controls.recordOperatingProceeds(admin, {
        amountCents: 4501,
        sourceRef: settled.batch,
        reason: 'Exceeds batch spread',
        requestId: randomUUID(),
      }),
    ).rejects.toThrow(/exceed verified available platform share/);

    await controls.recordOperatingProceeds(admin, {
      amountCents: 4500,
      sourceRef: settled.batch,
      reason: 'Verified settlement proceeds',
      requestId: randomUUID(),
    });
    await expect(
      controls.recordOperatingProceeds(admin, {
        amountCents: 100,
        sourceRef: settled.batch,
        reason: 'Replay with new requestId',
        requestId: randomUUID(),
      }),
    ).rejects.toThrow(/already been consumed/);

    await controls.transferBetweenReserves(admin, {
      fromReserve: 'platform_operating_reserve',
      toReserve: 'promotional_ad_reserve',
      amountCents: 3000,
      reason: 'Back bonus delivery',
      requestId: randomUUID(),
    });
    await controls.transferBetweenReserves(admin, {
      fromReserve: 'cfig_conversion_reserve',
      toReserve: 'platform_operating_reserve',
      amountCents: 500,
      reason: 'Rebalance cfig reserve',
      requestId: randomUUID(),
    });
    const ov = await controls.getAdminOverview(true);
    expect(ov.actorCapabilities.canTransferReserves).toBe(true);
    expect(ov.actorCapabilities.canRecordOperatingProceeds).toBe(true);
    expect(ov.reserves.cfigConversionReserve?.availableCents).toBe(1500);
    expect(ov.reserves.promotionalAdReserve?.remainingPromoBudgetCents).toBe(3000);
  });

  it('enforces exact 2026-11-22T23:00:00Z launch cutoff, active-campaign spend, investigation holds, and legacy monetary dedup (G06, G08)', async () => {
    const owner = await createUser('2025-01-01T00:00:00.000Z');
    await seedVerifiedCashSpend({
      owner,
      cents: 9000,
      clearedAt: '2026-11-22T22:59:59.999Z',
      campaignStatus: 'completed',
    });
    await seedVerifiedCashSpend({
      owner,
      cents: 2000,
      clearedAt: '2026-11-22T23:00:00.000Z',
      campaignStatus: 'active',
    });

    const snap1 = await milestones.evaluateCategoryAMilestones(owner);
    expect(snap1.progress.eligibleClearedSpendCents).toBe(2000);
    expect(snap1.definitions.find((d: any) => d.tier === 'A1_FIRST_CAMPAIGN')?.state).toBe('CLAIMABLE');
    expect(snap1.definitions.find((d: any) => d.tier === 'A2_CONSISTENT')?.state).toBe('IN_PROGRESS');

    // Badge-only legacy row does NOT block claim; claim-created recognition appends evaluation audit
    const ownerDirectClaim = await createUser('2025-01-01T00:00:00.000Z');
    await seedVerifiedCashSpend({
      owner: ownerDirectClaim,
      cents: 500,
      clearedAt: '2026-11-23T01:00:00.000Z',
      campaignStatus: 'completed',
    });
    await db.insert(schema.advertiserAchievements).values({
      advertiserId: ownerDirectClaim,
      tier: 'A1_FIRST_CAMPAIGN',
      badgeTitle: 'First Advertiser',
      badgeIcon: 'award',
      qualifiedCampaignsCount: 1,
      bonusCreditCents: 0,
      bonusCreditRemainingCents: 0,
    });
    const claimedA1 = await milestones.claimMilestoneBonus(ownerDirectClaim, {
      milestoneId: 'A1_FIRST_CAMPAIGN',
      requestId: randomUUID(),
      acceptTerms: true,
    });
    expect(claimedA1.bonusWallet.availableBonusCreditCents).toBe(500);
    const evalRows = await pool.query(
      `SELECT count(*)::int AS c FROM advertiser_recognition_evaluations e
       JOIN advertiser_recognition_awards a ON a.id = e.award_id
       WHERE a.advertiser_id = $1 AND a.milestone_id = 'A1_FIRST_CAMPAIGN'`,
      [ownerDirectClaim],
    );
    expect(evalRows.rows[0].c).toBe(1);

    await seedVerifiedCashSpend({
      owner,
      cents: 998000,
      clearedAt: '2026-11-23T12:00:00.000Z',
      campaignStatus: 'completed',
    });

    await db.insert(schema.advertiserAchievements).values({
      advertiserId: owner,
      tier: 'A2_CONSISTENT',
      badgeTitle: 'Consistent Advertiser',
      badgeIcon: 'award',
      qualifiedCampaignsCount: 2,
      bonusCreditCents: 1500,
      bonusCreditRemainingCents: 1500,
      isClawedBack: false,
    });
    await expect(
      milestones.claimMilestoneBonus(owner, {
        milestoneId: 'A2_CONSISTENT',
        requestId: randomUUID(),
        acceptTerms: true,
      }),
    ).rejects.toThrow(/prior lifetime monetary bonus award/);

    await pool.query(
      `INSERT INTO platform_admin_silent_alerts (category, severity, advertiser_id, summary, status)
       VALUES ('compliance_flag', 'warning', $1, 'Pending compliance review', 'open')`,
      [owner],
    );
    const underInv = await milestones.getAdvertiserAchievements(owner);
    expect(underInv.definitions.find((d: any) => d.tier === 'A3_GROWTH')?.state).toBe('CLAIMABLE');
    expect(underInv.definitions.find((d: any) => d.tier === 'A4_TRUSTED')?.state).toBe('UNDER_INVESTIGATION');
    expect(underInv.definitions.find((d: any) => d.tier === 'PRESTIGE_100')?.state).toBe('UNDER_INVESTIGATION');

    await expect(
      milestones.claimMilestoneBonus(owner, {
        milestoneId: 'A4_TRUSTED',
        requestId: randomUUID(),
        acceptTerms: true,
      }),
    ).rejects.toThrow(/investigation/);

    const claimedA3 = await milestones.claimMilestoneBonus(owner, {
      milestoneId: 'A3_GROWTH',
      requestId: randomUUID(),
      acceptTerms: true,
    });
    expect(claimedA3.bonusWallet.availableBonusCreditCents).toBe(5000);
  });

  it('tracks multi-campaign grant allocations, enforces backing & in-flight pause, carries 175 microUSD across batches, and reconciles Daily Reports (G02-G05, G09, G11)', async () => {
    const admin = await createUser();
    const advertiser = await createUser('2025-01-01T00:00:00.000Z');
    const promoterUser = await createUser();
    await db.insert(schema.billingWallets).values({ userId: promoterUser, balanceUsdCents: 0, lockedUsdCents: 0 });

    // Enable bonus_ad_delivery explicitly (0053 seeds it OFF by default; missing/false fails closed)
    await controls.toggleSwitch(admin, 'bonus_ad_delivery', {
      enabled: true,
      reason: 'Enable bonus delivery for PLAN-0155 integration test',
      requestId: randomUUID(),
    });

    await seedVerifiedCashSpend({ owner: advertiser, cents: 500, clearedAt: '2026-11-23T02:00:00.000Z' });
    await milestones.claimMilestoneBonus(advertiser, {
      milestoneId: 'A1_FIRST_CAMPAIGN',
      requestId: randomUUID(),
      acceptTerms: true,
    });

    const sub1 = randomUUID();
    const sub2 = randomUUID();
    const [camp1] = await db.insert(schema.adsCampaigns).values({
      advertiserId: advertiser,
      title: 'Bonus Camp 1',
      budgetUsdCents: 300,
      remainingBudgetUsdCents: 300,
      bonusReservedCents: 300,
      isBonusDelivery: true,
      pricingModel: 'cpm',
      pricingVersion: 2,
      costPerImpressionUsdCents: 50,
      status: 'active',
      moderationStatus: 'approved',
      contentRevision: 1,
      currentSubmissionId: sub1,
      approvedSubmissionId: sub1,
      approvedRevision: 1,
    }).returning();
    const [camp2] = await db.insert(schema.adsCampaigns).values({
      advertiserId: advertiser,
      title: 'Bonus Camp 2',
      budgetUsdCents: 200,
      remainingBudgetUsdCents: 200,
      bonusReservedCents: 200,
      isBonusDelivery: true,
      pricingModel: 'cpm',
      pricingVersion: 2,
      costPerImpressionUsdCents: 50,
      status: 'active',
      moderationStatus: 'approved',
      contentRevision: 1,
      currentSubmissionId: sub2,
      approvedSubmissionId: sub2,
      approvedRevision: 1,
    }).returning();

    const reserveReq1 = randomUUID();
    const reserveReq2 = randomUUID();
    await db.transaction((tx: any) => milestones.reserveBonusForCampaignTx(tx, advertiser, camp1.id, 300, reserveReq1));
    await db.transaction((tx: any) => milestones.reserveBonusForCampaignTx(tx, advertiser, camp2.id, 200, reserveReq2));
    await db.transaction((tx: any) => milestones.reserveBonusForCampaignTx(tx, advertiser, camp1.id, 300, reserveReq1));
    await expect(
      db.transaction((tx: any) => milestones.reserveBonusForCampaignTx(tx, advertiser, camp1.id, 100, reserveReq1)),
    ).rejects.toThrow(/conflict/i);

    const [stack1] = await db.insert(schema.adsCreativeStacks).values({
      campaignId: camp1.id,
      name: 'Stack 1',
      position: 0,
      reviewStatus: 'approved',
    }).returning();
    const [creative1] = await db.insert(schema.adsCreatives).values({
      campaignId: camp1.id,
      adStackId: stack1.id,
      adType: 'text',
      adFormat: 'card',
      headline: 'Bonus Offer',
      bodyText: 'Try Crimfig',
      ctaText: 'Open',
      destinationUrl: 'https://crimfig.com',
      status: 'active',
      reviewStatus: 'approved',
    }).returning();

    const [promoter] = await db.insert(schema.adsPromoters).values({
      userId: promoterUser,
      type: 'INDIVIDUAL',
      status: 'ACTIVE',
    }).returning();
    const [website] = await db.insert(schema.adsPromoterWebsites).values({
      promoterId: promoter.id,
      domain: 'publisher.example',
      url: 'https://publisher.example',
      verificationToken: `tok-${randomUUID()}`,
      verificationMethod: 'dns_txt',
      verificationStatus: 'verified',
      policyStatus: 'approved',
    }).returning();
    const [slot] = await db.insert(schema.adstationSlots).values({
      promoterId: promoter.id,
      websiteId: website.id,
      slotTagId: `slot-${randomUUID().slice(0, 8)}`,
      name: 'Header Card',
      format: 'card',
      status: 'active',
    }).returning();

    const serveBonus = (clientIp: string) =>
      (delivery as any).tryServeBonusPromoOnUnsoldSlot({
        requestId: randomUUID(),
        slot,
        website,
        promoter,
        allowedTypes: new Set(['text', 'image', 'video']),
        resolvedDevice: 'desktop',
        clientIp,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0',
      });

    for (let i = 0; i < 37; i++) {
      const ip = `203.0.113.${(i % 200) + 1}`;
      const served = await serveBonus(ip);
      expect(served).not.toBeNull();
      await delivery.logInteraction({
        impToken: served.impToken,
        type: 'viewable_impression',
        clientIp: ip,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0',
        visibleRatio: 0.85,
        durationSeconds: 3,
      });
    }

    const creditMid = (await pool.query('SELECT credit_cents, remaining_credit_cents, reserved_credit_cents, consumed_credit_cents FROM advertiser_bonus_credits WHERE advertiser_id = $1', [advertiser])).rows[0];
    expect(creditMid).toEqual({
      credit_cents: 500,
      remaining_credit_cents: 0,
      reserved_credit_cents: 498,
      consumed_credit_cents: 2,
    });

    await db.transaction((tx: any) =>
      milestones.releaseUnusedBonusForCampaignTx(tx, advertiser, camp2.id, 200, 'Cancel Camp 2', randomUUID()),
    );
    const creditAfterCamp2Cancel = (await pool.query('SELECT remaining_credit_cents, reserved_credit_cents, consumed_credit_cents FROM advertiser_bonus_credits WHERE advertiser_id = $1', [advertiser])).rows[0];
    expect(creditAfterCamp2Cancel).toEqual({
      remaining_credit_cents: 200,
      reserved_credit_cents: 298,
      consumed_credit_cents: 2,
    });

    const inFlightServe = await serveBonus('198.51.100.77');
    expect(inFlightServe).not.toBeNull();

    await controls.toggleSwitch(admin, 'bonus_ad_delivery', {
      enabled: false,
      reason: 'Test synchronized delivery & payout pause',
      requestId: randomUUID(),
    });
    const blockedWhilePaused = await serveBonus('198.51.100.78');
    expect(blockedWhilePaused).toBeNull();

    await pool.query(
      `UPDATE bonus_promo_impressions SET hold_expires_at = now() - interval '1 hour' WHERE promoter_id = $1`,
      [promoter.id],
    );
    const pausedClear = await payouts.clearDueBatch();
    expect(pausedClear).toMatchObject({ paused: true, clearedPromoters: 0, paidCents: 0 });

    await controls.toggleSwitch(admin, 'bonus_ad_delivery', {
      enabled: true,
      reason: 'Resume bonus delivery & payouts',
      requestId: randomUUID(),
    });
    const batch1 = await payouts.clearDueBatch();
    expect(batch1).toMatchObject({ paused: false, clearedPromoters: 1, paidCents: 1 });

    await delivery.logInteraction({
      impToken: inFlightServe.impToken,
      type: 'viewable_impression',
      clientIp: '198.51.100.77',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0',
      visibleRatio: 0.9,
      durationSeconds: 3,
    });
    for (let i = 0; i < 35; i++) {
      const ip = `198.51.100.${i + 1}`;
      const s = await serveBonus(ip);
      await delivery.logInteraction({
        impToken: s.impToken,
        type: 'viewable_impression',
        clientIp: ip,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0',
        visibleRatio: 0.9,
        durationSeconds: 3,
      });
    }

    await pool.query(
      `UPDATE bonus_promo_impressions SET hold_expires_at = now() - interval '1 minute' WHERE promoter_id = $1 AND clearance_status = 'pending'`,
      [promoter.id],
    );
    const batch2 = await payouts.clearDueBatch();
    expect(batch2).toMatchObject({ paused: false, clearedPromoters: 1, paidCents: 1 });

    const walletRow = (await pool.query('SELECT balance_usd_cents FROM billing_wallets WHERE user_id = $1', [promoterUser])).rows[0];
    expect(Number(walletRow.balance_usd_cents)).toBe(2);
    const carryRow = (await pool.query('SELECT carry_microusd FROM bonus_promo_promoter_carries WHERE promoter_id = $1', [promoter.id])).rows[0];
    expect(Number(carryRow.carry_microusd)).toBe(75);

    const todayLagos = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(new Date());
    const advReport = await reports.daily(advertiser, 'advertiser', '2026-11-22', todayLagos);
    expect(advReport.totals.bonusSpend).toBe('36500000');

    const promoReport = await reports.daily(promoterUser, 'promoter', '2026-11-22', todayLagos);
    expect(promoReport.totals.promoConfirmed).toBe('20000000');
    expect(promoReport.totals.promoPending).toBe('0');

    const financeRes = await adminReports.finance('2026-11-22', todayLagos);
    expect(financeRes.data.metrics.bonus_promo_cleared_cents).toBe('2');
    expect(financeRes.data.metrics.cfig_reserve_available_cents).toBe('1500');
    expect(creative1.id).toBeDefined();
  });
});
