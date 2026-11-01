import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import { sql } from "drizzle-orm";
import { AdsStaffGrants } from "../security/ads-staff-grants";
import { CfigService } from "./cfig.service";
import { houseProgramRequested, utcWindow } from "./cfig-allocation";
import { randomUUID } from "crypto";
@Injectable()
export class CfigWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private logger = new Logger("CfigFinalization");
  constructor(
    private readonly cfig: CfigService,
    private readonly grants: AdsStaffGrants,
    @Inject("DATABASE_CONNECTION") private readonly db: any,
  ) {}
  onModuleInit() {
    if (
      houseProgramRequested() &&
      process.env.ADS_CFIG_FINALIZER_ENABLED === "true"
    ) {
      this.timer = setInterval(() => {
        void this.tick();
      }, 60000);
      this.timer.unref();
    }
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async tick() {
    if (
      this.busy ||
      !houseProgramRequested() ||
      process.env.ADS_CFIG_FINALIZER_ENABLED !== "true"
    )
      return;
    this.busy = true;
    try {
      const actor = process.env.ADS_CFIG_FINALIZER_ACTOR_ID ?? "";
      if (
        !/^[0-9a-f-]{36}$/i.test(actor) ||
        !this.grants
          .rolesFor(actor)
          .some((r) => r === "super_admin" || r === "ads_finance")
      )
        throw new Error("Configured financial finalizer identity required");
      const result = await this.db.execute(
        sql`SELECT status FROM users WHERE id=${actor}`,
      );
      if ((result.rows ?? result)[0]?.status !== "ACTIVE")
        throw new Error("Active finalizer account required");
      const day = await this.cfig.nextDay();
      if (day && new Date() >= utcWindow(day).cutoff)
        await this.cfig.finalize(actor, day, {
          requestId: randomUUID(),
          reason:
            "Scheduled chronological finalization of independently reviewed events",
        });
    } catch {
      this.logger.warn(
        "Virtual reward finalization pending; no completion or credit is inferred.",
      );
    } finally {
      this.busy = false;
    }
  }
}
