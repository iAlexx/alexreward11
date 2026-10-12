/**
 * Phase 21 Gen-2 recovery — unit tests (no production DB / no Mainnet).
 */
import { describe, expect, it } from 'vitest';

import {
  evaluatePhase21Gen2ChainReconciliationFreshness,
  evaluatePhase21Gen2RecoveryEligibility,
  mintPhase21Gen2IndependentChainReconciliationForTests,
  PHASE21_GEN2_AUTHORIZATION_GENERATION,
  PHASE21_GEN2_CHAIN_RECON_MAX_AGE_MS,
} from '../src/phase21-gen2-recovery-plan.js';
import { evaluatePhase21Gen2ConsumedFailedPreRecovery } from '../src/phase21-resume-canary-gates.js';
import {
  phase21ManualDispatchGenerationIdempotencyKey,
  phase21CanaryManualDispatchIdempotencyKey,
} from '../src/phase21-manual-dispatch-permit.js';
import { PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID } from '../src/phase21-canary-payout-plan.js';

describe('phase21 Gen-2 recovery pure gates', () => {
  it('idempotency keys are generation-scoped', () => {
    const wid = PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID;
    expect(phase21ManualDispatchGenerationIdempotencyKey(wid, 1)).toBe(
      phase21CanaryManualDispatchIdempotencyKey(wid),
    );
    expect(phase21ManualDispatchGenerationIdempotencyKey(wid, 2)).toBe(
      `phase21.manual_dispatch.canary:${wid}:gen:2`,
    );
    expect(phase21ManualDispatchGenerationIdempotencyKey(wid, 2)).not.toBe(
      phase21CanaryManualDispatchIdempotencyKey(wid),
    );
  });

  it('chain recon freshness: pass / stale / payment / same-provider', () => {
    const fresh = mintPhase21Gen2IndependentChainReconciliationForTests();
    expect(evaluatePhase21Gen2ChainReconciliationFreshness(fresh).ok).toBe(true);

    const stale = mintPhase21Gen2IndependentChainReconciliationForTests({
      performedAt: new Date(Date.now() - PHASE21_GEN2_CHAIN_RECON_MAX_AGE_MS - 1_000).toISOString(),
    });
    expect(evaluatePhase21Gen2ChainReconciliationFreshness(stale).reason).toBe(
      'chain_recon_stale_or_future',
    );

    expect(
      evaluatePhase21Gen2ChainReconciliationFreshness({
        ...fresh,
        primaryProviderKind: 'tonapi',
        secondaryProviderKind: 'tonapi',
      }).reason,
    ).toBe('provider_kinds_invalid');

    expect(evaluatePhase21Gen2ChainReconciliationFreshness(null).reason).toBe(
      'chain_recon_missing',
    );
  });

  it('eligibility requires CONSUMED gen1 + FAILED_PRE-only + chain recon', () => {
    const base = {
      withdrawalState: 'FAILED_PRE_BROADCAST',
      gen1PermitStatus: 'CONSUMED',
      gen2PermitStatus: null as string | null,
      attemptCount: 1,
      failedPreAttemptCount: 1,
      signatureOrBroadcastEvidenceCount: 0,
      reservationHeld: true,
      settlementPresent: false,
      releasePresent: false,
      chainReconOk: true,
    };
    expect(evaluatePhase21Gen2RecoveryEligibility(base)).toEqual({
      eligible: true,
      reason: null,
    });
    expect(
      evaluatePhase21Gen2RecoveryEligibility({ ...base, gen1PermitStatus: 'ARMED' }).eligible,
    ).toBe(false);
    expect(
      evaluatePhase21Gen2RecoveryEligibility({
        ...base,
        signatureOrBroadcastEvidenceCount: 1,
      }).reason,
    ).toBe('signature_or_broadcast_evidence');
    expect(
      evaluatePhase21Gen2RecoveryEligibility({ ...base, settlementPresent: true }).reason,
    ).toBe('already_settled');
    expect(evaluatePhase21Gen2RecoveryEligibility({ ...base, chainReconOk: false }).reason).toBe(
      'chain_recon_required',
    );
  });

  it('resume gate: Gen-2 ARMED + CONSUMED gen1 + FAILED_PRE + COMPLETED', () => {
    expect(PHASE21_GEN2_AUTHORIZATION_GENERATION).toBe(2);
    expect(
      evaluatePhase21Gen2ConsumedFailedPreRecovery({
        withdrawalState: 'FAILED_PRE_BROADCAST',
        gen1PermitStatus: 'CONSUMED',
        gen2PermitStatus: 'ARMED',
        gen2AuthorizationGeneration: 2,
        attemptCount: 1,
        failedPreAttemptCount: 1,
        broadcastEvidenceCount: 0,
        priorWorkflowStatus: 'COMPLETED',
      }),
    ).toEqual({ eligible: true, reason: null });

    expect(
      evaluatePhase21Gen2ConsumedFailedPreRecovery({
        withdrawalState: 'FAILED_PRE_BROADCAST',
        gen1PermitStatus: 'CONSUMED',
        gen2PermitStatus: 'CONSUMED',
        gen2AuthorizationGeneration: 2,
        attemptCount: 1,
        failedPreAttemptCount: 1,
        broadcastEvidenceCount: 0,
        priorWorkflowStatus: 'COMPLETED',
      }).eligible,
    ).toBe(false);

    expect(
      evaluatePhase21Gen2ConsumedFailedPreRecovery({
        withdrawalState: 'FAILED_PRE_BROADCAST',
        gen1PermitStatus: 'CONSUMED',
        gen2PermitStatus: 'ARMED',
        gen2AuthorizationGeneration: 2,
        attemptCount: 1,
        failedPreAttemptCount: 1,
        broadcastEvidenceCount: 1,
        priorWorkflowStatus: 'COMPLETED',
      }).reason,
    ).toBe('broadcast_evidence_exists');
  });
});
