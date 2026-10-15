/**
 * Phase 21 Gen-4 recovery - unit tests (no production DB / no Mainnet / no Temporal).
 *
 * PLAN / APPLY / claim-binding are exercised against the in-memory SQL-pattern mock in
 * phase21-gen4-mock-db.ts (DB-backed coverage lives in the *.db.test.ts files).
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { WITHDRAWAL_PHASE21_MANUAL_DISPATCH_OUTBOX_EVENT } from '../src/outbox.js';
import {
  PHASE21_GEN3_RECOVERY_APPLY_PHRASE,
  PHASE21_GEN4_RECOVERY_APPLY_PHRASE,
  __mintPhase21Gen3RecoveryApplyConfirmationForTests,
  __mintPhase21Gen4RecoveryApplyConfirmationForTests,
  assertPhase21Gen3RecoveryApplyConfirmation,
  assertPhase21Gen4RecoveryApplyConfirmation,
  isPhase21Gen4RecoveryApplyConfirmation,
} from '../src/phase21-ceremony-confirmations.js';
import { PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID } from '../src/phase21-canary-payout-plan.js';
import {
  PHASE21_GEN2_CHAIN_RECON_MAX_AGE_MS,
} from '../src/phase21-gen2-recovery-plan.js';
import { PHASE21_GEN3_AUTHORIZATION_GENERATION } from '../src/phase21-gen3-recovery-plan.js';
import {
  readPhase21Gen3TemporalLaunchClaimPresent,
  verifyPhase21Gen3TemporalLaunchClaimBinding,
} from '../src/phase21-gen3-temporal-launch.js';
import { applyPhase21Gen4Recovery } from '../src/phase21-gen4-recovery-apply.js';
import {
  PHASE21_GEN4_AUTHORIZATION_GENERATION,
  PHASE21_GEN4_CANARY_HOT_WALLET_FRIENDLY,
  PHASE21_GEN4_CANARY_USDT_JETTON_MASTER,
  PHASE21_GEN4_CHAIN_RECON_MAX_AGE_MS,
  PHASE21_GEN4_EXTERNAL_PROVIDER_ATTESTATION_PHRASE,
  verifyPhase21Gen4ExactPermitAttemptBindings,
  PHASE21_GEN4_RECOVERY_PUBLIC_ID,
  PHASE21_GEN4_RECOVERY_WITHDRAWAL_ID,
  PHASE21_GEN4_REQUIRED_PRIOR_ATTEMPT_COUNT,
  PHASE21_GEN4_TEMPORAL_HISTORY_ABSENT_STATUS,
  evaluatePhase21Gen4ChainReconciliationFreshness,
  evaluatePhase21Gen4ConsumedFailedPreRecovery,
  evaluatePhase21Gen4RecoveryEligibility,
  isPhase21Gen4AttemptShapeAccepted,
  isPhase21Gen4PriorWorkflowSafeToRestart,
  mintPhase21Gen4IndependentChainReconciliationForTests,
  planPhase21Gen4Recovery,
  readPhase21Gen4AttemptShape,
  type Phase21Gen4IndependentChainReconciliation,
} from '../src/phase21-gen4-recovery-plan.js';
import { PHASE21_CANARY_FROZEN_JETTON_MASTER } from '../src/phase21-manual-dispatch-permit.js';
import {
  phase21CanaryManualDispatchIdempotencyKey,
  phase21ManualDispatchGenerationIdempotencyKey,
} from '../src/phase21-manual-dispatch-permit.js';
import { isPhase21CanaryPriorWorkflowSafeToRestart } from '../src/phase21-resume-canary-gates.js';
import { mintAuthenticatedPhase21OwnerCeremonyTrustForTests } from '../src/test-only/phase21-ceremony-test-hooks.js';
import {
  ADMIN_ID,
  GEN3_PERMIT_ID,
  GEN4_PERMIT_ID,
  WID,
  createGen4World,
  gen3ClaimKey,
  gen3ClaimPayload,
  mockGen4Client,
  type Gen4MockWorld,
} from './phase21-gen4-mock-db.js';

const NOW_RECON = () => mintPhase21Gen4IndependentChainReconciliationForTests();

type MockClient = ReturnType<typeof mockGen4Client>;
const asPg = (c: MockClient) => c as never;

function setClaimPayload(world: Gen4MockWorld, patch: Record<string, unknown>): void {
  const row = world.outbox.get(gen3ClaimKey());
  if (row === undefined) throw new Error('fixture: gen3 claim missing');
  row.payload = gen3ClaimPayload(patch);
}

describe('phase21 Gen-4 recovery constants + phrases', () => {
  beforeEach(() => {
    process.env.ALEX_PHASE21_CEREMONY_TEST_HOOKS = '1';
  });

  it('Gen-4 binds to the same canary with generation 4 and exactly three prior attempts', () => {
    expect(PHASE21_GEN4_AUTHORIZATION_GENERATION).toBe(4);
    expect(PHASE21_GEN4_AUTHORIZATION_GENERATION).toBe(PHASE21_GEN3_AUTHORIZATION_GENERATION + 1);
    expect(PHASE21_GEN4_RECOVERY_WITHDRAWAL_ID).toBe(PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID);
    expect(PHASE21_GEN4_RECOVERY_PUBLIC_ID).toBe('WD-000001');
    expect(PHASE21_GEN4_REQUIRED_PRIOR_ATTEMPT_COUNT).toBe(3);
    expect(PHASE21_GEN4_CHAIN_RECON_MAX_AGE_MS).toBe(PHASE21_GEN2_CHAIN_RECON_MAX_AGE_MS);
    expect(PHASE21_GEN4_CHAIN_RECON_MAX_AGE_MS).toBe(15 * 60 * 1000);
    expect(PHASE21_GEN4_TEMPORAL_HISTORY_ABSENT_STATUS).toBe(
      'TEMPORAL_HISTORY_ABSENT_DURABLE_GEN3_TERMINAL',
    );
    expect(PHASE21_GEN4_CANARY_HOT_WALLET_FRIENDLY).toBe(
      'EQD4NWgFbqCOIGQL9k0SDIP8onQH9cj_MxDcBr3N7DYLy8Lf',
    );
    expect(PHASE21_GEN4_CANARY_USDT_JETTON_MASTER).toBe(
      'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs',
    );
    expect(PHASE21_GEN4_CANARY_USDT_JETTON_MASTER).toBe(PHASE21_CANARY_FROZEN_JETTON_MASTER);
  });

  it('Gen-4 APPLY phrase is distinct from Gen-3 and brands are not interchangeable', () => {
    expect(PHASE21_GEN4_RECOVERY_APPLY_PHRASE).toBe('APPLY_LOOTRA_PHASE21_GEN4_OWNER_RECOVERY_PERMIT');
    expect(PHASE21_GEN4_RECOVERY_APPLY_PHRASE).not.toBe(PHASE21_GEN3_RECOVERY_APPLY_PHRASE);

    const minted = __mintPhase21Gen4RecoveryApplyConfirmationForTests();
    expect(isPhase21Gen4RecoveryApplyConfirmation(minted)).toBe(true);
    expect(() => assertPhase21Gen4RecoveryApplyConfirmation(minted)).not.toThrow();
    // Gen-4 never satisfies the Gen-3 brand, and Gen-3 never satisfies Gen-4.
    expect(() => assertPhase21Gen3RecoveryApplyConfirmation(minted)).toThrow(/Gen3/);
    expect(() =>
      assertPhase21Gen4RecoveryApplyConfirmation(
        __mintPhase21Gen3RecoveryApplyConfirmationForTests(),
      ),
    ).toThrow(/Gen4/);
    // Forged plain objects with the right shape are refused.
    expect(() =>
      assertPhase21Gen4RecoveryApplyConfirmation({
        brand: 'Phase21Gen4RecoveryApplyConfirmation',
        phrase: PHASE21_GEN4_RECOVERY_APPLY_PHRASE,
        confirmedAt: new Date().toISOString(),
      }),
    ).toThrow(/Gen4/);
  });

  it('Gen-4 test mint requires the ceremony test hook', () => {
    delete process.env.ALEX_PHASE21_CEREMONY_TEST_HOOKS;
    expect(() => __mintPhase21Gen4RecoveryApplyConfirmationForTests()).toThrow();
  });

  it('idempotency keys are generation-scoped (gen 4 differs from gens 1-3)', () => {
    const gen4 = phase21ManualDispatchGenerationIdempotencyKey(WID, 4);
    expect(gen4).toBe(`phase21.manual_dispatch.canary:${WID}:gen:4`);
    expect(gen4).not.toBe(phase21ManualDispatchGenerationIdempotencyKey(WID, 3));
    expect(gen4).not.toBe(phase21ManualDispatchGenerationIdempotencyKey(WID, 2));
    expect(gen4).not.toBe(phase21CanaryManualDispatchIdempotencyKey(WID));
  });
});

describe('phase21 Gen-4 chain reconciliation contract (gate 2)', () => {
  it('passes a fresh, fully bound dual-provider HIGH no-payment recon', () => {
    const fresh = NOW_RECON();
    expect(evaluatePhase21Gen4ChainReconciliationFreshness(fresh)).toEqual({ ok: true, reason: null });
    expect(fresh.primaryProviderKind).toBe('toncenter');
    expect(fresh.secondaryProviderKind).toBe('tonapi');
    expect(fresh.priorQueryIds).toHaveLength(3);
  });

  const cases: ReadonlyArray<
    readonly [string, (e: Phase21Gen4IndependentChainReconciliation) => unknown, string]
  > = [
    ['null evidence', () => null, 'chain_recon_missing'],
    ['providers not independent', (e) => ({ ...e, providersIndependent: false }), 'providers_not_independent'],
    ['payment observed', (e) => ({ ...e, paymentObserved: true }), 'payment_observed'],
    [
      'recipient USDT transfer observed',
      (e) => ({ ...e, recipientUsdtTransferObserved: true }),
      'recipient_usdt_transfer_observed',
    ],
    ['non-HIGH confidence', (e) => ({ ...e, confidence: 'MEDIUM' }), 'confidence_not_high'],
    [
      'swapped provider kinds',
      (e) => ({ ...e, primaryProviderKind: 'tonapi', secondaryProviderKind: 'toncenter' }),
      'provider_kinds_invalid',
    ],
    [
      'hotWalletAccountActive missing',
      (e) => ({ ...e, hotWalletAccountActive: undefined }),
      'hot_wallet_account_active_missing',
    ],
    ['empty detail', (e) => ({ ...e, detail: '  ' }), 'detail_missing'],
    ['hot wallet missing', (e) => ({ ...e, hotWalletFriendly: '' }), 'hot_wallet_missing'],
    [
      'hot wallet friendly mismatch',
      (e) => ({ ...e, hotWalletFriendly: 'EQ_not_the_canary_hot_wallet' }),
      'hot_wallet_mismatch',
    ],
    [
      'hot wallet raw mismatch',
      (e) => ({ ...e, hotWalletRaw: '0:deadbeef' }),
      'hot_wallet_mismatch',
    ],
    ['recipient missing', (e) => ({ ...e, recipientRaw: '' }), 'recipient_missing'],
    ['recipient mismatch', (e) => ({ ...e, recipientFriendly: 'EQ_someone_else' }), 'recipient_mismatch'],
    ['jetton master missing', (e) => ({ ...e, usdtJettonMaster: '' }), 'usdt_jetton_master_missing'],
    [
      'jetton master mismatch',
      (e) => ({ ...e, usdtJettonMaster: 'EQ_not_usdt' }),
      'usdt_jetton_master_mismatch',
    ],
    ['net amount missing', (e) => ({ ...e, netAmountAtomic: '' }), 'net_amount_missing'],
    ['net amount mismatch', (e) => ({ ...e, netAmountAtomic: '190001' }), 'net_amount_mismatch'],
    ['priorQueryIds absent', (e) => ({ ...e, priorQueryIds: undefined }), 'prior_query_ids_missing'],
    ['two query ids', (e) => ({ ...e, priorQueryIds: ['1', '2'] }), 'prior_query_ids_wrong_count'],
    [
      'four query ids',
      (e) => ({ ...e, priorQueryIds: ['1', '2', '3', '4'] }),
      'prior_query_ids_wrong_count',
    ],
    ['blank query id', (e) => ({ ...e, priorQueryIds: ['1', '', '3'] }), 'prior_query_ids_invalid'],
    [
      'duplicate query ids',
      (e) => ({ ...e, priorQueryIds: ['1', '1', '3'] }),
      'prior_query_ids_not_distinct',
    ],
    [
      'attestation missing (JSON HIGH labels alone are insufficient)',
      (e) => ({ ...e, externalProviderObservationAttestation: undefined }),
      'external_attestation_missing',
    ],
    [
      'attestation null',
      (e) => ({ ...e, externalProviderObservationAttestation: null }),
      'external_attestation_missing',
    ],
    [
      'attestation kind wrong',
      (e) => ({
        ...e,
        externalProviderObservationAttestation: {
          ...e.externalProviderObservationAttestation,
          kind: 'SOMETHING_ELSE',
        },
      }),
      'external_attestation_kind_invalid',
    ],
    [
      'attestation phrase wrong',
      (e) => ({
        ...e,
        externalProviderObservationAttestation: {
          ...e.externalProviderObservationAttestation,
          phrase: 'I_ATTEST_WD_000001_GEN3_INDEPENDENT_TONCENTER_TONAPI_NO_PAYMENT',
        },
      }),
      'external_attestation_phrase_invalid',
    ],
    [
      'attestation provider kinds swapped',
      (e) => ({
        ...e,
        externalProviderObservationAttestation: {
          ...e.externalProviderObservationAttestation,
          primaryProviderKind: 'tonapi',
          secondaryProviderKind: 'toncenter',
        },
      }),
      'external_attestation_provider_kinds_invalid',
    ],
    [
      'attestation digest empty',
      (e) => ({
        ...e,
        externalProviderObservationAttestation: {
          ...e.externalProviderObservationAttestation,
          primaryObservationDigest: '',
        },
      }),
      'external_attestation_digest_invalid',
    ],
    [
      'attestation digest too short',
      (e) => ({
        ...e,
        externalProviderObservationAttestation: {
          ...e.externalProviderObservationAttestation,
          secondaryObservationDigest: 'short',
        },
      }),
      'external_attestation_digest_invalid',
    ],
    [
      'attestation digests identical',
      (e) => ({
        ...e,
        externalProviderObservationAttestation: {
          ...e.externalProviderObservationAttestation,
          secondaryObservationDigest:
            e.externalProviderObservationAttestation.primaryObservationDigest,
        },
      }),
      'external_attestation_digests_not_distinct',
    ],
    [
      'attestedAt unparseable',
      (e) => ({
        ...e,
        externalProviderObservationAttestation: {
          ...e.externalProviderObservationAttestation,
          attestedAt: 'not-a-date',
        },
      }),
      'external_attestation_stale_or_future',
    ],
  ];

  it.each(cases)('refuses: %s', (_name, mutate, reason) => {
    const evidence = mutate(NOW_RECON()) as Phase21Gen4IndependentChainReconciliation;
    expect(evaluatePhase21Gen4ChainReconciliationFreshness(evidence)).toEqual({ ok: false, reason });
  });

  it('refuses stale and future-dated evidence', () => {
    const stale = mintPhase21Gen4IndependentChainReconciliationForTests({
      performedAt: new Date(Date.now() - PHASE21_GEN4_CHAIN_RECON_MAX_AGE_MS - 1_000).toISOString(),
    });
    expect(evaluatePhase21Gen4ChainReconciliationFreshness(stale).reason).toBe(
      'chain_recon_stale_or_future',
    );
    const future = mintPhase21Gen4IndependentChainReconciliationForTests({
      performedAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    expect(evaluatePhase21Gen4ChainReconciliationFreshness(future).reason).toBe(
      'chain_recon_stale_or_future',
    );
    expect(
      mintPhase21Gen4IndependentChainReconciliationForTests({ performedAt: 'not-a-date' }),
    ).toBeDefined();
    expect(
      evaluatePhase21Gen4ChainReconciliationFreshness(
        mintPhase21Gen4IndependentChainReconciliationForTests({ performedAt: 'not-a-date' }),
      ).ok,
    ).toBe(false);
  });

  it('attestation must be fresh: stale and future attestedAt refuse; overrides via mint work', () => {
    const stale = mintPhase21Gen4IndependentChainReconciliationForTests({
      attestedAt: new Date(Date.now() - PHASE21_GEN4_CHAIN_RECON_MAX_AGE_MS - 1_000).toISOString(),
    });
    expect(evaluatePhase21Gen4ChainReconciliationFreshness(stale).reason).toBe(
      'external_attestation_stale_or_future',
    );
    const future = mintPhase21Gen4IndependentChainReconciliationForTests({
      attestedAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    expect(evaluatePhase21Gen4ChainReconciliationFreshness(future).reason).toBe(
      'external_attestation_stale_or_future',
    );
    const sameDigest = mintPhase21Gen4IndependentChainReconciliationForTests({
      primaryObservationDigest: 'identical-digest-0000',
      secondaryObservationDigest: 'identical-digest-0000',
    });
    expect(evaluatePhase21Gen4ChainReconciliationFreshness(sameDigest).reason).toBe(
      'external_attestation_digests_not_distinct',
    );
    const wrongPhrase = mintPhase21Gen4IndependentChainReconciliationForTests({
      attestation: { phrase: 'nope' as never },
    });
    expect(evaluatePhase21Gen4ChainReconciliationFreshness(wrongPhrase).reason).toBe(
      'external_attestation_phrase_invalid',
    );
  });

  it('minted evidence carries the exact attestation; JSON HIGH labels without it never pass', () => {
    const fresh = NOW_RECON();
    expect(fresh.externalProviderObservationAttestation).toMatchObject({
      kind: 'OWNER_ATTESTED_INDEPENDENT_TONCENTER_TONAPI_OBSERVATION',
      phrase: PHASE21_GEN4_EXTERNAL_PROVIDER_ATTESTATION_PHRASE,
      primaryProviderKind: 'toncenter',
      secondaryProviderKind: 'tonapi',
    });
    expect(PHASE21_GEN4_EXTERNAL_PROVIDER_ATTESTATION_PHRASE).toBe(
      'I_ATTEST_WD_000001_GEN4_INDEPENDENT_TONCENTER_TONAPI_NO_PAYMENT',
    );
    const { externalProviderObservationAttestation: _drop, ...labelsOnly } = fresh;
    void _drop;
    expect(
      evaluatePhase21Gen4ChainReconciliationFreshness(
        labelsOnly as unknown as Phase21Gen4IndependentChainReconciliation,
      ),
    ).toEqual({ ok: false, reason: 'external_attestation_missing' });
  });

  it('binds priorQueryIds to the DB attempts by attempt_number (order and values)', () => {
    const e = NOW_RECON();
    const db = ['900000000001', '900000000002', '900000000003'];
    expect(
      evaluatePhase21Gen4ChainReconciliationFreshness(e, Date.now(), { expectedPriorQueryIds: db }).ok,
    ).toBe(true);
    expect(
      evaluatePhase21Gen4ChainReconciliationFreshness(e, Date.now(), {
        expectedPriorQueryIds: [db[1]!, db[0]!, db[2]!],
      }).reason,
    ).toBe('prior_query_ids_mismatch_db');
    expect(
      evaluatePhase21Gen4ChainReconciliationFreshness(e, Date.now(), {
        expectedPriorQueryIds: [db[0]!, db[1]!, '999'],
      }).reason,
    ).toBe('prior_query_ids_mismatch_db');
    expect(
      evaluatePhase21Gen4ChainReconciliationFreshness(e, Date.now(), {
        expectedPriorQueryIds: [db[0]!, db[1]!],
      }).reason,
    ).toBe('prior_query_ids_mismatch_db');
  });
});

describe('phase21 Gen-4 recovery pure gates', () => {
  const eligibleBase = {
    withdrawalState: 'FAILED_PRE_BROADCAST',
    gen1PermitStatus: 'CONSUMED',
    gen2PermitStatus: 'CONSUMED',
    gen3PermitStatus: 'CONSUMED',
    gen3LaunchClaimBound: true,
    gen4PermitStatus: null as string | null,
    attemptCount: 3,
    failedPreAttemptCount: 3,
    signatureOrBroadcastEvidenceCount: 0,
    reservationHeld: true,
    settlementPresent: false,
    releasePresent: false,
    chainReconOk: true,
  };

  it('eligibility: fresh and armed Gen-4 pass; every mutation refuses with a reason', () => {
    expect(evaluatePhase21Gen4RecoveryEligibility(eligibleBase).eligible).toBe(true);
    expect(
      evaluatePhase21Gen4RecoveryEligibility({ ...eligibleBase, gen4PermitStatus: 'ARMED' }).eligible,
    ).toBe(true);
    const refuse = (patch: Partial<typeof eligibleBase>) =>
      evaluatePhase21Gen4RecoveryEligibility({ ...eligibleBase, ...patch }).reason;
    expect(refuse({ withdrawalState: 'SETTLED' })).toBe('withdrawal_state_not_allowed');
    expect(refuse({ gen1PermitStatus: 'ARMED' })).toBe('gen1_not_consumed');
    expect(refuse({ gen2PermitStatus: 'ARMED' })).toBe('gen2_not_consumed');
    expect(refuse({ gen3PermitStatus: 'ARMED' })).toBe('gen3_not_consumed');
    expect(refuse({ gen3LaunchClaimBound: false })).toBe('gen3_launch_claim_not_bound');
    expect(refuse({ gen4PermitStatus: 'CANCELLED' })).toBe('gen4_cancelled');
    expect(refuse({ attemptCount: 2, failedPreAttemptCount: 2 })).toBe('prior_attempt_count_not_three');
    expect(refuse({ attemptCount: 4, failedPreAttemptCount: 4 })).toBe('prior_attempt_count_not_three');
    expect(refuse({ failedPreAttemptCount: 2 })).toBe('non_failed_pre_attempts');
    expect(refuse({ signatureOrBroadcastEvidenceCount: 1 })).toBe('signature_or_broadcast_evidence');
    expect(refuse({ reservationHeld: false })).toBe('reservation_not_held');
    expect(refuse({ settlementPresent: true })).toBe('already_settled');
    expect(refuse({ releasePresent: true })).toBe('already_released');
    expect(refuse({ chainReconOk: false })).toBe('chain_recon_required');
  });

  const resumeBase = {
    withdrawalState: 'FAILED_PRE_BROADCAST',
    gen1PermitStatus: 'CONSUMED',
    gen2PermitStatus: 'CONSUMED',
    gen3PermitStatus: 'CONSUMED',
    gen4PermitStatus: 'ARMED',
    gen4AuthorizationGeneration: 4,
    attemptCount: 3,
    failedPreAttemptCount: 3,
    broadcastEvidenceCount: 0,
    priorWorkflowStatus: 'FAILED',
  };

  it('consumed-failed-pre recovery: needs ARMED gen4 + three clean attempts + safe prior workflow', () => {
    expect(evaluatePhase21Gen4ConsumedFailedPreRecovery(resumeBase).eligible).toBe(true);
    const refuse = (patch: Partial<typeof resumeBase>) =>
      evaluatePhase21Gen4ConsumedFailedPreRecovery({ ...resumeBase, ...patch }).reason;
    expect(refuse({ gen3PermitStatus: 'ARMED' })).toBe('gen3_not_consumed');
    expect(refuse({ gen4PermitStatus: 'CONSUMED' })).toBe('gen4_not_armed');
    expect(refuse({ gen4AuthorizationGeneration: 3 })).toBe('gen4_generation_invalid');
    expect(refuse({ attemptCount: 2, failedPreAttemptCount: 2 })).toBe('prior_attempt_count_not_three');
    expect(refuse({ broadcastEvidenceCount: 1 })).toBe('broadcast_evidence_exists');
    expect(refuse({ priorWorkflowStatus: 'RUNNING' })).toBe('prior_workflow_not_safe');
    expect(refuse({ priorWorkflowStatus: PHASE21_GEN4_TEMPORAL_HISTORY_ABSENT_STATUS })).toBeNull();
  });

  it('durable Gen-3 terminal token is safe for Gen-4 only (not for the shared canary gate)', () => {
    expect(isPhase21Gen4PriorWorkflowSafeToRestart(PHASE21_GEN4_TEMPORAL_HISTORY_ABSENT_STATUS)).toBe(
      true,
    );
    expect(isPhase21Gen4PriorWorkflowSafeToRestart('failed')).toBe(true);
    expect(isPhase21Gen4PriorWorkflowSafeToRestart('RUNNING')).toBe(false);
    expect(isPhase21CanaryPriorWorkflowSafeToRestart(PHASE21_GEN4_TEMPORAL_HISTORY_ABSENT_STATUS)).toBe(
      false,
    );
  });

  it('attempt shape acceptance requires exactly #1/#2/#3 FAILED_PRE and zero evidence', () => {
    const ok = {
      attemptCount: 3,
      failedPreAttemptCount: 3,
      evidenceCount: 0,
      attempt1FailedPre: true,
      attempt2FailedPre: true,
      attempt3FailedPre: true,
    };
    expect(isPhase21Gen4AttemptShapeAccepted(ok)).toBe(true);
    expect(isPhase21Gen4AttemptShapeAccepted({ ...ok, attemptCount: 2, failedPreAttemptCount: 2 })).toBe(
      false,
    );
    expect(isPhase21Gen4AttemptShapeAccepted({ ...ok, attemptCount: 4, failedPreAttemptCount: 4 })).toBe(
      false,
    );
    expect(isPhase21Gen4AttemptShapeAccepted({ ...ok, failedPreAttemptCount: 2 })).toBe(false);
    expect(isPhase21Gen4AttemptShapeAccepted({ ...ok, evidenceCount: 1 })).toBe(false);
    expect(isPhase21Gen4AttemptShapeAccepted({ ...ok, attempt1FailedPre: false })).toBe(false);
    expect(isPhase21Gen4AttemptShapeAccepted({ ...ok, attempt2FailedPre: false })).toBe(false);
    expect(isPhase21Gen4AttemptShapeAccepted({ ...ok, attempt3FailedPre: false })).toBe(false);
  });
});

describe('readPhase21Gen4AttemptShape (gate 3)', () => {
  it('maps the aggregate row to the shape; empty result is fail-closed', async () => {
    const world = createGen4World();
    const shape = await readPhase21Gen4AttemptShape(mockGen4Client(world) as never, WID);
    expect(shape).toEqual({
      attemptCount: 3,
      failedPreAttemptCount: 3,
      evidenceCount: 0,
      attempt1FailedPre: true,
      attempt2FailedPre: true,
      attempt3FailedPre: true,
    });
    const empty = await readPhase21Gen4AttemptShape(
      { query: async () => ({ rows: [] }) } as never,
      WID,
    );
    expect(isPhase21Gen4AttemptShapeAccepted(empty)).toBe(false);
  });
});

describe('verifyPhase21Gen4ExactPermitAttemptBindings', () => {
  const ids = { gen1: 'attempt-1', gen2: 'attempt-2', gen3: 'attempt-3' };
  const verify = (
    world: Gen4MockWorld,
    patch?: Partial<{ gen1: string; gen2: string; gen3: string }>,
  ) => {
    const x = { ...ids, ...patch };
    return verifyPhase21Gen4ExactPermitAttemptBindings(asPg(mockGen4Client(world)), {
      withdrawalId: WID,
      gen1ConsumedAttemptId: x.gen1,
      gen2ConsumedAttemptId: x.gen2,
      gen3ConsumedAttemptId: x.gen3,
    });
  };

  it('accepts exact Gen-1→#1, Gen-2→#2, Gen-3→#3', async () => {
    expect(await verify(createGen4World())).toEqual({ ok: true });
  });

  it('refuses swapped / wrong bindings with the exact reason', async () => {
    expect(await verify(createGen4World(), { gen1: 'attempt-2', gen2: 'attempt-1' })).toEqual({
      ok: false,
      reason: 'gen1_not_bound_to_attempt_1',
    });
    expect(await verify(createGen4World(), { gen2: 'attempt-3', gen3: 'attempt-2' })).toEqual({
      ok: false,
      reason: 'gen2_not_bound_to_attempt_2',
    });
    expect(await verify(createGen4World(), { gen3: 'attempt-1' })).toEqual({
      ok: false,
      reason: 'gen3_not_bound_to_attempt_3',
    });
    expect(await verify(createGen4World(), { gen3: 'unknown' })).toEqual({
      ok: false,
      reason: 'gen3_not_bound_to_attempt_3',
    });
  });

  it('refuses incomplete or duplicated attempt rows', async () => {
    const missing = createGen4World();
    missing.attempts = missing.attempts.filter((a) => a.attemptNumber !== 2);
    expect(await verify(missing)).toEqual({ ok: false, reason: 'attempt_rows_incomplete' });

    const empty = createGen4World();
    empty.attempts = [];
    expect(await verify(empty)).toEqual({ ok: false, reason: 'attempt_rows_incomplete' });

    const dup = createGen4World();
    dup.attempts.push({
      id: 'attempt-1b',
      attemptNumber: 1,
      state: 'FAILED_PRE_BROADCAST',
      hasEvidence: false,
      queryId: '900000000009',
    });
    expect(await verify(dup)).toEqual({ ok: false, reason: 'attempt_rows_incomplete' });
  });
});

describe('Gen-3 launch claim binding (gate 1)', () => {
  it('accepts the exact DISPATCHED claim bound to Gen-3 permit + attempt #3 FAILED_PRE with query_id', async () => {
    const world = createGen4World();
    const r = await verifyPhase21Gen3TemporalLaunchClaimBinding(asPg(mockGen4Client(world)), {
      withdrawalId: WID,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.gen3PermitId).toBe(GEN3_PERMIT_ID);
      expect(r.attempt3Id).toBe('attempt-3');
      expect(r.gen3ConsumedAttemptId).toBe('attempt-3');
      expect(r.attempt3QueryId).toBe('900000000003');
      expect(r.dedupeKey).toBe(gen3ClaimKey());
    }
  });

  const refusals: ReadonlyArray<readonly [string, (w: Gen4MockWorld) => void, string]> = [
    ['Gen-3 permit missing', (w) => void (w.permits = w.permits.filter((p) => p.generation !== 3)), 'gen3_permit_missing'],
    [
      'Gen-3 permit not consumed',
      (w) => {
        const p = w.permits.find((x) => x.generation === 3)!;
        p.status = 'ARMED';
      },
      'gen3_not_consumed',
    ],
    [
      'Gen-3 permit unbound',
      (w) => {
        w.permits.find((x) => x.generation === 3)!.consumedAttemptId = null;
      },
      'gen3_attempt_unbound',
    ],
    ['claim missing', (w) => void w.outbox.delete(gen3ClaimKey()), 'gen3_launch_claim_missing'],
    [
      'claim PENDING (not DISPATCHED)',
      (w) => void (w.outbox.get(gen3ClaimKey())!.status = 'PENDING'),
      'gen3_launch_claim_not_dispatched',
    ],
    [
      'claim wrong event type',
      (w) => void (w.outbox.get(gen3ClaimKey())!.eventType = 'phase21.gen2_temporal_launch_claim'),
      'gen3_launch_claim_wrong_event_type',
    ],
    [
      'claim wrong aggregate',
      (w) => void (w.outbox.get(gen3ClaimKey())!.aggregateId = '00000000-0000-4000-8000-000000000000'),
      'gen3_launch_claim_wrong_aggregate',
    ],
    [
      'claim payload wrong withdrawal',
      (w) => setClaimPayload(w, { withdrawalId: '00000000-0000-4000-8000-000000000000' }),
      'gen3_launch_claim_payload_wrong_withdrawal',
    ],
    [
      'claim payload wrong permit',
      (w) => setClaimPayload(w, { gen3PermitId: '99999999-9999-4999-8999-999999999999' }),
      'gen3_launch_claim_payload_wrong_permit',
    ],
    [
      'claim payload wrong generation',
      (w) => setClaimPayload(w, { authorizationGeneration: 2 }),
      'gen3_launch_claim_payload_wrong_generation',
    ],
    [
      'claim payload wrong workflow',
      (w) => setClaimPayload(w, { workflowId: 'withdrawal/other' }),
      'gen3_launch_claim_payload_wrong_workflow',
    ],
    [
      'claim payload broadcastPerformed',
      (w) => setClaimPayload(w, { broadcastPerformed: true }),
      'gen3_launch_claim_payload_broadcast_flag',
    ],
    [
      'claim payload not an object',
      (w) => void (w.outbox.get(gen3ClaimKey())!.payload = 'null'),
      'gen3_launch_claim_payload_invalid',
    ],
    [
      'attempt #3 missing',
      (w) => void (w.attempts = w.attempts.filter((a) => a.attemptNumber !== 3)),
      'attempt3_missing',
    ],
    [
      'Gen-3 permit bound to a different attempt than #3',
      (w) => {
        w.permits.find((x) => x.generation === 3)!.consumedAttemptId = 'attempt-2';
      },
      'gen3_attempt_not_attempt3',
    ],
    [
      'attempt #3 not FAILED_PRE',
      (w) => void (w.attempts.find((a) => a.attemptNumber === 3)!.state = 'BROADCAST_UNKNOWN'),
      'attempt3_not_failed_pre',
    ],
    [
      'attempt #3 without query_id',
      (w) => void (w.attempts.find((a) => a.attemptNumber === 3)!.queryId = null),
      'attempt3_query_id_missing',
    ],
  ];

  it.each(refusals)('refuses: %s', async (_name, mutate, reason) => {
    const world = createGen4World();
    mutate(world);
    const r = await verifyPhase21Gen3TemporalLaunchClaimBinding(asPg(mockGen4Client(world)), {
      withdrawalId: WID,
    });
    expect(r).toEqual({ ok: false, reason });
  });

  it('mere claim presence (readPhase21Gen3TemporalLaunchClaimPresent) is NOT sufficient', async () => {
    const world = createGen4World();
    setClaimPayload(world, { gen3PermitId: '99999999-9999-4999-8999-999999999999' });
    const client = mockGen4Client(world);
    // Presence helper (new add-only export) still reports the DISPATCHED row...
    expect(
      await readPhase21Gen3TemporalLaunchClaimPresent(client as never, {
        withdrawalId: WID,
        gen3PermitId: GEN3_PERMIT_ID,
      }),
    ).toBe(true);
    // ...but the binding gate refuses the forged payload.
    expect(
      (await verifyPhase21Gen3TemporalLaunchClaimBinding(asPg(client), { withdrawalId: WID })).ok,
    ).toBe(false);
  });
});

describe('planPhase21Gen4Recovery (read-only)', () => {
  const failedIds = (r: { checks: ReadonlyArray<{ id: string; status: string }> }) =>
    r.checks.filter((c) => c.status === 'FAIL').map((c) => c.id);

  it('is ready on a fresh pre-Gen-4 world and never mutates', async () => {
    const world = createGen4World({ gen4: 'absent' });
    const client = mockGen4Client(world);
    const plan = await planPhase21Gen4Recovery(asPg(client), {
      withdrawalId: WID,
      chainReconciliation: NOW_RECON(),
    });
    expect(failedIds(plan)).toEqual([]);
    expect(plan.ok).toBe(true);
    expect(plan.readyForGen4Apply).toBe(true);
    expect(plan.authorizationGeneration).toBe(4);
    expect(plan.gen3TemporalLaunchClaimBound).toBe(true);
    expect(plan.gen4PermitStatus).toBeNull();
    expect(plan.attemptCount).toBe(3);
    expect(plan.mutated).toBe(false);
    expect(world.log[0]).toBe('BEGIN READ ONLY');
    expect(world.log.some((s) => /^(INSERT|UPDATE|DELETE)/.test(s))).toBe(false);
    expect(world.log.some((s) => s.includes('FOR UPDATE'))).toBe(false);
  });

  it('accepts an already ARMED Gen-4 permit (idempotent re-plan)', async () => {
    const world = createGen4World({ gen4: 'ARMED' });
    const plan = await planPhase21Gen4Recovery(asPg(mockGen4Client(world)), {
      withdrawalId: WID,
      chainReconciliation: NOW_RECON(),
    });
    expect(plan.ok).toBe(true);
    expect(plan.gen4PermitStatus).toBe('ARMED');
  });

  it('refuses a wrong withdrawal id (non-canary)', async () => {
    const plan = await planPhase21Gen4Recovery(asPg(mockGen4Client(createGen4World())), {
      withdrawalId: '00000000-0000-4000-8000-000000000000',
      chainReconciliation: NOW_RECON(),
    });
    expect(failedIds(plan)).toContain('withdrawal_id_authorized');
  });

  it('refuses stale recon, wrong-provider recon and recon not bound to the DB query ids', async () => {
    const stale = await planPhase21Gen4Recovery(asPg(mockGen4Client(createGen4World())), {
      withdrawalId: WID,
      chainReconciliation: mintPhase21Gen4IndependentChainReconciliationForTests({
        performedAt: new Date(Date.now() - 16 * 60_000).toISOString(),
      }),
    });
    expect(failedIds(stale)).toContain('independent_chain_reconciliation');

    const wrongIds = await planPhase21Gen4Recovery(asPg(mockGen4Client(createGen4World())), {
      withdrawalId: WID,
      chainReconciliation: mintPhase21Gen4IndependentChainReconciliationForTests({
        priorQueryIds: ['900000000001', '900000000002', '900000000999'],
      }),
    });
    expect(failedIds(wrongIds)).toEqual(['chain_recon_prior_query_ids_match_db']);

    const reordered = await planPhase21Gen4Recovery(asPg(mockGen4Client(createGen4World())), {
      withdrawalId: WID,
      chainReconciliation: mintPhase21Gen4IndependentChainReconciliationForTests({
        priorQueryIds: ['900000000002', '900000000001', '900000000003'],
      }),
    });
    expect(failedIds(reordered)).toEqual(['chain_recon_prior_query_ids_match_db']);

    const badProviders = await planPhase21Gen4Recovery(asPg(mockGen4Client(createGen4World())), {
      withdrawalId: WID,
      chainReconciliation: {
        ...NOW_RECON(),
        primaryProviderKind: 'tonapi',
      } as unknown as Phase21Gen4IndependentChainReconciliation,
    });
    expect(failedIds(badProviders)).toContain('independent_chain_reconciliation');
  });

  const worldRefusals: ReadonlyArray<readonly [string, (w: Gen4MockWorld) => void, string]> = [
    ['pause flag off', (w) => void (w.paused = false), 'payout_dispatch_pause_preserved'],
    [
      'Gen-1 bound to attempt 2 and Gen-2 bound to attempt 1 (swapped)',
      (w) => {
        w.permits.find((p) => p.generation === 1)!.consumedAttemptId = 'attempt-2';
        w.permits.find((p) => p.generation === 2)!.consumedAttemptId = 'attempt-1';
      },
      'gen1_bound_to_attempt_1',
    ],
    [
      'Gen-2 bound to attempt 3 and Gen-3 bound to attempt 2 (swapped)',
      (w) => {
        w.permits.find((p) => p.generation === 2)!.consumedAttemptId = 'attempt-3';
        w.permits.find((p) => p.generation === 3)!.consumedAttemptId = 'attempt-2';
      },
      'gen2_bound_to_attempt_2',
    ],
    [
      'Gen-3 bound to a different attempt than #3',
      (w) => void (w.permits.find((p) => p.generation === 3)!.consumedAttemptId = 'attempt-9'),
      'gen3_bound_to_attempt_3',
    ],
    ['Gen-3 not consumed', (w) => void (w.permits.find((p) => p.generation === 3)!.status = 'ARMED'), 'gen3_consumed_preserved'],
    [
      'Gen-3 launch claim forged (wrong permit)',
      (w) => setClaimPayload(w, { gen3PermitId: '99999999-9999-4999-8999-999999999999' }),
      'gen3_temporal_launch_claim_bound',
    ],
    [
      'Gen-3 launch claim missing',
      (w) => void w.outbox.delete(gen3ClaimKey()),
      'gen3_temporal_launch_claim_bound',
    ],
    [
      'Gen-2 launch claim missing',
      (w) => {
        for (const [k, v] of [...w.outbox]) {
          if (v.id === 'claim-gen2') w.outbox.delete(k);
        }
      },
      'gen2_temporal_launch_claim_preserved',
    ],
    [
      'only two attempts',
      (w) => void (w.attempts = w.attempts.filter((a) => a.attemptNumber !== 3)),
      'prior_attempts_exactly_three_failed_pre',
    ],
    [
      'four attempts',
      (w) =>
        void w.attempts.push({
          id: 'attempt-4',
          attemptNumber: 4,
          state: 'FAILED_PRE_BROADCAST',
          hasEvidence: false,
          queryId: '900000000004',
        }),
      'prior_attempts_exactly_three_failed_pre',
    ],
    [
      'attempt #3 not FAILED_PRE',
      (w) => void (w.attempts[2]!.state = 'BROADCAST_UNKNOWN'),
      'prior_attempts_exactly_three_failed_pre',
    ],
    [
      'signature/broadcast evidence on an attempt',
      (w) => void (w.attempts[1]!.hasEvidence = true),
      'no_signature_or_broadcast_evidence',
    ],
    [
      'Gen-4 CANCELLED',
      (w) => void (w.permits.find((p) => p.generation === 4)!.status = 'CANCELLED'),
      'gen4_absent_or_armed',
    ],
    [
      'Gen-4 permit id equals Gen-3 permit id',
      (w) => void (w.permits.find((p) => p.generation === 4)!.id = GEN3_PERMIT_ID),
      'gen4_not_prior_generation_reuse',
    ],
    ['already settled', (w) => void (w.settlement = 'settle-1'), 'no_settlement'],
    ['already released', (w) => void (w.release = 'rel-1'), 'no_release'],
    ['reservation missing', (w) => void (w.reservation = null), 'reservation_held'],
    ['withdrawal state SETTLED', (w) => void (w.state = 'SETTLED'), 'withdrawal_state'],
  ];

  it.each(worldRefusals)('refuses: %s', async (_name, mutate, checkId) => {
    const world = createGen4World({ gen4: 'ARMED' });
    mutate(world);
    const plan = await planPhase21Gen4Recovery(asPg(mockGen4Client(world)), {
      withdrawalId: WID,
      chainReconciliation: NOW_RECON(),
    });
    expect(plan.ok).toBe(false);
    expect(plan.readyForGen4Apply).toBe(false);
    expect(failedIds(plan)).toContain(checkId);
  });
});

describe('applyPhase21Gen4Recovery (mocked DB)', () => {
  beforeEach(() => {
    process.env.ALEX_PHASE21_CEREMONY_TEST_HOOKS = '1';
  });

  const ownerTrust = () =>
    mintAuthenticatedPhase21OwnerCeremonyTrustForTests({
      adminUserId: ADMIN_ID,
      currentDatabase: 'alex_rewards_gen4_unit',
      systemIdentifier: '7000000000000000000',
    });

  const run = (
    client: unknown,
    overrides?: Partial<Parameters<typeof applyPhase21Gen4Recovery>[1]>,
  ) =>
    applyPhase21Gen4Recovery(client as never, {
      withdrawalId: WID,
      ownerTrust: ownerTrust(),
      applyConfirmation: __mintPhase21Gen4RecoveryApplyConfirmationForTests(),
      chainReconciliation: NOW_RECON(),
      ...overrides,
    });

  it('arms generation 4, enqueues the audit-only outbox row, never claims or starts Temporal', async () => {
    const world = createGen4World({ gen4: 'absent' });
    const client = mockGen4Client(world);
    const r = await run(client);

    expect(r.refuseCode).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.applied).toBe(true);
    expect(r.created).toBe(true);
    expect(r.reused).toBe(false);
    expect(r.authorizationGeneration).toBe(4);
    expect(r.permitStatus).toBe('ARMED');
    expect(r.gen3PermitId).toBe(GEN3_PERMIT_ID);
    expect(r.gen3PermitStatus).toBe('CONSUMED');
    expect(r.temporalStarted).toBe(false);
    expect(r.broadcastPerformed).toBe(false);
    expect(r.signed).toBe(false);
    expect(r.outboxRelayStillDisabled).toBe(true);
    expect(r.readyForLivePayout).toBe(false);

    const gen4 = world.permits.find((p) => p.generation === 4);
    expect(gen4?.status).toBe('ARMED');
    expect(gen4?.id).toBe(r.permitId);
    // Gen-1/2/3 untouched.
    expect(world.permits.filter((p) => p.generation < 4).every((p) => p.status === 'CONSUMED')).toBe(true);

    // Outbox: Gen-1/2/3-era claims preserved; PENDING manual-dispatch row (audit-only), NO Gen-4 claim.
    const rows = [...world.outbox.entries()];
    expect(rows.some(([, v]) => v.eventType === 'phase21.gen4_temporal_launch_claim')).toBe(false);
    expect(rows.some(([k]) => k.startsWith('withdrawal.phase21_gen4_temporal_launch:'))).toBe(false);
    const manual = rows.filter(([, v]) => v.eventType === WITHDRAWAL_PHASE21_MANUAL_DISPATCH_OUTBOX_EVENT);
    expect(manual).toHaveLength(1);
    expect(manual[0]![1].status).toBe('PENDING');
    expect((manual[0]![1].payload as { permitId: string }).permitId).toBe(r.permitId);
    expect(world.outbox.has(gen3ClaimKey())).toBe(true);
    expect(world.log.at(-1)).toBe('COMMIT');
  });

  it('revalidation locks attempt rows FOR UPDATE and reads the shape in the same transaction after the lock', async () => {
    const world = createGen4World({ gen4: 'absent' });
    await run(mockGen4Client(world));
    const begin = world.log.indexOf('BEGIN');
    expect(begin).toBeGreaterThan(0);
    const after = world.log.slice(begin);
    const lock = after.findIndex(
      (s) => s.includes('FROM withdrawal_attempts') && s.includes('FOR UPDATE'),
    );
    const shape = after.findIndex((s) => s.includes('AS attempt3_failed_pre'));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(shape).toBeGreaterThan(lock);
    // Withdrawal row also locked before the attempt rows.
    const wdLock = after.findIndex((s) => s.includes('FROM withdrawals') && s.includes('FOR UPDATE'));
    expect(wdLock).toBeGreaterThanOrEqual(0);
    expect(wdLock).toBeLessThan(lock);
  });

  it('is idempotent when Gen-4 is already ARMED (reuses permit, no second permit)', async () => {
    const world = createGen4World({ gen4: 'ARMED' });
    const r = await run(mockGen4Client(world));
    expect(r.ok).toBe(true);
    expect(r.created).toBe(false);
    expect(r.reused).toBe(true);
    expect(r.permitId).toBe(GEN4_PERMIT_ID);
    expect(world.permits.filter((p) => p.generation === 4)).toHaveLength(1);
    expect(r.temporalStarted).toBe(false);
  });

  it('refuses without branded ceremony trust / confirmation (forged, Gen-3, missing)', async () => {
    const world = createGen4World({ gen4: 'absent' });
    const client = mockGen4Client(world);
    await expect(
      run(client, {
        ownerTrust: { brand: 'AuthenticatedPhase21OwnerCeremonyTrust' } as never,
      }),
    ).rejects.toThrow(/AuthenticatedPhase21OwnerCeremonyTrust required/);
    await expect(
      run(client, { applyConfirmation: __mintPhase21Gen3RecoveryApplyConfirmationForTests() as never }),
    ).rejects.toThrow(/Phase21Gen4RecoveryApplyConfirmation required/);
    await expect(run(client, { applyConfirmation: undefined as never })).rejects.toThrow();
    expect(client.query).not.toHaveBeenCalled();
    expect(world.permits.some((p) => p.generation === 4)).toBe(false);
  });

  it('refuses a non-canary withdrawal id and mismatched bindings before any DB access', async () => {
    const world = createGen4World({ gen4: 'absent' });
    const client = mockGen4Client(world);
    const wrongId = await run(client, { withdrawalId: '00000000-0000-4000-8000-000000000000' });
    expect(wrongId.refuseCode).toBe('GEN4_WITHDRAWAL_ID_MISMATCH');
    expect(wrongId.applied).toBe(false);
    expect(client.query).not.toHaveBeenCalled();
  });

  it('refuses stale / unbound / missing recon before any DB access', async () => {
    const world = createGen4World({ gen4: 'absent' });
    const client = mockGen4Client(world);
    for (const chainReconciliation of [
      mintPhase21Gen4IndependentChainReconciliationForTests({
        performedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      }),
      { ...NOW_RECON(), hotWalletFriendly: 'EQ_other' },
      { ...NOW_RECON(), priorQueryIds: ['1', '2'] },
      null as never,
    ]) {
      const r = await run(client, { chainReconciliation });
      expect(r.refuseCode).toBe('GEN4_CHAIN_RECON_REQUIRED');
      expect(r.applied).toBe(false);
    }
    expect(client.query).not.toHaveBeenCalled();
  });

  const preconditionRefusals: ReadonlyArray<readonly [string, (w: Gen4MockWorld) => void, string]> = [
    ['Gen-3 not CONSUMED', (w) => void (w.permits.find((p) => p.generation === 3)!.status = 'ARMED'), 'gen3_consumed_preserved'],
    [
      'Gen-3 launch claim forged',
      (w) => setClaimPayload(w, { workflowId: 'withdrawal/forged' }),
      'gen3_temporal_launch_claim_bound',
    ],
    [
      'Gen-3 launch claim missing',
      (w) => void w.outbox.delete(gen3ClaimKey()),
      'gen3_temporal_launch_claim_bound',
    ],
    [
      'prior attempt query ids differ from recon',
      (w) => void (w.attempts[0]!.queryId = '123'),
      'chain_recon_prior_query_ids_match_db',
    ],
    [
      'Gen-1/Gen-2 attempt bindings swapped',
      (w) => {
        w.permits.find((p) => p.generation === 1)!.consumedAttemptId = 'attempt-2';
        w.permits.find((p) => p.generation === 2)!.consumedAttemptId = 'attempt-1';
      },
      'gen1_bound_to_attempt_1',
    ],
    ['evidence on prior attempt', (w) => void (w.attempts[0]!.hasEvidence = true), 'no_signature_or_broadcast_evidence'],
    ['two attempts only', (w) => void (w.attempts.pop()), 'prior_attempts_exactly_three_failed_pre'],
    [
      'Gen-4 CANCELLED',
      (w) => void (w.permits.find((p) => p.generation === 4)!.status = 'CANCELLED'),
      'gen4_absent_or_armed',
    ],
    [
      'Gen-4 permit id reuses Gen-3 permit id',
      (w) => void (w.permits.find((p) => p.generation === 4)!.id = GEN3_PERMIT_ID),
      'gen4_not_prior_generation_reuse',
    ],
  ];

  it.each(preconditionRefusals)('PLAN-stage refusal: %s (no mutation)', async (_name, mutate, checkId) => {
    const world = createGen4World({ gen4: 'ARMED' });
    mutate(world);
    const before = world.permits.map((p) => ({ ...p }));
    const client = mockGen4Client(world);
    const r = await run(client);
    expect(r.ok).toBe(false);
    expect(r.applied).toBe(false);
    expect(r.refuseCode).toBe('GEN4_APPLY_PRECONDITIONS_FAILED');
    expect(r.planChecksFailed).toContain(checkId);
    expect(world.permits).toEqual(before);
    expect(world.log).not.toContain('BEGIN');
    expect(world.log.some((s) => s.startsWith('INSERT'))).toBe(false);
  });

  /**
   * Simulates a concurrent writer that changes state AFTER the read-only PLAN finished but
   * before the mutation transaction locks rows: revalidation under FOR UPDATE must catch it.
   */
  function racingClient(world: Gen4MockWorld, racer: () => void) {
    const base = mockGen4Client(world);
    let raced = false;
    const wrapped = {
      query: async (sql: string, params?: readonly unknown[]) => {
        const out = await (base.query as (s: string, p?: readonly unknown[]) => Promise<unknown>)(
          sql,
          params,
        );
        if (!raced && sql.trim() === 'ROLLBACK') {
          raced = true; // end of read-only PLAN
          racer();
        }
        return out;
      },
    };
    return wrapped;
  }

  const raceCases: ReadonlyArray<readonly [string, (w: Gen4MockWorld) => void, string]> = [
    ['evidence appears on attempt #2', (w) => void (w.attempts[1]!.hasEvidence = true), 'no_evidence'],
    ['attempt #3 leaves FAILED_PRE', (w) => void (w.attempts[2]!.state = 'BROADCAST_UNKNOWN'), 'attempt_numbers_1_2_and_3'],
    ['a fourth attempt appears', (w) => void w.attempts.push({ id: 'attempt-4', attemptNumber: 4, state: 'FAILED_PRE_BROADCAST', hasEvidence: false, queryId: '900000000004' }), 'exactly_three_failed_pre'],
    ['attempt #3 query_id changes', (w) => void (w.attempts[2]!.queryId = '777'), 'chain_recon_prior_query_ids_mismatch_db'],
    ['payout pause turned off', (w) => void (w.paused = false), 'payout_dispatch_pause'],
    ['Gen-3 launch claim altered', (w) => setClaimPayload(w, { broadcastPerformed: true }), 'gen3_temporal_launch_claim_bound'],
    ['withdrawal released', (w) => void (w.release = 'rel-1'), 'no_release'],
    [
      'Gen-1/Gen-2 consumed attempts swapped (exact binding under lock)',
      (w) => {
        w.permits.find((p) => p.generation === 1)!.consumedAttemptId = 'attempt-2';
        w.permits.find((p) => p.generation === 2)!.consumedAttemptId = 'attempt-1';
      },
      'gen1_not_bound_to_attempt_1',
    ],
    [
      'Gen-3 consumed attempt moves off #3',
      (w) => void (w.permits.find((p) => p.generation === 3)!.consumedAttemptId = 'attempt-1'),
      'gen3_not_bound_to_attempt_3',
    ],
  ];

  it.each(raceCases)('revalidation under lock refuses: %s', async (_name, mutate, failedId) => {
    const world = createGen4World({ gen4: 'absent' });
    const client = racingClient(world, () => mutate(world));
    const r = await run(client);
    expect(r.ok).toBe(false);
    expect(r.applied).toBe(false);
    expect(r.refuseCode).toBe('GEN4_APPLY_REVALIDATION_FAILED');
    expect(r.planChecksFailed).toContain(failedId);
    expect(world.permits.some((p) => p.generation === 4)).toBe(false);
    expect(world.log.at(-1)).toBe('ROLLBACK');
    expect(world.log.some((s) => s.startsWith('INSERT'))).toBe(false);
  });

  it('PLAN/APPLY result contracts never claim Temporal start or broadcast', async () => {
    const world = createGen4World({ gen4: 'absent' });
    const r = await run(mockGen4Client(world));
    expect(Object.keys(r)).toContain('temporalStarted');
    expect(r.temporalStarted).toBe(false);
    expect(r.nextOperationalState).toContain('Temporal one-shot claim');
  });
});
