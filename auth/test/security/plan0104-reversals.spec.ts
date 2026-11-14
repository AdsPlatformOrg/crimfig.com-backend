import { NANO_CENT, evidenceSignature } from '../../../shared/src/ad-authority-policy';
import {
  computeCarryRebateAdjustments,
  computeCarryRestoreAdjustments,
  verifyAssessmentRecord,
} from '../../../api/ads-api/src/event-cash-rebate-reconciliation';

describe('PLAN-0104 reversal unit invariants', () => {
  const signingEnv = {
    ADS_EVIDENCE_HASH_SECRET: 'plan0104-unit-test-evidence-signing-secret-32b',
    ADS_EVIDENCE_HASH_KEY_ID: 'evidence-v1',
  } as unknown as NodeJS.ProcessEnv;

  const baseAssessment = {
    id: '11111111-1111-4111-8111-111111111111',
    eventId: '22222222-2222-4222-8222-222222222222',
    campaignId: '33333333-3333-4333-8333-333333333333',
    requestId: '44444444-4444-4444-8444-444444444444',
    actorId: '55555555-5555-4555-8555-555555555555',
    policyVersion: 'policy-v1',
    outcome: 'invalid',
    reasonCodes: ['cpc_redirect_mismatch'],
    features: { integrity: true },
    supersedesId: null,
    keyId: 'evidence-v1',
  };

  it('rejects forged or mismatched assessment signatures before accepting valid evidence', () => {
    const validHash = evidenceSignature(baseAssessment, signingEnv);

    expect(
      verifyAssessmentRecord({ ...baseAssessment, outcome: 'eligible', recordHash: validHash }, signingEnv),
    ).toBe(false);
    expect(
      verifyAssessmentRecord({ ...baseAssessment, keyId: 'rotated-wrong', recordHash: validHash }, signingEnv),
    ).toBe(false);
    expect(
      verifyAssessmentRecord({ ...baseAssessment, recordHash: '0'.repeat(64) }, signingEnv),
    ).toBe(false);
    expect(
      verifyAssessmentRecord({ ...baseAssessment, recordHash: 'not-hex' }, signingEnv),
    ).toBe(false);
    expect(
      verifyAssessmentRecord({ ...baseAssessment, recordHash: validHash }, {} as NodeJS.ProcessEnv),
    ).toBe(false);

    expect(
      verifyAssessmentRecord({ ...baseAssessment, recordHash: validHash }, signingEnv),
    ).toBe(true);
  });

  it('rejects negative, overflow, or insufficient settlement carry inputs', () => {
    expect(() =>
      computeCarryRebateAdjustments(
        { carryNanos: 0n, billedUsdCents: 100, publisherUsdCents: 55, commissionPoolUsdCents: 15 },
        -1n,
      ),
    ).toThrow(/invariant violated/i);

    expect(() =>
      computeCarryRebateAdjustments(
        { carryNanos: NANO_CENT, billedUsdCents: 100, publisherUsdCents: 55, commissionPoolUsdCents: 15 },
        10_000_000n,
      ),
    ).toThrow(/invariant violated/i);

    expect(() =>
      computeCarryRebateAdjustments(
        { carryNanos: 5_000_000n, billedUsdCents: 1, publisherUsdCents: 0, commissionPoolUsdCents: 0 },
        20_000_000n,
      ),
    ).toThrow(/exceed remaining carry balance/i);

    expect(() =>
      computeCarryRestoreAdjustments(
        { carryNanos: -1n, billedUsdCents: 10, publisherUsdCents: 5, commissionPoolUsdCents: 1 },
        10_000_000n,
      ),
    ).toThrow(/invariant violated/i);

    expect(() =>
      computeCarryRestoreAdjustments(
        { carryNanos: 0n, billedUsdCents: 2_147_483_647, publisherUsdCents: 1_181_116_005, commissionPoolUsdCents: 322_122_547 },
        NANO_CENT,
      ),
    ).toThrow(/overflow/i);
  });

  it('computes exact 55/30/15 rebates and symmetric overturn restores across whole and fractional nanos', () => {
    // Whole click: $2.00 = 200 cents -> 55% = 110, 15% = 30, 30% = 60.
    const wholeRebate = computeCarryRebateAdjustments(
      { carryNanos: 0n, billedUsdCents: 400, publisherUsdCents: 220, commissionPoolUsdCents: 60 },
      200n * NANO_CENT,
    );
    expect(wholeRebate).toEqual({
      rebateCents: 200,
      publisherReversalCents: 110,
      commissionReversalCents: 30,
      baseReversalCents: 60,
      nextBilled: 200,
      nextCarryNanos: 0n,
      nextPublisher: 110,
      nextCommission: 30,
    });

    const wholeRestore = computeCarryRestoreAdjustments(
      {
        carryNanos: wholeRebate.nextCarryNanos,
        billedUsdCents: wholeRebate.nextBilled,
        publisherUsdCents: wholeRebate.nextPublisher,
        commissionPoolUsdCents: wholeRebate.nextCommission,
      },
      200n * NANO_CENT,
    );
    expect(wholeRestore).toEqual({
      debitCents: 200,
      publisherRestoreCents: 110,
      commissionRestoreCents: 30,
      baseRestoreCents: 60,
      nextBilled: 400,
      nextCarryNanos: 0n,
      nextPublisher: 220,
      nextCommission: 60,
    });

    // Fractional nanos: two 1.5c claims = 30_000_000n -> billed 3c, publisher 1c, commission 0c, carry 0n.
    const fractionalRebate = computeCarryRebateAdjustments(
      { carryNanos: 0n, billedUsdCents: 3, publisherUsdCents: 1, commissionPoolUsdCents: 0 },
      15_000_000n,
    );
    expect(fractionalRebate).toEqual({
      rebateCents: 2,
      publisherReversalCents: 1,
      commissionReversalCents: 0,
      baseReversalCents: 1,
      nextBilled: 1,
      nextCarryNanos: 5_000_000n,
      nextPublisher: 0,
      nextCommission: 0,
    });

    const fractionalRestore = computeCarryRestoreAdjustments(
      {
        carryNanos: fractionalRebate.nextCarryNanos,
        billedUsdCents: fractionalRebate.nextBilled,
        publisherUsdCents: fractionalRebate.nextPublisher,
        commissionPoolUsdCents: fractionalRebate.nextCommission,
      },
      15_000_000n,
    );
    expect(fractionalRestore).toEqual({
      debitCents: 2,
      publisherRestoreCents: 1,
      commissionRestoreCents: 0,
      baseRestoreCents: 1,
      nextBilled: 3,
      nextCarryNanos: 0n,
      nextPublisher: 1,
      nextCommission: 0,
    });

    // Sub-cent claim below the current carry: adjusts carryNanos cleanly with zero cent rebate.
    const subCentRebate = computeCarryRebateAdjustments(
      { carryNanos: 5_000_000n, billedUsdCents: 1, publisherUsdCents: 0, commissionPoolUsdCents: 0 },
      5_000_000n,
    );
    expect(subCentRebate).toEqual({
      rebateCents: 0,
      publisherReversalCents: 0,
      commissionReversalCents: 0,
      baseReversalCents: 0,
      nextBilled: 1,
      nextCarryNanos: 0n,
      nextPublisher: 0,
      nextCommission: 0,
    });
  });
});

