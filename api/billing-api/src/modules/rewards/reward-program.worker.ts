import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import { sql } from "drizzle-orm";
import { adDigest } from "@crimfig/shared";
import { gate } from "./reward-program-policy";
import { RewardProgramService } from "./reward-program.service";
export function paidRewardRequestId(eventId: string, allocationId: string) {
  const h = adDigest({ kind: "paid-reward-v1", eventId, allocationId });
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
@Injectable()
export class RewardProgramWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly logger = new Logger(RewardProgramWorker.name);
  constructor(
    @Inject("DATABASE_CONNECTION") private readonly db: any,
    private readonly service: RewardProgramService,
  ) {}
  onModuleInit() {
    if (
      this.timer ||
      !gate("paid") ||
      !process.env.BILLING_REWARDS_WORKER_OPERATOR_ID
    )
      return;
    this.timer = setInterval(() => {
      void this.reconcile().catch(() =>
        this.logger.warn("Reward reconciliation remains unconfirmed"),
      );
    }, 60000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  async reconcile() {
    const actor = process.env.BILLING_REWARDS_WORKER_OPERATOR_ID;
    if (this.running || !gate("paid") || !actor) return;
    this.running = true;
    try {
      const result = await this.db.execute(
        sql`SELECT e.id,a.id AS allocation_id FROM ads_interactions e JOIN ads_serves s ON s.id=e.serve_id JOIN ads_opportunity_reservations r ON r.id=s.opportunity_reservation_id JOIN reward_program_allocations a ON a.program='paid_performance' AND a.approved_at IS NOT NULL AND (a.policy_snapshot->>'effectiveFrom')::timestamptz<=e.created_at WHERE s.inventory_class='paid' AND s.delivery_mode<>'shadow' AND NOT r.is_simulated AND r.state='CLAIMED' AND r.settled_at IS NOT NULL AND r.claim_event_id=e.id AND e.created_at<=clock_timestamp()-interval '72 hours' AND NOT EXISTS(SELECT 1 FROM reward_performance_receipts p WHERE p.event_id=e.id) AND EXISTS(SELECT 1 FROM ads_settlement_claims c JOIN ads_promoter_settlement_items i ON i.batch_id=c.batch_id AND i.promoter_id=c.promoter_id AND i.campaign_id=s.campaign_id WHERE c.interaction_id=e.id AND i.clearance_status='cleared' AND i.status='credited' AND i.hold_expires_at<=clock_timestamp()) ORDER BY e.created_at,e.id,a.created_at,a.id LIMIT 20`,
      );
      for (const row of result.rows ?? result)
        try {
          await this.service.processPaid(actor, row.id, {
            allocationId: row.allocation_id,
            requestId: paidRewardRequestId(row.id, row.allocation_id),
          });
        } catch {
          this.logger.warn(
            "Reward candidate remains unconfirmed; no success or credit assumed",
          );
        }
    } finally {
      this.running = false;
    }
  }
}
