import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  PHASE21_CANARY_ATTACHED_GRAM_ATOMIC,
  PHASE21_CANARY_ATTACHED_GRAM_LIFECYCLE,
  PHASE21_CANARY_FORWARD_TON_ATOMIC,
  PHASE21_CANARY_PAYOUT_APPLY_ENABLED,
  PHASE21_CANARY_PAYOUT_EXPECTED_FEE_ATOMIC,
  PHASE21_CANARY_PAYOUT_EXPECTED_GROSS_ATOMIC,
  PHASE21_CANARY_PAYOUT_EXPECTED_NET_ATOMIC,
  PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_FRIENDLY,
  PHASE21_CANARY_PAYOUT_FUTURE_APPLY_DESIGN,
  PHASE21_CANARY_PAYOUT_PUBLIC_ID,
  PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
  planPhase21CanaryPayout,
  type Phase21CanaryPayoutEnvObservations,
  type Phase21CanaryPayoutPlanClient,
  type Phase21CanaryPayoutSignerProbe,
} from '../src/phase21-canary-payout-plan.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const CANARY_ENV: Phase21CanaryPayoutEnvObservations = {
  phase21MainnetEnabled: false,
  realChainEnabled: false,
  fakeChainEnabled: false,
  jettonMaster: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs',
  primaryProviderKind: 'toncenter',
  primaryProviderUrl: 'https://toncenter.com/api/v2',
  secondaryProviderKind: 'tonapi',
  secondaryProviderUrl: 'https://tonapi.io',
  signerBaseUrl: 'http://100.64.0.1:8787',
  signerServiceTokenConfigured: true,
  networkCode: 'TON_MAINNET',
  networkGlobalId: -239,
};

const LOCKED_SIGNER: Phase21CanaryPayoutSignerProbe = {
  performed: true,
  reachable: true,
  signingReady: false,
  custodyState: 'LOCKED',
  locked: true,
  detail: null,
};

function mockCanaryClient(overrides?: {
  readonly publicId?: string;
  readonly state?: string;
  readonly attemptCount?: number;
  readonly approvalCount?: number;
  readonly available?: string;
  readonly reserved?: string;
  readonly payoutDispatchPause?: boolean;
}): Phase21CanaryPayoutPlanClient {
  const publicId = overrides?.publicId ?? PHASE21_CANARY_PAYOUT_PUBLIC_ID;
  const state = overrides?.state ?? 'APPROVED';
  const attemptCount = overrides?.attemptCount ?? 0;
  const approvalCount = overrides?.approvalCount ?? 1;
  const available = overrides?.available ?? '0';
  const reserved = overrides?.reserved ?? '200000';
  const payoutDispatchPause = overrides?.payoutDispatchPause ?? true;

  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ): Promise<{ rows: T[]; rowCount?: number | null }> {
      if (text.includes('BEGIN READ ONLY') || text.includes('ROLLBACK')) {
        return { rows: [] as unknown as T[] };
      }
      if (text.includes('SHOW transaction_read_only')) {
        return { rows: [{ transaction_read_only: 'on' }] as unknown as T[] };
      }
      if (text.includes('FROM withdrawals w')) {
        return {
          rows: [
            {
              id: PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
              public_id: publicId,
              state,
              requested_amount_atomic: PHASE21_CANARY_PAYOUT_EXPECTED_GROSS_ATOMIC.toString(10),
              fee_amount_atomic: PHASE21_CANARY_PAYOUT_EXPECTED_FEE_ATOMIC.toString(10),
              net_amount_atomic: PHASE21_CANARY_PAYOUT_EXPECTED_NET_ATOMIC.toString(10),
              user_id: '11111111-1111-4111-8111-111111111111',
              asset_id: '22222222-2222-4222-8222-222222222222',
              network_id: '33333333-3333-4333-8333-333333333333',
              wallet_id: '44444444-4444-4444-8444-444444444444',
              hot_wallet_id: '55555555-5555-4555-8555-555555555555',
              workflow_id: `withdrawal/${PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID}`,
              reservation_ledger_tx_id: '66666666-6666-4666-8666-666666666666',
              release_ledger_tx_id: null,
              settlement_ledger_tx_id: null,
            },
          ] as unknown as T[],
        };
      }
      if (text.includes('FROM withdrawal_approvals')) {
        return {
          rows: [{ c: approvalCount, approve_count: approvalCount }] as unknown as T[],
        };
      }
      if (text.includes('FROM withdrawal_attempts')) {
        return {
          rows: [
            {
              c: attemptCount,
              signature_evidence: 0,
              submitted: 0,
              chain_ref: 0,
              broadcast_started: 0,
              ambiguous: 0,
            },
          ] as unknown as T[],
        };
      }
      if (text.includes('FROM user_wallets')) {
        return {
          rows: [
            {
              friendly_address: PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_FRIENDLY,
              raw_address: '0:f95cdeee5ad9b7af5be6ce4837377cce62d5fcd0eb7255febd219c2920d45775',
              is_primary: true,
              verified: true,
              verification_method: 'TON_PROOF',
              disabled_at: null,
              network_code: 'TON_MAINNET',
            },
          ] as unknown as T[],
        };
      }
      if (text.includes('USER_AVAILABLE_LIABILITY')) {
        return {
          rows: [
            { account_type: 'USER_AVAILABLE_LIABILITY', balance_atomic: available },
            { account_type: 'USER_RESERVED_LIABILITY', balance_atomic: reserved },
          ] as unknown as T[],
        };
      }
      if (text.includes('FROM networks WHERE id')) {
        return {
          rows: [
            {
              id: '33333333-3333-4333-8333-333333333333',
              code: 'TON_MAINNET',
              status: 'ACTIVE',
            },
          ] as unknown as T[],
        };
      }
      if (text.includes('FROM assets WHERE id')) {
        return {
          rows: [
            {
              symbol: 'USDT',
              decimals: 6,
              is_native: false,
              contract_identity: CANARY_ENV.jettonMaster,
              status: 'ACTIVE',
            },
          ] as unknown as T[],
        };
      }
      if (text.includes('FROM hot_wallets hw')) {
        return {
          rows: [
            {
              id: '55555555-5555-4555-8555-555555555555',
              address: '0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              friendly_address: 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c',
              wallet_version: 'v5R1',
              signer_type: 'FALLBACK_ENCRYPTED',
              status: 'ACTIVE',
              network_code: 'TON_MAINNET',
            },
          ] as unknown as T[],
        };
      }
      if (text.includes('FROM feature_flags')) {
        const key = String(params?.[0] ?? '');
        if (key === 'PAYOUT_DISPATCH_PAUSE') {
          return { rows: [{ enabled: payoutDispatchPause }] as unknown as T[] };
        }
        return { rows: [{ enabled: true }] as unknown as T[] };
      }
      return { rows: [] as unknown as T[] };
    },
  };
}

describe('phase21 canary payout PLAN', () => {
  it('hard-binds canary withdrawal id and refuses foreign ids', async () => {
    const plan = await planPhase21CanaryPayout(mockCanaryClient(), {
      withdrawalId: '00000000-0000-4000-8000-000000000000',
      env: CANARY_ENV,
      signerProbe: LOCKED_SIGNER,
    });
    expect(plan.ok).toBe(false);
    expect(plan.refuseCode).toBe('CANARY_WITHDRAWAL_ID_MISMATCH');
    expect(plan.applied).toBe(false);
    expect(plan.mutated).toBe(false);
    expect(plan.broadcast).toBe(false);
    expect(plan.readyForLivePayout).toBe(false);
  });

  it('passing snapshot proves checklist items without mutation', async () => {
    const plan = await planPhase21CanaryPayout(mockCanaryClient(), {
      withdrawalId: PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
      env: CANARY_ENV,
      signerProbe: LOCKED_SIGNER,
    });
    expect(plan.ok).toBe(true);
    expect(plan.mode).toBe('PLAN');
    expect(plan.applied).toBe(false);
    expect(plan.mutated).toBe(false);
    expect(plan.signed).toBe(false);
    expect(plan.broadcast).toBe(false);
    expect(plan.applyEnabled).toBe(true);
    expect(plan.readyForLivePayout).toBe(false);
    expect(plan.intendedTransfer.forwardTonAtomic).toBe(PHASE21_CANARY_FORWARD_TON_ATOMIC);
    expect(plan.intendedTransfer.forwardGramAtomic).toBe(1n);
    expect(plan.intendedTransfer.usdtNetAtomic).toBe(PHASE21_CANARY_PAYOUT_EXPECTED_NET_ATOMIC);
    expect(plan.intendedTransfer.attachedGramLifecycle).toBe('OWNER_APPROVED');
    expect(plan.intendedTransfer.status).toBe('OWNER_APPROVED');
    expect(plan.intendedTransfer.attachedGramAtomic).toBe('50000000');
    expect(plan.intendedTransfer.attachedGramAtomicOwnerApproved).toBe('50000000');
    expect(PHASE21_CANARY_ATTACHED_GRAM_LIFECYCLE).toBe('OWNER_APPROVED');
    expect(PHASE21_CANARY_ATTACHED_GRAM_ATOMIC).toBe(50_000_000n);
    expect(PHASE21_CANARY_FORWARD_TON_ATOMIC).toBe(1n);
    expect(plan.checks.every((c) => c.status !== 'FAIL')).toBe(true);
    expect(plan.checks.some((c) => c.id === 'exactly_one_approval' && c.status === 'PASS')).toBe(
      true,
    );
    expect(plan.checks.some((c) => c.id === 'zero_attempts' && c.status === 'PASS')).toBe(true);
    expect(plan.checks.some((c) => c.id === 'signer_locked' && c.status === 'PASS')).toBe(true);
    expect(
      plan.checks.some((c) => c.id === 'payout_dispatch_pause' && c.status === 'PASS'),
    ).toBe(true);
    expect(
      plan.checks.some((c) => c.id === 'withdrawal_requests_pause' && c.status === 'PASS'),
    ).toBe(true);
    expect(plan.checks.some((c) => c.id === 'auto_payout_pause' && c.status === 'PASS')).toBe(true);
    expect(
      plan.checks.some(
        (c) => c.id === 'two_provider_reconciliation_independent' && c.status === 'PASS',
      ),
    ).toBe(true);
    expect(plan.runtimeRequirementsEnumeratedNotApplied.length).toBeGreaterThan(0);
  });

  it('fails when attempts exist or pauses cleared', async () => {
    const withAttempts = await planPhase21CanaryPayout(mockCanaryClient({ attemptCount: 1 }), {
      withdrawalId: PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
      env: CANARY_ENV,
      signerProbe: LOCKED_SIGNER,
    });
    expect(withAttempts.ok).toBe(false);
    expect(withAttempts.checks.some((c) => c.id === 'zero_attempts' && c.status === 'FAIL')).toBe(
      true,
    );

    const unpaused = await planPhase21CanaryPayout(
      mockCanaryClient({ payoutDispatchPause: false }),
      {
        withdrawalId: PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
        env: CANARY_ENV,
        signerProbe: LOCKED_SIGNER,
      },
    );
    expect(unpaused.ok).toBe(false);
    expect(
      unpaused.checks.some((c) => c.id === 'payout_dispatch_pause' && c.status === 'FAIL'),
    ).toBe(true);
  });

  it('hard-fails source truth if attached/forward constants are wrong', () => {
    expect(PHASE21_CANARY_ATTACHED_GRAM_LIFECYCLE).toBe('OWNER_APPROVED');
    expect(PHASE21_CANARY_ATTACHED_GRAM_ATOMIC.toString(10)).toBe('50000000');
    expect(PHASE21_CANARY_FORWARD_TON_ATOMIC.toString(10)).toBe('1');
    if (PHASE21_CANARY_ATTACHED_GRAM_LIFECYCLE !== 'OWNER_APPROVED') {
      throw new Error('attached lifecycle must be OWNER_APPROVED');
    }
    if (PHASE21_CANARY_ATTACHED_GRAM_ATOMIC !== 50_000_000n) {
      throw new Error('attached amount must be 50000000');
    }
    if (PHASE21_CANARY_FORWARD_TON_ATOMIC !== 1n) {
      throw new Error('forward amount must be 1');
    }
  });

  it('keeps APPLY arm-permit-only design (no direct broadcast)', () => {
    expect(PHASE21_CANARY_PAYOUT_APPLY_ENABLED).toBe(true);
    expect(PHASE21_CANARY_PAYOUT_FUTURE_APPLY_DESIGN.applyEnabled).toBe(true);
    expect(PHASE21_CANARY_PAYOUT_FUTURE_APPLY_DESIGN.hardCapBroadcasts).toBe(1);
    expect(PHASE21_CANARY_PAYOUT_FUTURE_APPLY_DESIGN.unknownResultPolicy).toBe(
      'RECONCILE_REQUIRED',
    );
  });

  it('CLI source supports plan and apply-arm-permit without direct broadcast', () => {
    const src = readFileSync(
      path.resolve(here, '../src/cli/phase21-canary-payout.ts'),
      'utf8',
    );
    expect(src).toMatch(/--plan/);
    expect(src).toMatch(/applyPhase21CanaryPayout/);
    expect(src).toMatch(/openPhase21CanaryPlanVerifiedPool/);
    expect(src).toMatch(/openPhase21ApplyVerifiedPool/);
    expect(src).toMatch(/--ceremony-endpoint-profile/);
    expect(src).not.toMatch(/new Pool\s*\(/);
    expect(src).not.toMatch(/runRealTestnetPayoutPipeline/);
    expect(src).not.toMatch(/claimFirstBroadcastSend/);
    expect(src).not.toMatch(/local-unlock|signerUnlock|unlockSigner/);
    expect(src).toMatch(/Never broadcasts/);
  });
});
