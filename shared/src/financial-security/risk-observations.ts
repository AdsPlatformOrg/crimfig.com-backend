import { IndependentAssessment, WithdrawalBinding, withdrawalDigest } from './authorization';
import { FINANCIAL_SECURITY_POLICY as policy } from './policy.config';

export interface IndependentFinancialObservation {
  digest: string; observedAt: number;
  clearedUsdCents: number; reservedUsdCents: number;
  providerFloatUsdCents: number;
  destinationVerifiedAt: number; lastAccountRecoveryAt: number | null;
  provenanceVerified: boolean; providerReconciled: boolean;
  auditHealthy: boolean; alertingHealthy: boolean; identityHealthy: boolean;
  frozen: boolean; elevatedRisk: boolean;
}

/** Inputs belong to the independently credentialed collector, never the public request body. */
export function assessFinancialObservation(binding: WithdrawalBinding, observation: IndependentFinancialObservation, now: number): IndependentAssessment {
  const digest = withdrawalDigest(binding);
  if (!observation || observation.digest !== digest || !Number.isSafeInteger(now)
    || !Number.isSafeInteger(observation.observedAt) || observation.observedAt > now
    || now - observation.observedAt > policy.assessmentLifetimeMs
    || [observation.clearedUsdCents, observation.reservedUsdCents, observation.providerFloatUsdCents]
      .some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error('Independent financial observation unavailable');
  const healthy = observation.providerReconciled === true && observation.auditHealthy === true
    && observation.alertingHealthy === true && observation.identityHealthy === true;
  return {
    digest, observedAt: observation.observedAt,
    clearedFundsVerified: observation.provenanceVerified === true
      && observation.clearedUsdCents >= binding.amountUsdCents
      && observation.reservedUsdCents >= binding.amountUsdCents,
    protectionHealthy: healthy, frozen: observation.frozen !== false,
    risk: healthy ? observation.elevatedRisk === true ? 'elevated' : 'standard' : 'deny',
    destinationVerifiedAt: observation.destinationVerifiedAt, lastAccountRecoveryAt: observation.lastAccountRecoveryAt,
    ownerDayUsdCents: 0, destinationDayUsdCents: 0, platformHourUsdCents: 0,
    platformDayUsdCents: 0, outstandingUsdCents: 0, hotFloatUsdCents: observation.providerFloatUsdCents,
  };
}
