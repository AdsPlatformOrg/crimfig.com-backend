import { Injectable } from '@nestjs/common';

export type CanonicalCronJobKey =
  | 'ads.cpc.processing'
  | 'ads.traffic.quality'
  | 'ads.audit.rolling72h'
  | 'ads.audit.day15'
  | 'ads.audit.day30'
  | 'ads.rewards.reconcile';

export type CronJobMode = 'ACTIVE' | 'REPORT_ONLY';

export interface DeferredAuditWindow {
  lower: string;
  upper: string;
  deferredAt: string;
  reason: string;
}

export interface CronJobDefinition {
  jobKey: string;
  description: string;
  schedule: string;
  timezone: 'UTC';
  leaseTtlMs: number;
  deadlineMs: number;
  priority: number;
  isHeavy: boolean;
  defaultMode: CronJobMode;
  featureFlagEnv: string;
  aliasFeatureFlagEnvs?: readonly string[];
  defaultEnabled: boolean;
}

export interface CronExecutionContext {
  readonly jobKey: string;
  readonly runId: string;
  readonly instanceId: string;
  readonly fencingToken: number;
  readonly triggerTime: Date;
  readonly startedAt: Date;
  readonly deadlineAt: Date;
  readonly mode: CronJobMode;
  readonly allowAutomaticFinancialCorrections: boolean;
  readonly signal: AbortSignal;
  readonly lastCheckpoint: Record<string, unknown> | null;
  readonly deferredWindows: DeferredAuditWindow[];
  assertLeaseOwnership(): Promise<void>;
  saveCheckpoint(checkpoint: Record<string, unknown>): Promise<void>;
}

export interface CronJobResult {
  processedCount: number;
  failedCount?: number;
  deferredCount?: number;
  checkpoint?: Record<string, unknown>;
  summary?: Record<string, unknown>;
}

export interface CronJobHandler {
  readonly jobKey: string;
  execute(context: CronExecutionContext): Promise<CronJobResult>;
}

export class CronLeaseLostError extends Error {
  constructor(
    public readonly jobKey: string,
    public readonly instanceId: string,
    public readonly fencingToken: number,
    message?: string,
  ) {
    super(
      message ??
        `Cron lease ownership lost or expired for job "${jobKey}" (instance=${instanceId}, fencingToken=${fencingToken})`,
    );
    this.name = 'CronLeaseLostError';
  }
}

export const DEFAULT_CRON_JOB_DEFINITIONS: readonly CronJobDefinition[] = [
  {
    jobKey: 'ads.cpc.processing',
    description: 'Validate pending CPC clicks, settle eligible events via Billing, and coordinate shared 5-minute cycle tasks',
    schedule: '0 */5 * * * *',
    timezone: 'UTC',
    leaseTtlMs: 240_000,
    deadlineMs: 210_000,
    priority: 1,
    isHeavy: true,
    defaultMode: 'ACTIVE',
    featureFlagEnv: 'ADS_CPC_PROCESSOR_ENABLED',
    aliasFeatureFlagEnvs: ['ADS_CRON_CPC_ENABLED'],
    defaultEnabled: true,
  },
  {
    jobKey: 'ads.traffic.quality',
    description: 'Collect approved PLAN-0111 publisher traffic-quality observations within the 5-minute processing cycle',
    schedule: 'shared:ads.cpc.processing',
    timezone: 'UTC',
    leaseTtlMs: 120_000,
    deadlineMs: 90_000,
    priority: 2,
    isHeavy: false,
    defaultMode: 'REPORT_ONLY',
    featureFlagEnv: 'ADS_TRAFFIC_QUALITY_CRON_ENABLED',
    aliasFeatureFlagEnvs: ['ADS_CRON_TRAFFIC_QUALITY_ENABLED'],
    defaultEnabled: true,
  },
  {
    jobKey: 'ads.rewards.reconcile',
    description: 'Reconcile eligible cash, points, and virtual $CFIG entitlements through existing authorities',
    schedule: 'shared:ads.cpc.processing',
    timezone: 'UTC',
    leaseTtlMs: 120_000,
    deadlineMs: 90_000,
    priority: 3,
    isHeavy: false,
    defaultMode: 'REPORT_ONLY',
    featureFlagEnv: 'ADS_REWARDS_RECONCILE_CRON_ENABLED',
    aliasFeatureFlagEnvs: ['ADS_CRON_REWARDS_RECONCILIATION_ENABLED'],
    defaultEnabled: true,
  },
  {
    jobKey: 'ads.audit.rolling72h',
    description: 'Recheck events in the rolling preceding 72 hours for fraud and duplicate activity',
    schedule: '0 0 */6 * * *',
    timezone: 'UTC',
    leaseTtlMs: 300_000,
    deadlineMs: 240_000,
    priority: 5,
    isHeavy: true,
    defaultMode: 'REPORT_ONLY',
    featureFlagEnv: 'ADS_AUDIT_ROLLING_72H_ENABLED',
    aliasFeatureFlagEnvs: ['ADS_CRON_ROLLING_AUDIT_ENABLED'],
    defaultEnabled: true,
  },
  {
    jobKey: 'ads.audit.day15',
    description: 'Daily extended audit of event cohorts reaching the 15-day milestone (including overdue cohorts)',
    schedule: '0 15 2 * * *',
    timezone: 'UTC',
    leaseTtlMs: 300_000,
    deadlineMs: 240_000,
    priority: 6,
    isHeavy: true,
    defaultMode: 'REPORT_ONLY',
    featureFlagEnv: 'ADS_AUDIT_DAY_15_ENABLED',
    aliasFeatureFlagEnvs: ['ADS_CRON_DAY15_AUDIT_ENABLED'],
    defaultEnabled: true,
  },
  {
    jobKey: 'ads.audit.day30',
    description: 'Daily extended audit of event cohorts reaching the 30-day milestone (including overdue cohorts)',
    schedule: '0 45 2 * * *',
    timezone: 'UTC',
    leaseTtlMs: 300_000,
    deadlineMs: 240_000,
    priority: 7,
    isHeavy: true,
    defaultMode: 'REPORT_ONLY',
    featureFlagEnv: 'ADS_AUDIT_DAY_30_ENABLED',
    aliasFeatureFlagEnvs: ['ADS_CRON_DAY30_AUDIT_ENABLED'],
    defaultEnabled: true,
  },
];

function parseBoolEnv(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  return defaultValue;
}

@Injectable()
export class CronJobRegistry {
  private readonly definitions = new Map<string, CronJobDefinition>();

  constructor() {
    for (const def of DEFAULT_CRON_JOB_DEFINITIONS) {
      this.definitions.set(def.jobKey, { ...def });
    }
  }

  register(definition: CronJobDefinition): void {
    const key = definition.jobKey?.trim();
    if (!key || !/^[a-z0-9._-]{3,64}$/i.test(key)) {
      throw new Error(`Invalid cron job key "${definition.jobKey}"`);
    }
    if (!definition.schedule?.trim()) {
      throw new Error(`Schedule is required for cron job "${key}"`);
    }
    if (!Number.isFinite(definition.leaseTtlMs) || definition.leaseTtlMs < 1_000) {
      throw new Error(`leaseTtlMs must be at least 1000ms for cron job "${key}"`);
    }
    if (!Number.isFinite(definition.deadlineMs) || definition.deadlineMs < 500 || definition.deadlineMs > definition.leaseTtlMs) {
      throw new Error(`deadlineMs must be between 500ms and leaseTtlMs for cron job "${key}"`);
    }
    this.definitions.set(key, {
      ...definition,
      jobKey: key,
      timezone: 'UTC',
    });
  }

  get(jobKey: string): CronJobDefinition | undefined {
    return this.definitions.get(jobKey);
  }

  getOrThrow(jobKey: string): CronJobDefinition {
    const def = this.definitions.get(jobKey);
    if (!def) {
      throw new Error(`Unregistered cron job key "${jobKey}"`);
    }
    return def;
  }

  list(): CronJobDefinition[] {
    return Array.from(this.definitions.values()).sort(
      (a, b) => a.priority - b.priority || a.jobKey.localeCompare(b.jobKey),
    );
  }

  isMasterEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return parseBoolEnv(env.ADS_IN_PROCESS_CRON_ENABLED, true);
  }

  isJobEnabled(jobKey: string, env: NodeJS.ProcessEnv = process.env): boolean {
    if (!this.isMasterEnabled(env)) return false;
    const def = this.getOrThrow(jobKey);
    const primaryRaw = env[def.featureFlagEnv];
    if (primaryRaw !== undefined && primaryRaw.trim() !== '') {
      return parseBoolEnv(primaryRaw, def.defaultEnabled);
    }
    for (const alias of def.aliasFeatureFlagEnvs ?? []) {
      const aliasRaw = env[alias];
      if (aliasRaw !== undefined && aliasRaw.trim() !== '') {
        return parseBoolEnv(aliasRaw, def.defaultEnabled);
      }
    }
    return def.defaultEnabled;
  }

  /**
   * Automatic retrospective deductions, rebates, and reward reversals are NEVER inferred
   * from monitoring or CPC settlement flags. Requires explicit ADS_AUTOMATIC_FINANCIAL_CORRECTIONS_ENABLED=true
   * or ADS_CRON_AUTO_FINANCIAL_CORRECTIONS_ENABLED=true.
   */
  isAutomaticFinancialCorrectionsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const primary = env.ADS_AUTOMATIC_FINANCIAL_CORRECTIONS_ENABLED;
    if (primary !== undefined && primary.trim() !== '') {
      return parseBoolEnv(primary, false);
    }
    return parseBoolEnv(env.ADS_CRON_AUTO_FINANCIAL_CORRECTIONS_ENABLED, false);
  }

  /**
   * Ordinary forward rewards settlement (milestone recognition + matured 72h bonus-promo payout clearance)
   * is explicitly separated from retrospective clawbacks/rebates (PLAN-0155 G11).
   */
  isForwardRewardsSettlementEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const raw = env.ADS_REWARDS_FORWARD_SETTLEMENT_ENABLED;
    if (raw !== undefined && raw.trim() !== '') {
      return parseBoolEnv(raw, true);
    }
    return true;
  }

  resolveMode(jobKey: string, env: NodeJS.ProcessEnv = process.env): CronJobMode {
    const def = this.getOrThrow(jobKey);
    if (
      jobKey === 'ads.audit.rolling72h' ||
      jobKey === 'ads.audit.day15' ||
      jobKey === 'ads.audit.day30'
    ) {
      return 'REPORT_ONLY';
    }
    if (jobKey === 'ads.rewards.reconcile') {
      return this.isAutomaticFinancialCorrectionsEnabled(env) ? 'ACTIVE' : 'REPORT_ONLY';
    }
    return def.defaultMode;
  }

  computeNextExpectedRun(jobKey: string, fromDate: Date = new Date()): Date {
    const def = this.getOrThrow(jobKey);
    const baseMs = fromDate.getTime();

    if (def.schedule === '0 */5 * * * *' || def.schedule.startsWith('shared:')) {
      const intervalMs = 5 * 60_000;
      return new Date((Math.floor(baseMs / intervalMs) + 1) * intervalMs);
    }

    if (def.schedule === '0 0 */6 * * *') {
      const intervalMs = 6 * 3_600_000;
      return new Date((Math.floor(baseMs / intervalMs) + 1) * intervalMs);
    }

    const dailyMatch = /^0\s+(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec(def.schedule.trim());
    if (dailyMatch) {
      const minute = Number(dailyMatch[1]);
      const hour = Number(dailyMatch[2]);
      const candidate = new Date(
        Date.UTC(
          fromDate.getUTCFullYear(),
          fromDate.getUTCMonth(),
          fromDate.getUTCDate(),
          hour,
          minute,
          0,
          0,
        ),
      );
      if (candidate.getTime() <= baseMs) {
        candidate.setUTCDate(candidate.getUTCDate() + 1);
      }
      return candidate;
    }

    return new Date(baseMs + 5 * 60_000);
  }
}

