import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { sql } from "drizzle-orm";
import { diagnosticPolicy } from "@crimfig/shared";
import { DATABASE_TOKEN } from "../database/database.module";
@Injectable()
export class ErrorDiagnosticsRetentionWorker
  implements OnModuleInit, OnModuleDestroy
{
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private readonly logger = new Logger("ErrorDiagnosticsRetention");
  constructor(@Inject(DATABASE_TOKEN) private readonly db: any) {}
  onModuleInit() {
    diagnosticPolicy();
    this.timer = setInterval(() => {
      void this.tick();
    }, 3600000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.db.transaction(async (tx: any) => {
        await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
        await tx.execute(
          sql`UPDATE error_monitor_occurrences SET diagnostics=NULL WHERE id IN (SELECT id FROM error_monitor_occurrences WHERE diagnostics IS NOT NULL AND diagnostics_expires_at<=now() ORDER BY diagnostics_expires_at LIMIT 1000 FOR UPDATE SKIP LOCKED)`,
        );
        const days = diagnosticPolicy().retentionDays;
        await tx.execute(
          sql`UPDATE error_monitor_source_outbox SET payload=payload-'diagnostics' WHERE id IN (SELECT id FROM error_monitor_source_outbox WHERE payload ? 'diagnostics' AND created_at<now()-${days}*interval '1 day' LIMIT 500 FOR UPDATE SKIP LOCKED)`,
        );
      });
    } catch {
      this.logger.warn("Diagnostic retention cleanup pending; retry scheduled");
    } finally {
      this.busy = false;
    }
  }
}
