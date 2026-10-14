/**
 * Phase 21 Gen-3 recovery - unit tests (no production DB / no Mainnet).
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  PHASE21_GEN3_RECOVERY_APPLY_PHRASE,
  PHASE21_GEN2_RECOVERY_APPLY_PHRASE,
  __mintPhase21Gen3RecoveryApplyConfirmationForTests,
  assertPhase21Gen3RecoveryApplyConfirmation,
  assertPhase21Gen2RecoveryApplyConfirmation,
  isPhase21Gen3RecoveryApplyConfirmation,
} from '../src/phase21-ceremony-confirmations.js';
import { PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID } from '../src/phase21-canary-payout-plan.js';
import {
  PHASE21_GEN2_AUTHORIZATION_GENERATION,
  PHASE21_GEN2_CHAIN_RECON_MAX_AGE_MS,
  evaluatePhase21Gen2RecoveryEligibility,
} from '../src/phase21-gen2-recovery-plan.js';
import {
  PHASE21_GEN3_AUTHORIZATION_GENERATION,
  PHASE21_GEN3_CHAIN_RECON_MAX_AGE_MS,
  PHASE21_GEN3_RECOVERY_PUBLIC_ID,
  PHASE21_GEN3_RECOVERY_WITHDRAWAL_ID,
  PHASE21_GEN3_REQUIRED_PRIOR_ATTEMPT_COUNT,
  PHASE21_GEN3_TEMPORAL_HISTORY_ABSENT_STATUS,
  evaluatePhase21Gen3ChainReconciliationFreshness,
  evaluatePhase21Gen3ConsumedFailedPreRecovery,
  evaluatePhase21Gen3RecoveryEligibility,
  isPhase21Gen3AttemptShapeAccepted,
  isPhase21Gen3PriorWorkflowSafeToRestart,
  mintPhase21Gen3IndependentChainReconciliationForTests,
} from '../src/phase21-gen3-recovery-plan.js';
import {
  phase21CanaryManualDispatchIdempotencyKey,
  phase21ManualDispatchGenerationIdempotencyKey,
} from '../src/phase21-manual-dispatch-permit.js';
import { isPhase21CanaryPriorWorkflowSafeToRestart } from '../src/phase21-resume-canary-gates.js';

describe('phase21 Gen-3 recovery constants + phrases', () => {
  beforeEach(() => {
    process.env.ALEX_PHASE21_CEREMONY_TEST_HOOKS = '1';
  });

  it('Gen-3 binds to the same canary as Gen-2 with generation 3', () => {
    expect(PHASE21_GEN3_AUTHORIZATION_GENERATION).toBe(3);
    expect(PHASE21_GEN3_AUTHORIZATION_GENERATION).toBe(PHASE21_GEN2_AUTHORIZATION_GENERATION + 1);
    expect(PHASE21_GEN3_RECOVERY_WITHDRAWAL_ID).toBe(PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID);
    expect(PHASE21_GEN3_RECOVERY_PUBLIC_ID).toBe('WD-000001');
    expect(PHASE21_GEN3_REQUIRED_PRIOR_ATTEMPT_COUNT).toBe(2);
    expect(PHASE21_GEN3_CHAIN_RECON_MAX_AGE_MS).toBe(PHASE21_GEN2_CHAIN_RECON_MAX_AGE_MS);
    expect(PHASE21_GEN3_CHAIN_RECON_MAX_AGE_MS).toBe(15 * 60 * 1000);
  });

  it('Gen-3 APPLY phrase is distinct from Gen-2 and brands are not interchangeable', () => {
    expect(PHASE21_GEN3_RECOVERY_APPLY_PHRASE).toBe('APPLY_LOOTRA_PHASE21_GEN3_OWNER_RECOVERY_PERMIT');
    expect(PHASE21_GEN3_RECOVERY_APPLY_PHRASE).not.toBe(PHASE21_GEN2_RECOVERY_APPLY_PHRASE);

    const minted = __mintPhase21Gen3RecoveryApplyConfirmationForTests();
    expect(isPhase21Gen3RecoveryApplyConfirmation(minted)).toBe(true);
    expect(() => assertPhase21Gen3RecoveryApplyConfirmation(minted)).not.toThrow();
    // A Gen-3 confirmation never satisfies the Gen-2 brand (and vice versa).
    expect(() => assertPhase21Gen2RecoveryApplyConfirmation(minted)).toThrow(/Gen2/);
    // Forged plain objects with the right shape are refused.
    expect(() =>
      assertPhase21Gen3RecoveryApplyConfirmation({
        brand: 'Phase21Gen3RecoveryApplyConfirmation',
        phrase: PHASE21_GEN3_RECOVERY_APPLY_PHRASE,
        confirmedAt: new Date().toISOString(),
      }),
    ).toThrow(/Gen3/);
  });

  it('idempotency keys are generation-scoped (gen 3 differs from gen 1 and gen 2)', () => {
    const wid = PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID;
    const gen3 = phase21ManualDispatchGenerationIdempotencyKey(wid, 3);
    expect(gen3).toBe(`phase21.manual_dispatch.canary:${wid}:gen:3`);
    expect(gen3).not.toBe(phase21ManualDispatchGenerationIdempotencyKey(wid, 2));
    expect(gen3).not.toBe(phase21CanaryManualDispatchIdempotencyKey(wid));
  });
});

describe('phase21 Gen-3 recovery pure gates', () => {
  it('chain recon freshness: identical contract to Gen-2 (pass / stale / same-provider / missing)', () => {
    const fresh = mintPhase21Gen3IndependentChainReconciliationForTests();
    expect(evaluatePhase21Gen3ChainReconciliationFreshness(fresh).ok).toBe(true);
    expect(fresh.confidence).toBe('HIGH');
    expect(fresh.paymentObserved).toBe(false);
    expect(fresh.recipientUsdtTransferObserved).toBe(false);
    expect(fresh.providersIndependent).toBe(true);

    const stale = mintPhase21Gen3IndependentChainReconciliationForTests({
      performedAt: new Date(Date.now() - PHASE21_GEN3_CHAIN_RECON_MAX_AGE_MS - 1_000).toISOString(),
    });
    expect(evaluatePhase21Gen3ChainReconciliationFreshness(stale).reason).toBe(
      'chain_recon_stale_or_future',
    );
    expect(
      evaluatePhase21Gen3ChainReconciliationFreshness({
        ...fresh,
        primaryProviderKind: 'tonapi',
        secondaryProviderKind: 'tonapi',
      }).reason,
    ).toBe('provider_kinds_invalid');
    expect(
      evaluatePhase21Gen3ChainReconciliationFreshness({
        ...fresh,
        confidence: 'UNKNOWN' as unknown as 'HIGH',
      }).reason,
    ).toBe('confidence_not_high');
    expect(
      evaluatePhase21Gen3ChainReconciliationFreshness({
        ...fresh,
        paymentObserved: true as unknown as false,
      }).reason,
    ).toBe('payment_observed');
    expect(evaluatePhase21Gen3ChainReconciliationFreshness(null).reason).toBe(
      'chain_recon_missing',
    );
  });

  it('eligibility requires CONSUMED gen1 + CONSUMED gen2 + exactly two FAILED_PRE + chain recon', () => {
    const base = {
      withdrawalState: 'FAILED_PRE_BROADCAST',
      gen1PermitStatus: 'CONSUMED',
      gen2PermitStatus: 'CONSUMED',
      gen3PermitStatus: null as string | null,
      attemptCount: 2,
      failedPreAttemptCount: 2,
      signatureOrBroadcastEvidenceCount: 0,
      reservationHeld: true,
      settlementPresent: false,
      releasePresent: false,
      chainReconOk: true,
    };
    expect(evaluatePhase21Gen3RecoveryEligibility(base)).toEqual({
      eligible: true,
      reason: null,
    });
    expect(
      evaluatePhase21Gen3RecoveryEligibility({ ...base, gen3PermitStatus: 'ARMED' }).eligible,
    ).toBe(true);
    expect(
      evaluatePhase21Gen3RecoveryEligibility({ ...base, gen1PermitStatus: 'ARMED' }).reason,
    ).toBe('gen1_not_consumed');
    expect(
      evaluatePhase21Gen3RecoveryEligibility({ ...base, gen2PermitStatus: 'ARMED' }).reason,
    ).toBe('gen2_not_consumed');
    expect(
      evaluatePhase21Gen3RecoveryEligibility({ ...base, gen3PermitStatus: 'CANCELLED' }).reason,
    ).toBe('gen3_cancelled');
    // Gen-2 shape (one attempt) is NOT a Gen-3 shape.
    expect(
      evaluatePhase21Gen3RecoveryEligibility({
        ...base,
        attemptCount: 1,
        failedPreAttemptCount: 1,
      }).reason,
    ).toBe('prior_attempt_count_not_two');
    expect(
      evaluatePhase21Gen3RecoveryEligibility({
        ...base,
        attemptCount: 3,
        failedPreAttemptCount: 3,
      }).reason,
    ).toBe('prior_attempt_count_not_two');
    expect(
      evaluatePhase21Gen3RecoveryEligibility({ ...base, failedPreAttemptCount: 1 }).reason,
    ).toBe('non_failed_pre_attempts');
    expect(
      evaluatePhase21Gen3RecoveryEligibility({
        ...base,
        signatureOrBroadcastEvidenceCount: 1,
      }).reason,
    ).toBe('signature_or_broadcast_evidence');
    expect(
      evaluatePhase21Gen3RecoveryEligibility({ ...base, reservationHeld: false }).reason,
    ).toBe('reservation_not_held');
    expect(
      evaluatePhase21Gen3RecoveryEligibility({ ...base, settlementPresent: true }).reason,
    ).toBe('already_settled');
    expect(
      evaluatePhase21Gen3RecoveryEligibility({ ...base, releasePresent: true }).reason,
    ).toBe('already_released');
    expect(evaluatePhase21Gen3RecoveryEligibility({ ...base, chainReconOk: false }).reason).toBe(
      'chain_recon_required',
    );
    expect(
      evaluatePhase21Gen3RecoveryEligibility({ ...base, withdrawalState: 'CONFIRMED' }).reason,
    ).toBe('withdrawal_state_not_allowed');
  });

  it('a Gen-2-eligible shape is never Gen-3-eligible and vice versa', () => {
    const gen2Shape = {
      withdrawalState: 'FAILED_PRE_BROADCAST',
      gen1PermitStatus: 'CONSUMED',
      gen2PermitStatus: null,
      attemptCount: 1,
      failedPreAttemptCount: 1,
      signatureOrBroadcastEvidenceCount: 0,
      reservationHeld: true,
      settlementPresent: false,
      releasePresent: false,
      chainReconOk: true,
    };
    expect(evaluatePhase21Gen2RecoveryEligibility(gen2Shape).eligible).toBe(true);
    expect(
      evaluatePhase21Gen3RecoveryEligibility({
        ...gen2Shape,
        gen2PermitStatus: '',
        gen3PermitStatus: null,
      }).eligible,
    ).toBe(false);
  });

  it('attempt shape: exactly #1 and #2 FAILED_PRE with zero evidence (signed-but-lost ok only when nothing persisted)', () => {
    const ok = {
      attemptCount: 2,
      failedPreAttemptCount: 2,
      evidenceCount: 0,
      attempt1FailedPre: true,
      attempt2FailedPre: true,
    };
    expect(isPhase21Gen3AttemptShapeAccepted(ok)).toBe(true);
    expect(isPhase21Gen3AttemptShapeAccepted({ ...ok, evidenceCount: 1 })).toBe(false);
    expect(isPhase21Gen3AttemptShapeAccepted({ ...ok, attemptCount: 1, failedPreAttemptCount: 1 })).toBe(
      false,
    );
    expect(isPhase21Gen3AttemptShapeAccepted({ ...ok, attempt2FailedPre: false })).toBe(false);
    expect(isPhase21Gen3AttemptShapeAccepted({ ...ok, attempt1FailedPre: false })).toBe(false);
    expect(
      isPhase21Gen3AttemptShapeAccepted({ ...ok, attemptCount: 3, failedPreAttemptCount: 3 }),
    ).toBe(false);
  });

  it('resume gate: Gen-3 ARMED + CONSUMED gen1/gen2 + two FAILED_PRE + COMPLETED or durable Gen-2 terminal', () => {
    const base = {
      withdrawalState: 'FAILED_PRE_BROADCAST',
      gen1PermitStatus: 'CONSUMED',
      gen2PermitStatus: 'CONSUMED',
      gen3PermitStatus: 'ARMED',
      gen3AuthorizationGeneration: 3,
      attemptCount: 2,
      failedPreAttemptCount: 2,
      broadcastEvidenceCount: 0,
      priorWorkflowStatus: 'COMPLETED',
    };
    expect(evaluatePhase21Gen3ConsumedFailedPreRecovery(base)).toEqual({
      eligible: true,
      reason: null,
    });
    expect(
      evaluatePhase21Gen3ConsumedFailedPreRecovery({
        ...base,
        priorWorkflowStatus: PHASE21_GEN3_TEMPORAL_HISTORY_ABSENT_STATUS,
      }).eligible,
    ).toBe(true);
    expect(
      evaluatePhase21Gen3ConsumedFailedPreRecovery({ ...base, gen3PermitStatus: 'CONSUMED' })
        .reason,
    ).toBe('gen3_not_armed');
    expect(
      evaluatePhase21Gen3ConsumedFailedPreRecovery({ ...base, gen2PermitStatus: 'ARMED' }).reason,
    ).toBe('gen2_not_consumed');
    expect(
      evaluatePhase21Gen3ConsumedFailedPreRecovery({ ...base, gen3AuthorizationGeneration: 2 })
        .reason,
    ).toBe('gen3_generation_invalid');
    expect(
      evaluatePhase21Gen3ConsumedFailedPreRecovery({
        ...base,
        attemptCount: 1,
        failedPreAttemptCount: 1,
      }).reason,
    ).toBe('prior_attempt_count_not_two');
    expect(
      evaluatePhase21Gen3ConsumedFailedPreRecovery({ ...base, broadcastEvidenceCount: 1 }).reason,
    ).toBe('broadcast_evidence_exists');
    expect(
      evaluatePhase21Gen3ConsumedFailedPreRecovery({ ...base, priorWorkflowStatus: 'RUNNING' })
        .reason,
    ).toBe('prior_workflow_not_safe');
    expect(
      evaluatePhase21Gen3ConsumedFailedPreRecovery({ ...base, priorWorkflowStatus: '' }).reason,
    ).toBe('prior_workflow_not_safe');
  });

  it('safe-to-restart accepts durable Gen-2 terminal token only through the Gen-3 helper', () => {
    expect(isPhase21Gen3PriorWorkflowSafeToRestart(PHASE21_GEN3_TEMPORAL_HISTORY_ABSENT_STATUS)).toBe(
      true,
    );
    expect(isPhase21CanaryPriorWorkflowSafeToRestart(PHASE21_GEN3_TEMPORAL_HISTORY_ABSENT_STATUS)).toBe(
      false,
    );
    expect(isPhase21Gen3PriorWorkflowSafeToRestart('COMPLETED')).toBe(true);
    expect(isPhase21Gen3PriorWorkflowSafeToRestart('RUNNING')).toBe(false);
    expect(isPhase21Gen3PriorWorkflowSafeToRestart('CONTINUED_AS_NEW')).toBe(false);
    expect(isPhase21Gen3PriorWorkflowSafeToRestart('')).toBe(false);
  });
});
