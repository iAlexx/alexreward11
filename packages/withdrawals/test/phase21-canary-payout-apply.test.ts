import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  applyPhase21CanaryPayout,
  PHASE21_CANARY_MANUAL_DISPATCH_BINDINGS,
} from '../src/phase21-canary-payout-apply.js';
import {
  PHASE21_CANARY_PAYOUT_APPLY_ENABLED,
  PHASE21_CANARY_PAYOUT_PUBLIC_ID,
  PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
  type Phase21CanaryPayoutEnvObservations,
  type Phase21CanaryPayoutPlanClient,
  type Phase21CanaryPayoutSignerProbe,
} from '../src/phase21-canary-payout-plan.js';
import { __mintPhase21CanaryPayoutApplyConfirmationForTests } from '../src/phase21-ceremony-confirmations.js';
import { mintAuthenticatedPhase21OwnerCeremonyTrustForTests } from '../src/test-only/phase21-ceremony-test-hooks.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const CANARY_ENV: Phase21CanaryPayoutEnvObservations = {
  phase21MainnetEnabled: false,
  realChainEnabled: false,
  fakeChainEnabled: false,
  jettonMaster: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs',
  primaryProviderKind: 'toncenter',
  primaryProviderUrl: 'https://toncenter.com/api/v2/',
  secondaryProviderKind: 'tonapi',
  secondaryProviderUrl: 'https://tonapi.io/',
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

function cloneBag<T>(value: T): T {
  return structuredClone(value);
}

function mockPlanClient(overrides?: {
  readonly publicId?: string;
  readonly state?: string;
  readonly attemptCount?: number;
  readonly approvalCount?: number;
  readonly available?: string;
  readonly reserved?: string;
  readonly payoutDispatchPause?: boolean;
  readonly recipientFriendly?: string;
  readonly verified?: boolean;
  readonly networkCode?: string;
  readonly signatureEvidence?: number;
  readonly submitted?: number;
  readonly chainRef?: number;
  readonly broadcastStarted?: number;
  readonly ambiguous?: number;
  readonly permits?: Array<Record<string, unknown>>;
  readonly failOutboxInsert?: boolean;
}): Phase21CanaryPayoutPlanClient & {
  readonly state: {
    permits: Array<Record<string, unknown>>;
    outbox: Array<Record<string, unknown>>;
    audit: Array<Record<string, unknown>>;
  };
  readonly txn: {
    depth: number;
    readOnly: boolean;
  };
} {
  const publicId = overrides?.publicId ?? PHASE21_CANARY_PAYOUT_PUBLIC_ID;
  const state = overrides?.state ?? 'APPROVED';
  const attemptCount = overrides?.attemptCount ?? 0;
  const approvalCount = overrides?.approvalCount ?? 1;
  const available = overrides?.available ?? '0';
  const reserved = overrides?.reserved ?? '200000';
  const payoutDispatchPause = overrides?.payoutDispatchPause ?? true;
  const recipientFriendly =
    overrides?.recipientFriendly ?? 'EQD5XN7uWtm3r1vmzkg3N3zOYtX80OtyVf69IZwpINRXdc3l';
  const verified = overrides?.verified ?? true;
  const networkCode = overrides?.networkCode ?? 'TON_MAINNET';
  const signatureEvidence = overrides?.signatureEvidence ?? 0;
  const submitted = overrides?.submitted ?? 0;
  const chainRef = overrides?.chainRef ?? 0;
  const broadcastStarted = overrides?.broadcastStarted ?? 0;
  const ambiguous = overrides?.ambiguous ?? 0;
  const failOutboxInsert = overrides?.failOutboxInsert ?? false;
  const bag = {
    permits: overrides?.permits ?? ([] as Array<Record<string, unknown>>),
    outbox: [] as Array<Record<string, unknown>>,
    audit: [] as Array<Record<string, unknown>>,
  };
  let snapshot: typeof bag | null = null;
  const txn = { depth: 0, readOnly: false };

  const client = {
    state: bag,
    txn,
    async query(text: string, params?: readonly unknown[]) {
      const normalized = text.trim().toUpperCase();

      if (normalized === 'BEGIN READ ONLY' || text.includes('BEGIN READ ONLY')) {
        txn.depth += 1;
        txn.readOnly = true;
        return { rows: [] as unknown as [] };
      }
      if (normalized === 'BEGIN') {
        txn.depth += 1;
        txn.readOnly = false;
        snapshot = cloneBag(bag);
        return { rows: [] as unknown as [] };
      }
      if (normalized === 'COMMIT') {
        if (txn.depth <= 0) throw new Error('COMMIT without BEGIN');
        txn.depth -= 1;
        txn.readOnly = false;
        snapshot = null;
        return { rows: [] as unknown as [] };
      }
      if (normalized === 'ROLLBACK' || text.includes('ROLLBACK')) {
        if (txn.depth > 0) {
          txn.depth -= 1;
          if (!txn.readOnly && snapshot !== null) {
            bag.permits.splice(0, bag.permits.length, ...snapshot.permits);
            bag.outbox.splice(0, bag.outbox.length, ...snapshot.outbox);
            bag.audit.splice(0, bag.audit.length, ...snapshot.audit);
            snapshot = null;
          }
          txn.readOnly = false;
        }
        return { rows: [] as unknown as [] };
      }
      if (text.includes('SHOW transaction_read_only')) {
        return { rows: [{ transaction_read_only: txn.readOnly ? 'on' : 'off' }] };
      }
      if (text.includes('FROM withdrawals w')) {
        const row: Record<string, unknown> = {
          id: PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
          public_id: publicId,
          state,
          requested_amount_atomic: '200000',
          fee_amount_atomic: '10000',
          net_amount_atomic: '190000',
          user_id: '11111111-1111-4111-8111-111111111111',
          asset_id: '22222222-2222-4222-8222-222222222222',
          network_id: '33333333-3333-4333-8333-333333333333',
          wallet_id: '44444444-4444-4444-8444-444444444444',
          hot_wallet_id: '55555555-5555-4555-8555-555555555555',
          workflow_id: `withdrawal/${PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID}`,
          reservation_ledger_tx_id: '66666666-6666-4666-8666-666666666666',
          release_ledger_tx_id: null,
          settlement_ledger_tx_id: null,
        };
        if (text.includes('FOR UPDATE') || text.includes('network_code')) {
          row.network_code = networkCode;
        }
        return { rows: [row] };
      }
      if (text.includes('FROM withdrawal_approvals')) {
        return { rows: [{ c: approvalCount, approve_count: approvalCount }] };
      }
      if (text.includes('FROM withdrawal_attempts')) {
        return {
          rows: [
            {
              c: attemptCount,
              signature_evidence: signatureEvidence,
              submitted,
              chain_ref: chainRef,
              broadcast_started: broadcastStarted,
              ambiguous,
            },
          ],
        };
      }
      if (text.includes('FROM user_wallets')) {
        const rawAddress =
          recipientFriendly === 'EQD5XN7uWtm3r1vmzkg3N3zOYtX80OtyVf69IZwpINRXdc3l'
            ? '0:f95cdeee5ad9b7af5be6ce4837377cce62d5fcd0eb7255febd219c2920d45775'
            : '0:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
        return {
          rows: [
            {
              friendly_address: recipientFriendly,
              raw_address: rawAddress,
              is_primary: true,
              verified,
              verification_method: 'TON_PROOF',
              disabled_at: null,
              network_code: networkCode,
            },
          ],
        };
      }
      if (text.includes('USER_AVAILABLE_LIABILITY')) {
        return {
          rows: [
            { account_type: 'USER_AVAILABLE_LIABILITY', balance_atomic: available },
            { account_type: 'USER_RESERVED_LIABILITY', balance_atomic: reserved },
          ],
        };
      }
      if (text.includes('FROM networks WHERE id')) {
        return {
          rows: [
            {
              id: '33333333-3333-4333-8333-333333333333',
              code: networkCode,
              status: 'ACTIVE',
            },
          ],
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
          ],
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
          ],
        };
      }
      if (text.includes('FROM feature_flags')) {
        const key = String(params?.[0] ?? '');
        if (key === 'PAYOUT_DISPATCH_PAUSE') {
          return { rows: [{ enabled: payoutDispatchPause }] };
        }
        return { rows: [{ enabled: true }] };
      }
      if (text.includes('FROM phase21_manual_dispatch_permits') && text.includes('WHERE withdrawal_id')) {
        const id = String(params?.[0]);
        const row = bag.permits.find((p) => p.withdrawal_id === id);
        return { rows: row ? [row] : [] };
      }
      if (text.includes('INSERT INTO phase21_manual_dispatch_permits')) {
        if (txn.readOnly) throw new Error('cannot mutate in read-only txn');
        const withdrawalId = String(params?.[1]);
        if (bag.permits.some((p) => p.withdrawal_id === withdrawalId)) {
          return { rows: [] };
        }
        const row = {
          id: String(params?.[0]),
          withdrawal_id: withdrawalId,
          public_id: String(params?.[2]),
          authorized_gross_atomic: String(params?.[3]),
          authorized_fee_atomic: String(params?.[4]),
          authorized_net_atomic: String(params?.[5]),
          authorized_recipient_friendly: String(params?.[6]),
          authorized_recipient_raw: String(params?.[7]),
          authorized_network_code: String(params?.[8]),
          authorized_asset_symbol: String(params?.[9]),
          authorized_jetton_master: String(params?.[10]),
          authorized_attached_gram_atomic: String(params?.[11]),
          authorized_forward_gram_atomic: String(params?.[12]),
          status: 'ARMED',
          created_by_admin_user_id: String(params?.[13]),
          created_at: new Date('2026-10-06T00:00:00.000Z'),
          consumed_at: null,
          cancelled_at: null,
          cancel_reason: null,
          idempotency_key: String(params?.[14]),
          audit_correlation_id: params?.[15] ?? null,
        };
        bag.permits.push(row);
        return { rows: [row] };
      }
      if (text.includes('INSERT INTO audit_logs')) {
        if (txn.readOnly) throw new Error('cannot mutate in read-only txn');
        bag.audit.push({ text, params });
        return { rows: [{ id: 'audit-1' }] };
      }
      if (text.includes('INSERT INTO outbox_events')) {
        if (txn.readOnly) throw new Error('cannot mutate in read-only txn');
        if (failOutboxInsert) {
          throw new Error('simulated outbox insert failure');
        }
        const dedupe = String(params?.[4]);
        if (bag.outbox.some((o) => o.dedupe_key === dedupe)) {
          return { rows: [] };
        }
        const row = { id: `outbox-${bag.outbox.length + 1}`, dedupe_key: dedupe };
        bag.outbox.push(row);
        return { rows: [row] };
      }
      if (text.includes('SELECT id FROM outbox_events WHERE dedupe_key')) {
        const dedupe = String(params?.[0]);
        const row = bag.outbox.find((o) => o.dedupe_key === dedupe);
        return { rows: row ? [{ id: row.id }] : [] };
      }
      throw new Error(`unexpected SQL in apply test: ${text.slice(0, 140)}`);
    },
  };
  return client as unknown as Phase21CanaryPayoutPlanClient & {
    state: typeof bag;
    txn: typeof txn;
  };
}

function ownerTrust() {
  return mintAuthenticatedPhase21OwnerCeremonyTrustForTests({
    adminUserId: '11111111-1111-4111-8111-111111111111',
    currentDatabase: 'alex_rewards',
    systemIdentifier: 'test',
  });
}

describe('phase21 canary APPLY (arm permit only)', () => {
  beforeEach(() => {
    process.env.ALEX_PHASE21_CEREMONY_TEST_HOOKS = '1';
  });

  it('APPLY_ENABLED is true and CLI does not import sendBoc / runRealTestnetPayoutPipeline', () => {
    expect(PHASE21_CANARY_PAYOUT_APPLY_ENABLED).toBe(true);
    const cli = readFileSync(path.join(here, '../src/cli/phase21-canary-payout.ts'), 'utf8');
    expect(cli).toContain('applyPhase21CanaryPayout');
    expect(cli).toContain('confirmPhase21CanaryPayoutApplyInteractive');
    expect(cli).not.toMatch(/runRealTestnetPayoutPipeline/);
    expect(cli).not.toMatch(/claimFirstBroadcastSend/);
    expect(cli).not.toMatch(/sendBoc/);
    expect(cli).not.toMatch(/local-unlock|signerUnlock|unlockSigner/);
  });

  it('frozen bindings include canonical jetton / amounts / recipient', () => {
    expect(PHASE21_CANARY_MANUAL_DISPATCH_BINDINGS.withdrawalId).toBe(
      PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
    );
    expect(PHASE21_CANARY_MANUAL_DISPATCH_BINDINGS.publicId).toBe(PHASE21_CANARY_PAYOUT_PUBLIC_ID);
    expect(PHASE21_CANARY_MANUAL_DISPATCH_BINDINGS.authorizedJettonMaster).toBe(
      'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs',
    );
    expect(PHASE21_CANARY_MANUAL_DISPATCH_BINDINGS.authorizedGrossAtomic).toBe(200000n);
    expect(PHASE21_CANARY_MANUAL_DISPATCH_BINDINGS.authorizedFeeAtomic).toBe(10000n);
    expect(PHASE21_CANARY_MANUAL_DISPATCH_BINDINGS.authorizedNetAtomic).toBe(190000n);
    expect(PHASE21_CANARY_MANUAL_DISPATCH_BINDINGS.authorizedAttachedGramAtomic).toBe(50_000_000n);
    expect(PHASE21_CANARY_MANUAL_DISPATCH_BINDINGS.authorizedForwardGramAtomic).toBe(1n);
  });

  it('APPLY refuses wrong withdrawal UUID', async () => {
    const client = mockPlanClient();
    const result = await applyPhase21CanaryPayout(client as never, {
      withdrawalId: '00000000-0000-4000-8000-000000000099',
      ownerTrust: ownerTrust(),
      applyConfirmation: __mintPhase21CanaryPayoutApplyConfirmationForTests(),
      env: CANARY_ENV,
      signerProbe: LOCKED_SIGNER,
    });
    expect(result.ok).toBe(false);
    expect(result.refuseCode).toBe('CANARY_WITHDRAWAL_ID_MISMATCH');
    expect(result.applied).toBe(false);
    expect(result.outboxCreated).toBe(false);
    expect(result.outboxExisting).toBe(false);
    expect(result.outboxEnqueued).toBe(false);
    expect(result.broadcastPerformed).toBe(false);
    expect(result.signed).toBe(false);
  });

  it('APPLY refuses different Jetton master input override', async () => {
    const client = mockPlanClient();
    const result = await applyPhase21CanaryPayout(client as never, {
      withdrawalId: PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
      ownerTrust: ownerTrust(),
      applyConfirmation: __mintPhase21CanaryPayoutApplyConfirmationForTests(),
      env: CANARY_ENV,
      signerProbe: LOCKED_SIGNER,
      jettonMaster: 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c',
    });
    expect(result.ok).toBe(false);
    expect(result.applied).toBe(false);
    expect(result.refuseCode).toBe('CANARY_JETTON_MASTER_MISMATCH');
    expect(client.state.permits.length).toBe(0);
    expect(client.state.outbox.length).toBe(0);
    expect(client.state.audit.length).toBe(0);
  });

  it('APPLY accepts matching jettonMaster input and still arms frozen bindings only', async () => {
    const client = mockPlanClient();
    const result = await applyPhase21CanaryPayout(client as never, {
      withdrawalId: PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
      ownerTrust: ownerTrust(),
      applyConfirmation: __mintPhase21CanaryPayoutApplyConfirmationForTests(),
      env: CANARY_ENV,
      signerProbe: LOCKED_SIGNER,
      jettonMaster: PHASE21_CANARY_MANUAL_DISPATCH_BINDINGS.authorizedJettonMaster,
    });
    expect(result.ok).toBe(true);
    expect(result.applied).toBe(true);
    expect(client.state.permits[0]?.authorized_jetton_master).toBe(
      PHASE21_CANARY_MANUAL_DISPATCH_BINDINGS.authorizedJettonMaster,
    );
  });

  it('APPLY source never copies caller/env jettonMaster into mutation bindings', () => {
    const src = readFileSync(path.join(here, '../src/phase21-canary-payout-apply.ts'), 'utf8');
    expect(src).not.toMatch(/input\.env\?\.jettonMaster/);
    expect(src).toContain('PHASE21_CANARY_MANUAL_DISPATCH_BINDINGS');
    expect(src).toContain('CANARY_JETTON_MASTER_MISMATCH');
    const permitSrc = readFileSync(
      path.join(here, '../src/phase21-manual-dispatch-permit.ts'),
      'utf8',
    );
    expect(permitSrc).toContain('FOR UPDATE OF w, uw, a, n, wn');
    expect(permitSrc).toContain('JOIN networks wn ON wn.id = uw.network_id');
    expect(src).toMatch(/await client\.query\('BEGIN'\)/);
    expect(src).toMatch(/outboxCreated/);
    expect(src).toMatch(/outboxExisting/);
    expect(src).not.toMatch(/outbox\.created \|\| !outbox\.created/);
  });

  it('APPLY refuses wrong public ID / non-APPROVED / approvalCount / attempts / evidence / recipient / economics', async () => {
    const cases: Array<{ name: string; overrides: Parameters<typeof mockPlanClient>[0] }> = [
      { name: 'publicId', overrides: { publicId: 'WD-000002' } },
      { name: 'state', overrides: { state: 'PENDING' } },
      { name: 'approvals', overrides: { approvalCount: 2 } },
      { name: 'attempts', overrides: { attemptCount: 1 } },
      { name: 'signature', overrides: { signatureEvidence: 1 } },
      { name: 'submitted', overrides: { submitted: 1 } },
      { name: 'chain', overrides: { chainRef: 1 } },
      { name: 'broadcastStarted', overrides: { broadcastStarted: 1 } },
      { name: 'ambiguous', overrides: { ambiguous: 1 } },
      {
        name: 'recipient',
        overrides: { recipientFriendly: 'EQWrongRecipientAddressXXXXXXXXXXXXXXXXXXXXXXXXXXXX' },
      },
      { name: 'unverified', overrides: { verified: false } },
      { name: 'network', overrides: { networkCode: 'TON_TESTNET' } },
      { name: 'reserved', overrides: { reserved: '0' } },
      { name: 'available', overrides: { available: '200000' } },
    ];
    for (const c of cases) {
      const client = mockPlanClient(c.overrides);
      const result = await applyPhase21CanaryPayout(client as never, {
        withdrawalId: PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
        ownerTrust: ownerTrust(),
        applyConfirmation: __mintPhase21CanaryPayoutApplyConfirmationForTests(),
        env: CANARY_ENV,
        signerProbe: LOCKED_SIGNER,
      });
      expect(result.ok, c.name).toBe(false);
      expect(result.broadcastPerformed, c.name).toBe(false);
      expect(result.signed, c.name).toBe(false);
      expect(result.applied, c.name).toBe(false);
      expect(result.outboxEnqueued, c.name).toBe(false);
      expect(client.state.permits.length, c.name).toBe(0);
      expect(client.state.outbox.length, c.name).toBe(0);
    }
  });

  it('APPLY refuses provider non-independence', async () => {
    const client = mockPlanClient();
    const result = await applyPhase21CanaryPayout(client as never, {
      withdrawalId: PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
      ownerTrust: ownerTrust(),
      applyConfirmation: __mintPhase21CanaryPayoutApplyConfirmationForTests(),
      env: {
        ...CANARY_ENV,
        secondaryProviderKind: 'toncenter',
        secondaryProviderUrl: 'https://toncenter.com/api/v2/',
      },
      signerProbe: LOCKED_SIGNER,
    });
    expect(result.ok).toBe(false);
    expect(result.planChecksFailed?.includes('two_provider_reconciliation_independent')).toBe(true);
    expect(result.applied).toBe(false);
  });

  it('happy path arms permit once; duplicate APPLY reuses; truthful outbox flags; never broadcasts', async () => {
    const client = mockPlanClient();
    const trust = ownerTrust();
    const first = await applyPhase21CanaryPayout(client as never, {
      withdrawalId: PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
      ownerTrust: trust,
      applyConfirmation: __mintPhase21CanaryPayoutApplyConfirmationForTests(),
      env: CANARY_ENV,
      signerProbe: LOCKED_SIGNER,
    });
    expect(first.ok).toBe(true);
    expect(first.applied).toBe(true);
    expect(first.created).toBe(true);
    expect(first.permitStatus).toBe('ARMED');
    expect(first.outboxCreated).toBe(true);
    expect(first.outboxExisting).toBe(false);
    expect(first.outboxEnqueued).toBe(true);
    expect(first.broadcastPerformed).toBe(false);
    expect(first.signed).toBe(false);
    expect(first.generalDispatchPausePreserved).toBe(true);
    expect(first.autoPayoutStillDisabled).toBe(true);
    expect(first.generalWithdrawalIntakePreserved).toBe(true);
    expect(client.state.permits.length).toBe(1);
    expect(client.state.outbox.length).toBe(1);
    expect(client.state.audit.length).toBe(1);
    expect(client.txn.depth).toBe(0);

    const second = await applyPhase21CanaryPayout(client as never, {
      withdrawalId: PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
      ownerTrust: trust,
      applyConfirmation: __mintPhase21CanaryPayoutApplyConfirmationForTests(),
      env: CANARY_ENV,
      signerProbe: LOCKED_SIGNER,
    });
    expect(second.ok).toBe(true);
    expect(second.reused).toBe(true);
    expect(second.permitId).toBe(first.permitId);
    expect(second.outboxCreated).toBe(false);
    expect(second.outboxExisting).toBe(true);
    expect(second.outboxEnqueued).toBe(true);
    expect(client.state.permits.length).toBe(1);
    expect(client.state.outbox.length).toBe(1);
    expect(second.broadcastPerformed).toBe(false);
  });

  it('outbox insert failure after permit insert ROLLBACKs all; applied=false', async () => {
    const client = mockPlanClient({ failOutboxInsert: true });
    const result = await applyPhase21CanaryPayout(client as never, {
      withdrawalId: PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
      ownerTrust: ownerTrust(),
      applyConfirmation: __mintPhase21CanaryPayoutApplyConfirmationForTests(),
      env: CANARY_ENV,
      signerProbe: LOCKED_SIGNER,
    });
    expect(result.ok).toBe(false);
    expect(result.applied).toBe(false);
    expect(result.refuseCode).toBe('CANARY_APPLY_MUTATION_FAILED');
    expect(result.outboxCreated).toBe(false);
    expect(result.outboxExisting).toBe(false);
    expect(result.outboxEnqueued).toBe(false);
    expect(client.state.permits.length).toBe(0);
    expect(client.state.audit.length).toBe(0);
    expect(client.state.outbox.length).toBe(0);
    expect(client.txn.depth).toBe(0);
  });

  it('workstation signer fetch failure does not unlock; APPLY still arms when other checks pass', async () => {
    const client = mockPlanClient();
    const result = await applyPhase21CanaryPayout(client as never, {
      withdrawalId: PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
      ownerTrust: ownerTrust(),
      applyConfirmation: __mintPhase21CanaryPayoutApplyConfirmationForTests(),
      env: CANARY_ENV,
      signerProbe: {
        performed: true,
        reachable: false,
        signingReady: null,
        custodyState: null,
        locked: null,
        detail: 'fetch failed',
      },
    });
    expect(result.ok).toBe(true);
    expect(result.applied).toBe(true);
    expect(result.outboxCreated).toBe(true);
    expect(result.broadcastPerformed).toBe(false);
    expect(result.signed).toBe(false);
  });

  it('APPLY refuses when signer is unlocked', async () => {
    const client = mockPlanClient();
    const result = await applyPhase21CanaryPayout(client as never, {
      withdrawalId: PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
      ownerTrust: ownerTrust(),
      applyConfirmation: __mintPhase21CanaryPayoutApplyConfirmationForTests(),
      env: CANARY_ENV,
      signerProbe: {
        performed: true,
        reachable: true,
        signingReady: true,
        custodyState: 'UNLOCKED',
        locked: false,
        detail: null,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.applied).toBe(false);
    expect(result.broadcastPerformed).toBe(false);
  });

  it('results never include secrets', async () => {
    const client = mockPlanClient();
    const result = await applyPhase21CanaryPayout(client as never, {
      withdrawalId: PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
      ownerTrust: ownerTrust(),
      applyConfirmation: __mintPhase21CanaryPayoutApplyConfirmationForTests(),
      env: CANARY_ENV,
      signerProbe: LOCKED_SIGNER,
    });
    const json = JSON.stringify(result);
    expect(json).not.toMatch(/password|private[_-]?key|SERVICE_TOKEN|BEGIN PRIVATE/i);
  });
});
