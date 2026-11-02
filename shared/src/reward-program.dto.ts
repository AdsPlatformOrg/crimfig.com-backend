import {
  IsUUID,
  IsString,
  IsIn,
  IsISO8601,
  Matches,
  MaxLength,
  MinLength,
  IsOptional,
} from "class-validator";
export class RewardRequestDto {
  @IsUUID() requestId!: string;
}
export class ConversionDto extends RewardRequestDto {
  @IsUUID() allocationId!: string;
  @IsUUID() policyId!: string;
  @Matches(/^[1-9][0-9]{0,17}$/) microCfig!: string;
}
export class AllocationDto extends RewardRequestDto {
  @IsUUID() proofId!: string;
  @IsIn(["paid_performance", "house_conversion"]) program!: string;
  @Matches(/^[1-9][0-9]{0,17}$/) amountCents!: string;
  @IsISO8601() effectiveFrom!: string;
  @IsOptional() @IsUUID() housePolicyId?: string;
  @IsOptional() @Matches(/^[1-9][0-9]{0,17}$/) cfigPerPoint?: string;
}
export class PaidDto extends RewardRequestDto {
  @IsUUID() allocationId!: string;
}
export class ClearanceDto extends RewardRequestDto {
  @IsUUID() proofId!: string;
}
export class RecoveryDto extends RewardRequestDto {
  @IsUUID() issueId!: string;
  @IsUUID() evidenceId!: string;
  @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

export class ReconciliationDto extends RewardRequestDto {
  @IsIn(["backing", "clearance"]) kind!: string;
  @IsUUID() sourceId!: string;
  @IsString() @MinLength(3) @MaxLength(500) reason!: string;
  @IsISO8601() expiresAt!: string;
}
