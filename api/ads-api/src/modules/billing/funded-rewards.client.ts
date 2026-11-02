import {
  Injectable,
  ServiceUnavailableException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
@Injectable()
export class FundedRewardsClient {
  private readonly base: string;
  private readonly key: string;
  constructor(config: ConfigService) {
    const url = new URL(
      config.get<string>("BILLING_API_URL") || "http://127.0.0.1:3008/api/v1",
    );
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !["", "/api/v1"].includes(url.pathname.replace(/\/$/, ""))
    )
      throw new Error("Invalid Billing authority URL");
    this.base = url.origin + "/api/v1/ecosystem/reward-programs";
    this.key = config.get<string>("INTERNAL_ECOSYSTEM_KEY") || "";
  }
  async command(
    actorId: string,
    action:
      | "list"
      | "propose"
      | "approve"
      | "convert"
      | "receipt"
      | "recovery"
      | "options"
      | "prepareReconciliation"
      | "approveReconciliation",
    input: Record<string, unknown> = {},
  ) {
    if (!this.key)
      throw new ServiceUnavailableException(
        "Billing rewards authority unavailable",
      );
    try {
      const response = await fetch(this.base, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-key": this.key,
        },
        body: JSON.stringify({ actorId, action, input }),
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (response.status === 403)
        throw new ForbiddenException(
          "Billing rewards authority access required",
        );
      if (response.status === 409)
        throw new ConflictException(
          "Rewards eligibility, configuration or capacity changed",
        );
      const result: any = await response.json();
      if (!response.ok || result.status !== "success" || !result.data)
        throw new Error("Unconfirmed rewards receipt");
      if (action === "convert" || action === "receipt") {
        if (
          result.data.authorityVersion !== "rewards-program-v1" ||
          result.data.userId !== actorId ||
          result.data.requestId !== input.requestId ||
          (action === "convert" &&
            (result.data.allocationId !== input.allocationId ||
              result.data.policyId !== input.policyId))
        )
          throw new Error("Rewards receipt identity mismatch");
      }
      return result.data;
    } catch (error) {
      if (
        error instanceof ConflictException ||
        error instanceof ForbiddenException
      )
        throw error;
      throw new ServiceUnavailableException(
        "Rewards outcome unconfirmed; retry with the same request identity",
      );
    }
  }
}
