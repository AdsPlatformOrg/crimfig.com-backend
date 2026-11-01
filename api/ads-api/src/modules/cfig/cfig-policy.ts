import { HousePolicy, policyLimits } from "./cfig-allocation";
import { BadRequestException, ConflictException } from "@nestjs/common";
export const CFIG_SCALE = 1_000_000n;
export const CFIG_HOLD_MS = 72 * 60 * 60 * 1000;
export interface CfigPolicy {
  version: string;
  termsVersion: string;
  effectiveFrom: string;
  houseRewards: HousePolicy;
}
export function units(value: unknown): bigint {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,17}$/.test(value))
    throw new BadRequestException("Positive integer micro-cfig units required");
  return BigInt(value);
}
export function parsePolicy(value: any): CfigPolicy {
  if (
    !value ||
    typeof value.effectiveFrom !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?Z$/.test(value.effectiveFrom) ||
    !Number.isFinite(Date.parse(value.effectiveFrom)) ||
    new Date(value.effectiveFrom).toISOString().slice(0, 10) !==
      value.effectiveFrom.slice(0, 10) ||
    !value.houseRewards
  )
    throw new BadRequestException(
      "Versioned approved-only House terms and UTC midnight effective date required",
    );
  policyLimits(value.houseRewards);
  if (
    value.version !== value.houseRewards.policyVersion ||
    value.termsVersion !== value.houseRewards.policyVersion
  )
    throw new BadRequestException(
      "Policy version must match canonical snapshot",
    );
  return {
    version: value.version,
    termsVersion: value.termsVersion,
    effectiveFrom: new Date(value.effectiveFrom).toISOString(),
    houseRewards: structuredClone(value.houseRewards),
  };
}
export function transition(
  kind: "clear" | "invalidate",
  pending: bigint,
  available: bigint,
  createdAt: Date,
  now: Date,
  independent: boolean,
  holdMs: number = CFIG_HOLD_MS,
) {
  if (
    !Number.isFinite(createdAt.getTime()) ||
    !Number.isFinite(now.getTime()) ||
    !Number.isFinite(holdMs) ||
    holdMs < CFIG_HOLD_MS ||
    pending < 0n ||
    available < 0n
  )
    throw new ConflictException("Ledger reconciliation failed");
  if (kind === "clear") {
    if (
      !independent ||
      now.getTime() - createdAt.getTime() < holdMs ||
      pending === 0n ||
      available !== 0n
    )
      throw new ConflictException(
        "Clearance needs 72 hours and independent audit",
      );
    return { pending: -pending, available: pending, invalid: 0n };
  }
  if (pending + available === 0n)
    throw new ConflictException("No unconverted reward to invalidate");
  return {
    pending: -pending,
    available: -available,
    invalid: pending + available,
  };
}
