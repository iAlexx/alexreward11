import { describe, expect, it, vi } from 'vitest';

import {
  armPhase21ManualDispatchPermit,
  assertPhase21ManualDispatchLiveBindingsOrThrow,
  bindPhase21ManualDispatchPermitToAttempt,
  consumePhase21ManualDispatchPermit,
  evaluatePhase21ManualDispatchPauseGate,
  evaluatePhase21ManualDispatchRestartSafety,
  phase21CanaryManualDispatchIdempotencyKey,
  type Phase21ManualDispatchPermitBindings,
  type Phase21ManualDispatchPermitRow,
} from '../src/phase21-manual-dispatch-permit.js';
import {
  PHASE21_CANARY_ATTACHED_GRAM_ATOMIC,
  PHASE21_CANARY_FORWARD_TON_ATOMIC,
  PHASE21_CANARY_PAYOUT_EXPECTED_FEE_ATOMIC,
  PHASE21_CANARY_PAYOUT_EXPECTED_GROSS_ATOMIC,
  PHASE21_CANARY_PAYOUT_EXPECTED_NET_ATOMIC,
  PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_FRIENDLY,
  PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_RAW,
  PHASE21_CANARY_PAYOUT_PUBLIC_ID,
  PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
} from '../src/phase21-canary-payout-plan.js';

const CANARY_BINDINGS: Phase21ManualDispatchPermitBindings = {
  withdrawalId: PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
  publicId: PHASE21_CANARY_PAYOUT_PUBLIC_ID,
  authorizedGrossAtomic: PHASE21_CANARY_PAYOUT_EXPECTED_GROSS_ATOMIC,
  authorizedFeeAtomic: PHASE21_CANARY_PAYOUT_EXPECTED_FEE_ATOMIC,
  authorizedNetAtomic: PHASE21_CANARY_PAYOUT_EXPECTED_NET_ATOMIC,
  authorizedRecipientFriendly: PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_FRIENDLY,
  authorizedRecipientRaw: PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_RAW,
  authorizedNetworkCode: 'TON_MAINNET',
  authorizedAssetSymbol: 'USDT',
  authorizedJettonMaster: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs',
  authorizedAttachedGramAtomic: PHASE21_CANARY_ATTACHED_GRAM_ATOMIC,
  authorizedForwardGramAtomic: PHASE21_CANARY_FORWARD_TON_ATOMIC,
};

type Row = Record<string, unknown>;

function makePermitClient(state: {
  permits: Row[];
  pauseEnabled: boolean;
  audit: Row[];
  outbox: Row[];
  attempts?: Row[];
  liveWithdrawal?: Row | null;
}) {
  const attempts = state.attempts ?? [];
  return {
    async query(text: string, params?: readonly unknown[]) {
      if (text.includes('FROM feature_flags') && text.includes('PAYOUT_DISPATCH_PAUSE')) {
        return { rows: [{ enabled: state.pauseEnabled }] };
      }
      if (
        text.includes('FROM withdrawal_attempts') &&
        text.includes('FOR UPDATE') &&
        text.includes('withdrawal_id')
      ) {
        const attemptId = String(params?.[0]);
        const withdrawalId = String(params?.[1]);
        if (attempts.length === 0) {
          // Legacy tests that do not seed attempts: treat ownership as OK.
          return { rows: [{ id: attemptId }] };
        }
        const row = attempts.find(
          (a) => a.id === attemptId && a.withdrawal_id === withdrawalId,
        );
        return { rows: row ? [{ id: row.id }] : [] };
      }
      if (
        text.includes('FROM withdrawal_attempts') &&
        text.includes("IN ('PENDING', 'UNKNOWN', 'RECONCILE_REQUIRED')")
      ) {
        const withdrawalId = String(params?.[0]);
        const row = [...attempts]
          .filter(
            (a) =>
              a.withdrawal_id === withdrawalId &&
              ['PENDING', 'UNKNOWN', 'RECONCILE_REQUIRED'].includes(
                String(a.broadcast_result_state),
              ),
          )
          .sort((a, b) => Number(b.attempt_number ?? 0) - Number(a.attempt_number ?? 0))[0];
        return { rows: row ? [{ id: row.id }] : [] };
      }
      if (
        text.includes('FROM withdrawal_attempts') &&
        text.includes('ORDER BY attempt_number DESC') &&
        text.includes('LIMIT 1') &&
        !text.includes('broadcast_result_state')
      ) {
        const withdrawalId = String(params?.[0]);
        const row = [...attempts]
          .filter((a) => a.withdrawal_id === withdrawalId)
          .sort((a, b) => Number(b.attempt_number ?? 0) - Number(a.attempt_number ?? 0))[0];
        return { rows: row ? [{ id: row.id }] : [] };
      }
      if (
        text.includes('FROM withdrawal_attempts') &&
        text.includes('broadcast_result_state') &&
        text.includes('WHERE id =')
      ) {
        const attemptId = String(params?.[0]);
        const row = attempts.find((a) => a.id === attemptId);
        return {
          rows: row
            ? [{ broadcast_result_state: row.broadcast_result_state ?? 'PENDING' }]
            : [],
        };
      }
      if (
        text.includes('FROM withdrawal_attempts') &&
        text.includes('AS attempt_count')
      ) {
        const withdrawalId = String(params?.[0]);
        const count = attempts.filter((a) => a.withdrawal_id === withdrawalId).length;
        return { rows: [{ attempt_count: count }] };
      }
      if (
        text.includes('FROM withdrawal_attempts a') &&
        text.includes('JOIN withdrawals w') &&
        text.includes('WHERE a.id')
      ) {
        const attemptId = String(params?.[0]);
        const row = attempts.find((a) => a.id === attemptId);
        if (!row) return { rows: [] };
        return {
          rows: [
            {
              id: row.id,
              withdrawal_id: row.withdrawal_id,
              broadcast_result_state: row.broadcast_result_state ?? 'PENDING',
              signed_external_message_boc: row.signed_external_message_boc ?? null,
              signed_wallet_request_boc: row.signed_wallet_request_boc ?? null,
              external_message_cell_hash: row.external_message_cell_hash ?? null,
              normalized_external_message_hash: row.normalized_external_message_hash ?? null,
              signed_message_hash: row.signed_message_hash ?? null,
              broadcast_submitted_at: row.broadcast_submitted_at ?? null,
              chain_reference: row.chain_reference ?? null,
              withdrawal_state: row.withdrawal_state ?? 'APPROVED',
            },
          ],
        };
      }
      if (
        text.includes('FROM withdrawals w') &&
        text.includes('JOIN networks n') &&
        text.includes('FOR UPDATE OF w, uw, a, n, wn')
      ) {
        if (state.liveWithdrawal == null) return { rows: [] };
        return { rows: [state.liveWithdrawal] };
      }
      if (text.includes('FROM phase21_manual_dispatch_permits') && text.includes('WHERE withdrawal_id')) {
        const id = String(params?.[0]);
        const row = state.permits.find((p) => p.withdrawal_id === id);
        return { rows: row ? [row] : [] };
      }
      if (text.includes('INSERT INTO phase21_manual_dispatch_permits')) {
        const withdrawalId = String(params?.[1]);
        if (state.permits.some((p) => p.withdrawal_id === withdrawalId)) {
          return { rows: [] };
        }
        const row: Row = {
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
          consumed_attempt_id: null,
          created_by_admin_user_id: String(params?.[13]),
          created_at: new Date('2026-10-06T00:00:00.000Z'),
          consumed_at: null,
          cancelled_at: null,
          cancel_reason: null,
          idempotency_key: String(params?.[14]),
          audit_correlation_id: params?.[15] ?? null,
        };
        state.permits.push(row);
        return { rows: [row] };
      }
      if (text.includes('UPDATE phase21_manual_dispatch_permits') && text.includes('consumed_attempt_id')) {
        const withdrawalId = String(params?.[0]);
        const attemptId = params?.[1] !== undefined ? String(params[1]) : null;
        const row = state.permits.find((p) => p.withdrawal_id === withdrawalId && p.status === 'ARMED');
        if (!row) return { rows: [] };
        row.status = 'CONSUMED';
        row.consumed_at = new Date('2026-10-06T00:01:00.000Z');
        row.consumed_attempt_id = attemptId;
        return { rows: [row] };
      }
      if (text.includes('INSERT INTO audit_logs')) {
        state.audit.push({ text, params });
        return { rows: [{ id: 'audit-1' }] };
      }
      if (text.includes('INSERT INTO outbox_events')) {
        const dedupe = String(params?.[4]);
        if (state.outbox.some((o) => o.dedupe_key === dedupe)) {
          return { rows: [] };
        }
        const row = { id: `outbox-${state.outbox.length + 1}`, dedupe_key: dedupe };
        state.outbox.push(row);
        return { rows: [row] };
      }
      if (text.includes('SELECT id FROM outbox_events WHERE dedupe_key')) {
        const dedupe = String(params?.[0]);
        const row = state.outbox.find((o) => o.dedupe_key === dedupe);
        return { rows: row ? [{ id: row.id }] : [] };
      }
      throw new Error(`unexpected SQL: ${text.slice(0, 120)}`);
    },
  } as unknown as import('pg').PoolClient;
}

describe('phase21 manual dispatch permit', () => {
  it('creates one-shot ARMED permit and idempotently reuses on duplicate APPLY', async () => {
    const state = { permits: [] as Row[], pauseEnabled: true, audit: [] as Row[], outbox: [] as Row[] };
    const client = makePermitClient(state);
    const first = await armPhase21ManualDispatchPermit(client, {
      bindings: CANARY_BINDINGS,
      createdByAdminUserId: '11111111-1111-4111-8111-111111111111',
      idempotencyKey: phase21CanaryManualDispatchIdempotencyKey(CANARY_BINDINGS.withdrawalId),
    });
    expect(first.created).toBe(true);
    expect(first.permit.status).toBe('ARMED');
    expect(state.audit.length).toBe(1);

    const second = await armPhase21ManualDispatchPermit(client, {
      bindings: CANARY_BINDINGS,
      createdByAdminUserId: '11111111-1111-4111-8111-111111111111',
      idempotencyKey: phase21CanaryManualDispatchIdempotencyKey(CANARY_BINDINGS.withdrawalId),
    });
    expect(second.created).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.permit.id).toBe(first.permit.id);
    expect(state.permits.length).toBe(1);
  });

  it('concurrent arming cannot create two permits (ON CONFLICT winner reused)', async () => {
    const state = { permits: [] as Row[], pauseEnabled: true, audit: [] as Row[], outbox: [] as Row[] };
    const client = makePermitClient(state);
    // Pre-insert winner as if concurrent insert already committed
    state.permits.push({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      withdrawal_id: CANARY_BINDINGS.withdrawalId,
      public_id: CANARY_BINDINGS.publicId,
      authorized_gross_atomic: '200000',
      authorized_fee_atomic: '10000',
      authorized_net_atomic: '190000',
      authorized_recipient_friendly: CANARY_BINDINGS.authorizedRecipientFriendly,
      authorized_recipient_raw: CANARY_BINDINGS.authorizedRecipientRaw,
      authorized_network_code: 'TON_MAINNET',
      authorized_asset_symbol: 'USDT',
      authorized_jetton_master: CANARY_BINDINGS.authorizedJettonMaster,
      authorized_attached_gram_atomic: '50000000',
      authorized_forward_gram_atomic: '1',
      status: 'ARMED',
      created_by_admin_user_id: '11111111-1111-4111-8111-111111111111',
      created_at: new Date(),
      consumed_at: null,
      cancelled_at: null,
      cancel_reason: null,
      idempotency_key: phase21CanaryManualDispatchIdempotencyKey(CANARY_BINDINGS.withdrawalId),
      audit_correlation_id: null,
    });
    const result = await armPhase21ManualDispatchPermit(client, {
      bindings: CANARY_BINDINGS,
      createdByAdminUserId: '11111111-1111-4111-8111-111111111111',
      idempotencyKey: phase21CanaryManualDispatchIdempotencyKey(CANARY_BINDINGS.withdrawalId),
    });
    expect(result.reused).toBe(true);
    expect(state.permits.length).toBe(1);
  });

  it('wrong withdrawal cannot consume canary permit', async () => {
    const state = {
      permits: [
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          withdrawal_id: CANARY_BINDINGS.withdrawalId,
          public_id: CANARY_BINDINGS.publicId,
          authorized_gross_atomic: '200000',
          authorized_fee_atomic: '10000',
          authorized_net_atomic: '190000',
          authorized_recipient_friendly: CANARY_BINDINGS.authorizedRecipientFriendly,
          authorized_recipient_raw: CANARY_BINDINGS.authorizedRecipientRaw,
          authorized_network_code: 'TON_MAINNET',
          authorized_asset_symbol: 'USDT',
          authorized_jetton_master: CANARY_BINDINGS.authorizedJettonMaster,
          authorized_attached_gram_atomic: '50000000',
          authorized_forward_gram_atomic: '1',
          status: 'ARMED',
          created_by_admin_user_id: '11111111-1111-4111-8111-111111111111',
          created_at: new Date(),
          consumed_at: null,
          cancelled_at: null,
          cancel_reason: null,
          idempotency_key: 'k',
          audit_correlation_id: null,
        },
      ] as Row[],
      pauseEnabled: true,
      audit: [] as Row[],
      outbox: [] as Row[],
    };
    const client = makePermitClient(state);
    const other = await consumePhase21ManualDispatchPermit(client, {
      withdrawalId: '00000000-0000-4000-8000-000000000099',
      attemptId: '22222222-2222-4222-8222-222222222222',
    });
    expect(other.ok).toBe(false);
  });

  it('permit cannot be consumed twice (second call idempotent CONSUMED)', async () => {
    const attemptId = '22222222-2222-4222-8222-222222222222';
    const state = { permits: [] as Row[], pauseEnabled: true, audit: [] as Row[], outbox: [] as Row[] };
    const client = makePermitClient(state);
    await armPhase21ManualDispatchPermit(client, {
      bindings: CANARY_BINDINGS,
      createdByAdminUserId: '11111111-1111-4111-8111-111111111111',
      idempotencyKey: phase21CanaryManualDispatchIdempotencyKey(CANARY_BINDINGS.withdrawalId),
    });
    const first = await consumePhase21ManualDispatchPermit(client, {
      withdrawalId: CANARY_BINDINGS.withdrawalId,
      attemptId,
    });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.consumedNow).toBe(true);
    const second = await consumePhase21ManualDispatchPermit(client, {
      withdrawalId: CANARY_BINDINGS.withdrawalId,
      attemptId,
    });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.consumedNow).toBe(false);
      expect(second.permit.status).toBe('CONSUMED');
    }
  });

  it('general paused withdrawal remains paused without permit', async () => {
    const state = { permits: [] as Row[], pauseEnabled: true, audit: [] as Row[], outbox: [] as Row[] };
    const client = makePermitClient(state);
    const gate = await evaluatePhase21ManualDispatchPauseGate(client, {
      withdrawalId: '00000000-0000-4000-8000-000000000099',
      deploymentEnvironment: 'PRODUCTION',
    });
    expect(gate.paused).toBe(true);
    expect(gate.permitException).toBe(false);
    expect(gate.reason).toBe('PAYOUT_DISPATCH_PAUSE');
  });

  it('exact permitted WD-000001 may cross only the narrow Phase21 manual dispatch gate', async () => {
    const state = { permits: [] as Row[], pauseEnabled: true, audit: [] as Row[], outbox: [] as Row[] };
    const client = makePermitClient(state);
    await armPhase21ManualDispatchPermit(client, {
      bindings: CANARY_BINDINGS,
      createdByAdminUserId: '11111111-1111-4111-8111-111111111111',
      idempotencyKey: phase21CanaryManualDispatchIdempotencyKey(CANARY_BINDINGS.withdrawalId),
    });
    const gate = await evaluatePhase21ManualDispatchPauseGate(client, {
      withdrawalId: CANARY_BINDINGS.withdrawalId,
      deploymentEnvironment: 'PRODUCTION',
    });
    expect(gate.paused).toBe(false);
    expect(gate.permitException).toBe(true);
    expect(gate.permitStatus).toBe('ARMED');
  });

  it('no second approved withdrawal is processed by same pause-gate evaluation', async () => {
    const state = { permits: [] as Row[], pauseEnabled: true, audit: [] as Row[], outbox: [] as Row[] };
    const client = makePermitClient(state);
    await armPhase21ManualDispatchPermit(client, {
      bindings: CANARY_BINDINGS,
      createdByAdminUserId: '11111111-1111-4111-8111-111111111111',
      idempotencyKey: phase21CanaryManualDispatchIdempotencyKey(CANARY_BINDINGS.withdrawalId),
    });
    const canary = await evaluatePhase21ManualDispatchPauseGate(client, {
      withdrawalId: CANARY_BINDINGS.withdrawalId,
      deploymentEnvironment: 'PRODUCTION',
    });
    const other = await evaluatePhase21ManualDispatchPauseGate(client, {
      withdrawalId: '00000000-0000-4000-8000-000000000099',
      deploymentEnvironment: 'PRODUCTION',
    });
    expect(canary.paused).toBe(false);
    expect(other.paused).toBe(true);
  });


  it('refuses reuse when Jetton master binding differs', async () => {
    const state = { permits: [] as Row[], pauseEnabled: true, audit: [] as Row[], outbox: [] as Row[] };
    const client = makePermitClient(state);
    await armPhase21ManualDispatchPermit(client, {
      bindings: CANARY_BINDINGS,
      createdByAdminUserId: '11111111-1111-4111-8111-111111111111',
      idempotencyKey: phase21CanaryManualDispatchIdempotencyKey(CANARY_BINDINGS.withdrawalId),
    });
    await expect(
      armPhase21ManualDispatchPermit(client, {
        bindings: {
          ...CANARY_BINDINGS,
          authorizedJettonMaster: 'EQDifferentJettonMasterXXXXXXXXXXXXXXXXXXXXXXXXXX',
        },
        createdByAdminUserId: '11111111-1111-4111-8111-111111111111',
        idempotencyKey: phase21CanaryManualDispatchIdempotencyKey(CANARY_BINDINGS.withdrawalId),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('refuses reuse when network binding differs', async () => {
    const state = { permits: [] as Row[], pauseEnabled: true, audit: [] as Row[], outbox: [] as Row[] };
    const client = makePermitClient(state);
    await armPhase21ManualDispatchPermit(client, {
      bindings: CANARY_BINDINGS,
      createdByAdminUserId: '11111111-1111-4111-8111-111111111111',
      idempotencyKey: phase21CanaryManualDispatchIdempotencyKey(CANARY_BINDINGS.withdrawalId),
    });
    await expect(
      armPhase21ManualDispatchPermit(client, {
        bindings: { ...CANARY_BINDINGS, authorizedNetworkCode: 'TON_TESTNET' },
        createdByAdminUserId: '11111111-1111-4111-8111-111111111111',
        idempotencyKey: phase21CanaryManualDispatchIdempotencyKey(CANARY_BINDINGS.withdrawalId),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('refuses reuse when asset binding differs', async () => {
    const state = { permits: [] as Row[], pauseEnabled: true, audit: [] as Row[], outbox: [] as Row[] };
    const client = makePermitClient(state);
    await armPhase21ManualDispatchPermit(client, {
      bindings: CANARY_BINDINGS,
      createdByAdminUserId: '11111111-1111-4111-8111-111111111111',
      idempotencyKey: phase21CanaryManualDispatchIdempotencyKey(CANARY_BINDINGS.withdrawalId),
    });
    await expect(
      armPhase21ManualDispatchPermit(client, {
        bindings: { ...CANARY_BINDINGS, authorizedAssetSymbol: 'TON' },
        createdByAdminUserId: '11111111-1111-4111-8111-111111111111',
        idempotencyKey: phase21CanaryManualDispatchIdempotencyKey(CANARY_BINDINGS.withdrawalId),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('refuses reuse when attached GRAM binding differs', async () => {
    const state = { permits: [] as Row[], pauseEnabled: true, audit: [] as Row[], outbox: [] as Row[] };
    const client = makePermitClient(state);
    await armPhase21ManualDispatchPermit(client, {
      bindings: CANARY_BINDINGS,
      createdByAdminUserId: '11111111-1111-4111-8111-111111111111',
      idempotencyKey: phase21CanaryManualDispatchIdempotencyKey(CANARY_BINDINGS.withdrawalId),
    });
    await expect(
      armPhase21ManualDispatchPermit(client, {
        bindings: { ...CANARY_BINDINGS, authorizedAttachedGramAtomic: 1n },
        createdByAdminUserId: '11111111-1111-4111-8111-111111111111',
        idempotencyKey: phase21CanaryManualDispatchIdempotencyKey(CANARY_BINDINGS.withdrawalId),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('refuses reuse when forward GRAM binding differs', async () => {
    const state = { permits: [] as Row[], pauseEnabled: true, audit: [] as Row[], outbox: [] as Row[] };
    const client = makePermitClient(state);
    await armPhase21ManualDispatchPermit(client, {
      bindings: CANARY_BINDINGS,
      createdByAdminUserId: '11111111-1111-4111-8111-111111111111',
      idempotencyKey: phase21CanaryManualDispatchIdempotencyKey(CANARY_BINDINGS.withdrawalId),
    });
    await expect(
      armPhase21ManualDispatchPermit(client, {
        bindings: { ...CANARY_BINDINGS, authorizedForwardGramAtomic: 2n },
        createdByAdminUserId: '11111111-1111-4111-8111-111111111111',
        idempotencyKey: phase21CanaryManualDispatchIdempotencyKey(CANARY_BINDINGS.withdrawalId),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('CONSUMED permit bound to attempt A cannot bind a fresh attempt B', async () => {
    const state = { permits: [] as Row[], pauseEnabled: true, audit: [] as Row[], outbox: [] as Row[] };
    const client = makePermitClient(state);
    await armPhase21ManualDispatchPermit(client, {
      bindings: CANARY_BINDINGS,
      createdByAdminUserId: '11111111-1111-4111-8111-111111111111',
      idempotencyKey: phase21CanaryManualDispatchIdempotencyKey(CANARY_BINDINGS.withdrawalId),
    });
    const attemptA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const attemptB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const first = await bindPhase21ManualDispatchPermitToAttempt(client, {
      withdrawalId: CANARY_BINDINGS.withdrawalId,
      attemptId: attemptA,
    });
    expect(first.ok).toBe(true);
    if (first.ok && !('noop' in first && first.noop)) {
      expect('boundNow' in first && first.boundNow).toBe(true);
    }
    const second = await bindPhase21ManualDispatchPermitToAttempt(client, {
      withdrawalId: CANARY_BINDINGS.withdrawalId,
      attemptId: attemptB,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe('PHASE21_MANUAL_DISPATCH_PERMIT_ATTEMPT_CONFLICT');
    }
  });



  it('CONSUMED gate requires exact attempt match; mismatch fail closed', async () => {
    const attemptA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const attemptB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const state = {
      permits: [
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          withdrawal_id: CANARY_BINDINGS.withdrawalId,
          public_id: CANARY_BINDINGS.publicId,
          authorized_gross_atomic: '200000',
          authorized_fee_atomic: '10000',
          authorized_net_atomic: '190000',
          authorized_recipient_friendly: CANARY_BINDINGS.authorizedRecipientFriendly,
          authorized_recipient_raw: CANARY_BINDINGS.authorizedRecipientRaw,
          authorized_network_code: 'TON_MAINNET',
          authorized_asset_symbol: 'USDT',
          authorized_jetton_master: CANARY_BINDINGS.authorizedJettonMaster,
          authorized_attached_gram_atomic: '50000000',
          authorized_forward_gram_atomic: '1',
          status: 'CONSUMED',
          consumed_attempt_id: attemptA,
          created_by_admin_user_id: '11111111-1111-4111-8111-111111111111',
          created_at: new Date(),
          consumed_at: new Date(),
          cancelled_at: null,
          cancel_reason: null,
          idempotency_key: 'k',
          audit_correlation_id: null,
        },
      ] as Row[],
      pauseEnabled: true,
      audit: [] as Row[],
      outbox: [] as Row[],
      attempts: [
        {
          id: attemptA,
          withdrawal_id: CANARY_BINDINGS.withdrawalId,
          attempt_number: 1,
          broadcast_result_state: 'PENDING',
        },
        {
          id: attemptB,
          withdrawal_id: CANARY_BINDINGS.withdrawalId,
          attempt_number: 2,
          broadcast_result_state: 'PENDING',
        },
      ] as Row[],
    };
    const client = makePermitClient(state);
    const mismatch = await evaluatePhase21ManualDispatchPauseGate(client, {
      withdrawalId: CANARY_BINDINGS.withdrawalId,
      deploymentEnvironment: 'PRODUCTION',
      currentAttemptId: attemptB,
    });
    expect(mismatch.paused).toBe(true);
    expect(mismatch.reason).toBe('PHASE21_MANUAL_DISPATCH_PERMIT_ATTEMPT_MISMATCH');

    const match = await evaluatePhase21ManualDispatchPauseGate(client, {
      withdrawalId: CANARY_BINDINGS.withdrawalId,
      deploymentEnvironment: 'PRODUCTION',
      currentAttemptId: attemptA,
    });
    expect(match.paused).toBe(false);
    expect(match.permitException).toBe(true);
  });

  it('CONSUMED gate does not allow merely because bound attempt exists', async () => {
    const attemptA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const state = {
      permits: [
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          withdrawal_id: CANARY_BINDINGS.withdrawalId,
          public_id: CANARY_BINDINGS.publicId,
          authorized_gross_atomic: '200000',
          authorized_fee_atomic: '10000',
          authorized_net_atomic: '190000',
          authorized_recipient_friendly: CANARY_BINDINGS.authorizedRecipientFriendly,
          authorized_recipient_raw: CANARY_BINDINGS.authorizedRecipientRaw,
          authorized_network_code: 'TON_MAINNET',
          authorized_asset_symbol: 'USDT',
          authorized_jetton_master: CANARY_BINDINGS.authorizedJettonMaster,
          authorized_attached_gram_atomic: '50000000',
          authorized_forward_gram_atomic: '1',
          status: 'CONSUMED',
          consumed_attempt_id: attemptA,
          created_by_admin_user_id: '11111111-1111-4111-8111-111111111111',
          created_at: new Date(),
          consumed_at: new Date(),
          cancelled_at: null,
          cancel_reason: null,
          idempotency_key: 'k',
          audit_correlation_id: null,
        },
      ] as Row[],
      pauseEnabled: true,
      audit: [] as Row[],
      outbox: [] as Row[],
      // No attempts for THIS withdrawal → resolve fails → mismatch (not "exists therefore allow")
      attempts: [] as Row[],
    };
    const client = makePermitClient(state);
    const gate = await evaluatePhase21ManualDispatchPauseGate(client, {
      withdrawalId: CANARY_BINDINGS.withdrawalId,
      deploymentEnvironment: 'PRODUCTION',
    });
    expect(gate.paused).toBe(true);
    expect(gate.reason).toBe('PHASE21_MANUAL_DISPATCH_PERMIT_ATTEMPT_MISMATCH');
  });

  it('cannot bind permit to attempt belonging to another withdrawal', async () => {
    const attemptId = '22222222-2222-4222-8222-222222222222';
    const otherWd = '00000000-0000-4000-8000-000000000099';
    const state = {
      permits: [] as Row[],
      pauseEnabled: true,
      audit: [] as Row[],
      outbox: [] as Row[],
      attempts: [
        {
          id: attemptId,
          withdrawal_id: otherWd,
          attempt_number: 1,
          broadcast_result_state: 'PENDING',
        },
      ] as Row[],
    };
    const client = makePermitClient(state);
    await armPhase21ManualDispatchPermit(client, {
      bindings: CANARY_BINDINGS,
      createdByAdminUserId: '11111111-1111-4111-8111-111111111111',
      idempotencyKey: phase21CanaryManualDispatchIdempotencyKey(CANARY_BINDINGS.withdrawalId),
    });
    const bound = await bindPhase21ManualDispatchPermitToAttempt(client, {
      withdrawalId: CANARY_BINDINGS.withdrawalId,
      attemptId,
    });
    expect(bound.ok).toBe(false);
    if (!bound.ok) {
      expect(bound.reason).toBe('PHASE21_MANUAL_DISPATCH_PERMIT_ATTEMPT_OWNERSHIP');
    }
    expect(state.permits[0]!.status).toBe('ARMED');
  });

  it('restart safety: ARMED + no attempt still allowDuplicate', async () => {
    const state = {
      permits: [] as Row[],
      pauseEnabled: true,
      audit: [] as Row[],
      outbox: [] as Row[],
      attempts: [] as Row[],
    };
    const client = makePermitClient(state);
    await armPhase21ManualDispatchPermit(client, {
      bindings: CANARY_BINDINGS,
      createdByAdminUserId: '11111111-1111-4111-8111-111111111111',
      idempotencyKey: phase21CanaryManualDispatchIdempotencyKey(CANARY_BINDINGS.withdrawalId),
    });
    const safety = await evaluatePhase21ManualDispatchRestartSafety(
      client,
      CANARY_BINDINGS.withdrawalId,
    );
    expect(safety.allowDuplicate).toBe(true);
  });

  it('restart safety negatives: missing/wrong/failed_pre/signature/submitted/chain/UNKNOWN/RECONCILE/CONFIRMED', async () => {
    const attemptId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    async function safetyFor(attempt: Row) {
      const state = {
        permits: [
          {
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            withdrawal_id: CANARY_BINDINGS.withdrawalId,
            public_id: CANARY_BINDINGS.publicId,
            authorized_gross_atomic: '200000',
            authorized_fee_atomic: '10000',
            authorized_net_atomic: '190000',
            authorized_recipient_friendly: CANARY_BINDINGS.authorizedRecipientFriendly,
            authorized_recipient_raw: CANARY_BINDINGS.authorizedRecipientRaw,
            authorized_network_code: 'TON_MAINNET',
            authorized_asset_symbol: 'USDT',
            authorized_jetton_master: CANARY_BINDINGS.authorizedJettonMaster,
            authorized_attached_gram_atomic: '50000000',
            authorized_forward_gram_atomic: '1',
            status: 'CONSUMED',
            consumed_attempt_id: attemptId,
            created_by_admin_user_id: '11111111-1111-4111-8111-111111111111',
            created_at: new Date(),
            consumed_at: new Date(),
            cancelled_at: null,
            cancel_reason: null,
            idempotency_key: 'k',
            audit_correlation_id: null,
          },
        ] as Row[],
        pauseEnabled: true,
        audit: [] as Row[],
        outbox: [] as Row[],
        attempts: [attempt] as Row[],
      };
      return evaluatePhase21ManualDispatchRestartSafety(
        makePermitClient(state),
        CANARY_BINDINGS.withdrawalId,
      );
    }

    expect(
      (
        await safetyFor({
          id: attemptId,
          withdrawal_id: CANARY_BINDINGS.withdrawalId,
          broadcast_result_state: 'FAILED_PRE_BROADCAST',
        })
      ).reason,
    ).toBe('consumed_failed_pre_use_owner_gated_retry');

    expect(
      (
        await safetyFor({
          id: attemptId,
          withdrawal_id: '00000000-0000-4000-8000-000000000099',
          broadcast_result_state: 'PENDING',
        })
      ).reason,
    ).toBe('bound_attempt_wrong_withdrawal');

    const missingState = {
      permits: [
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          withdrawal_id: CANARY_BINDINGS.withdrawalId,
          public_id: CANARY_BINDINGS.publicId,
          authorized_gross_atomic: '200000',
          authorized_fee_atomic: '10000',
          authorized_net_atomic: '190000',
          authorized_recipient_friendly: CANARY_BINDINGS.authorizedRecipientFriendly,
          authorized_recipient_raw: CANARY_BINDINGS.authorizedRecipientRaw,
          authorized_network_code: 'TON_MAINNET',
          authorized_asset_symbol: 'USDT',
          authorized_jetton_master: CANARY_BINDINGS.authorizedJettonMaster,
          authorized_attached_gram_atomic: '50000000',
          authorized_forward_gram_atomic: '1',
          status: 'CONSUMED',
          consumed_attempt_id: attemptId,
          created_by_admin_user_id: '11111111-1111-4111-8111-111111111111',
          created_at: new Date(),
          consumed_at: new Date(),
          cancelled_at: null,
          cancel_reason: null,
          idempotency_key: 'k',
          audit_correlation_id: null,
        },
      ] as Row[],
      pauseEnabled: true,
      audit: [] as Row[],
      outbox: [] as Row[],
      attempts: [] as Row[],
    };
    expect(
      (
        await evaluatePhase21ManualDispatchRestartSafety(
          makePermitClient(missingState),
          CANARY_BINDINGS.withdrawalId,
        )
      ).reason,
    ).toBe('missing_bound_attempt');

    for (const [field, value] of [
      ['signed_external_message_boc', 'boc'],
      ['broadcast_submitted_at', new Date()],
      ['chain_reference', 'msg-hash'],
    ] as const) {
      const row: Row = {
        id: attemptId,
        withdrawal_id: CANARY_BINDINGS.withdrawalId,
        broadcast_result_state: 'PENDING',
        [field]: value,
      };
      expect((await safetyFor(row)).reason).toBe('reconcile_required_no_restart');
    }

    for (const stateName of ['UNKNOWN', 'RECONCILE_REQUIRED', 'BROADCASTED'] as const) {
      expect(
        (
          await safetyFor({
            id: attemptId,
            withdrawal_id: CANARY_BINDINGS.withdrawalId,
            broadcast_result_state: stateName,
          })
        ).reason,
      ).toBe('reconcile_required_no_restart');
    }

    expect(
      (
        await safetyFor({
          id: attemptId,
          withdrawal_id: CANARY_BINDINGS.withdrawalId,
          broadcast_result_state: 'PENDING',
          withdrawal_state: 'CONFIRMED',
        })
      ).reason,
    ).toBe('reconcile_required_no_restart');
  });

  it('frozen binding validation rejects jetton/network/amount/recipient mismatch', async () => {
    const baseLive: Row = {
      id: CANARY_BINDINGS.withdrawalId,
      public_id: CANARY_BINDINGS.publicId,
      requested_amount_atomic: '200000',
      fee_amount_atomic: '10000',
      net_amount_atomic: '190000',
      network_code: 'TON_MAINNET',
      wallet_network_code: 'TON_MAINNET',
      asset_symbol: 'USDT',
      asset_decimals: 6,
      contract_identity: CANARY_BINDINGS.authorizedJettonMaster,
      wallet_id: '11111111-1111-4111-8111-111111111111',
      recipient_friendly: CANARY_BINDINGS.authorizedRecipientFriendly,
      recipient_raw: CANARY_BINDINGS.authorizedRecipientRaw,
      wallet_verified: true,
      wallet_disabled_at: null,
    };
    const permitRow: Phase21ManualDispatchPermitRow = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      withdrawalId: CANARY_BINDINGS.withdrawalId,
      publicId: CANARY_BINDINGS.publicId,
      authorizedGrossAtomic: '200000',
      authorizedFeeAtomic: '10000',
      authorizedNetAtomic: '190000',
      authorizedRecipientFriendly: CANARY_BINDINGS.authorizedRecipientFriendly,
      authorizedRecipientRaw: CANARY_BINDINGS.authorizedRecipientRaw,
      authorizedNetworkCode: 'TON_MAINNET',
      authorizedAssetSymbol: 'USDT',
      authorizedJettonMaster: CANARY_BINDINGS.authorizedJettonMaster,
      authorizedAttachedGramAtomic: '50000000',
      authorizedForwardGramAtomic: '1',
      status: 'ARMED',
      consumedAttemptId: null,
      createdByAdminUserId: '11111111-1111-4111-8111-111111111111',
      createdAt: new Date(),
      consumedAt: null,
      cancelledAt: null,
      cancelReason: null,
      idempotencyKey: 'k',
      auditCorrelationId: null,
    };

    const okClient = makePermitClient({
      permits: [],
      pauseEnabled: true,
      audit: [],
      outbox: [],
      liveWithdrawal: baseLive,
    });
    await expect(
      assertPhase21ManualDispatchLiveBindingsOrThrow(okClient, {
        withdrawalId: CANARY_BINDINGS.withdrawalId,
        permit: permitRow,
      }),
    ).resolves.toBeUndefined();

    for (const bad of [
      { ...baseLive, contract_identity: 'EQ_WRONG_JETTON' },
      { ...baseLive, network_code: 'TON_TESTNET' },
      { ...baseLive, requested_amount_atomic: '999' },
      { ...baseLive, recipient_friendly: 'EQ_OTHER' },
    ]) {
      const client = makePermitClient({
        permits: [],
        pauseEnabled: true,
        audit: [],
        outbox: [],
        liveWithdrawal: bad,
      });
      await expect(
        assertPhase21ManualDispatchLiveBindingsOrThrow(client, {
          withdrawalId: CANARY_BINDINGS.withdrawalId,
          permit: permitRow,
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    }
  });


  it('live binding SQL locks withdrawal, wallet, asset, and network rows', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(
      path.join(here, '../src/phase21-manual-dispatch-permit.ts'),
      'utf8',
    );
    expect(src).toContain('FOR UPDATE OF w, uw, a, n, wn');
    expect(src).toContain('JOIN networks wn ON wn.id = uw.network_id');
    expect(src).toContain('wallet_network_code');
  });

  it('USDT decimals must be exactly 6 (NULL and non-6 fail closed)', async () => {
    const baseLive: Row = {
      id: CANARY_BINDINGS.withdrawalId,
      public_id: CANARY_BINDINGS.publicId,
      requested_amount_atomic: '200000',
      fee_amount_atomic: '10000',
      net_amount_atomic: '190000',
      network_code: 'TON_MAINNET',
      wallet_network_code: 'TON_MAINNET',
      asset_symbol: 'USDT',
      asset_decimals: 6,
      contract_identity: CANARY_BINDINGS.authorizedJettonMaster,
      wallet_id: '11111111-1111-4111-8111-111111111111',
      recipient_friendly: CANARY_BINDINGS.authorizedRecipientFriendly,
      recipient_raw: CANARY_BINDINGS.authorizedRecipientRaw,
      wallet_verified: true,
      wallet_disabled_at: null,
    };
    const permitRow: Phase21ManualDispatchPermitRow = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      withdrawalId: CANARY_BINDINGS.withdrawalId,
      publicId: CANARY_BINDINGS.publicId,
      authorizedGrossAtomic: '200000',
      authorizedFeeAtomic: '10000',
      authorizedNetAtomic: '190000',
      authorizedRecipientFriendly: CANARY_BINDINGS.authorizedRecipientFriendly,
      authorizedRecipientRaw: CANARY_BINDINGS.authorizedRecipientRaw,
      authorizedNetworkCode: 'TON_MAINNET',
      authorizedAssetSymbol: 'USDT',
      authorizedJettonMaster: CANARY_BINDINGS.authorizedJettonMaster,
      authorizedAttachedGramAtomic: '50000000',
      authorizedForwardGramAtomic: '1',
      status: 'ARMED',
      consumedAttemptId: null,
      createdByAdminUserId: '11111111-1111-4111-8111-111111111111',
      createdAt: new Date(),
      consumedAt: null,
      cancelledAt: null,
      cancelReason: null,
      idempotencyKey: 'k',
      auditCorrelationId: null,
    };

    await expect(
      assertPhase21ManualDispatchLiveBindingsOrThrow(
        makePermitClient({
          permits: [],
          pauseEnabled: true,
          audit: [],
          outbox: [],
          liveWithdrawal: baseLive,
        }),
        { withdrawalId: CANARY_BINDINGS.withdrawalId, permit: permitRow },
      ),
    ).resolves.toBeUndefined();

    for (const asset_decimals of [null, 9, 0, 18]) {
      await expect(
        assertPhase21ManualDispatchLiveBindingsOrThrow(
          makePermitClient({
            permits: [],
            pauseEnabled: true,
            audit: [],
            outbox: [],
            liveWithdrawal: { ...baseLive, asset_decimals },
          }),
          { withdrawalId: CANARY_BINDINGS.withdrawalId, permit: permitRow },
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    }

    await expect(
      assertPhase21ManualDispatchLiveBindingsOrThrow(
        makePermitClient({
          permits: [],
          pauseEnabled: true,
          audit: [],
          outbox: [],
          liveWithdrawal: { ...baseLive, wallet_network_code: 'TON_TESTNET' },
        }),
        { withdrawalId: CANARY_BINDINGS.withdrawalId, permit: permitRow },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('tryBuildPhase21ManualDispatchRelayAuthority requires fakeChainEnabled === false', async () => {
    const { tryBuildPhase21ManualDispatchRelayAuthority, phase21ManualDispatchAuthorityMissingResources } =
      await import('../src/phase21-manual-dispatch-permit.js');
    const { buildPhase21PayoutConfig } = await import('../src/phase21-config.js');
    const phase21 = buildPhase21PayoutConfig({
      phase21MainnetEnabled: true,
      realChainEnabled: true,
      fakeChainEnabled: false,
      signerBaseUrl: 'http://127.0.0.1:8787',
      signerServiceToken: 'x'.repeat(32),
      jettonMasterIdentity: CANARY_BINDINGS.authorizedJettonMaster,
      primaryProviderKind: 'toncenter',
      primaryProviderUrl: 'https://toncenter.com/api/v2/',
      secondaryProviderKind: 'tonapi',
      secondaryProviderUrl: 'https://tonapi.io/',
    });
    const base = {
      payoutAuthority: 'PHASE21_MAINNET' as const,
      phase21MainnetEnabled: true,
      withdrawalNetworkCode: 'TON_MAINNET',
      realChainEnabled: true,
      phase21,
    };
    expect(
      tryBuildPhase21ManualDispatchRelayAuthority({ ...base, fakeChainEnabled: false }),
    ).not.toBeNull();
    expect(
      tryBuildPhase21ManualDispatchRelayAuthority({ ...base, fakeChainEnabled: true }),
    ).toBeNull();
    expect(
      tryBuildPhase21ManualDispatchRelayAuthority({ ...base }),
    ).toBeNull();
    expect(
      tryBuildPhase21ManualDispatchRelayAuthority({ ...base, fakeChainEnabled: null }),
    ).toBeNull();
    expect(
      phase21ManualDispatchAuthorityMissingResources({ ...base }),
    ).toContain('fakeChainEnabled=false');
    expect(
      phase21ManualDispatchAuthorityMissingResources({
        ...base,
        fakeChainEnabled: null,
      }),
    ).toContain('fakeChainEnabled=false');
  });

  it('does not use Float/Number money arithmetic in canary bindings', () => {
    expect(typeof CANARY_BINDINGS.authorizedGrossAtomic).toBe('bigint');
    expect(typeof CANARY_BINDINGS.authorizedFeeAtomic).toBe('bigint');
    expect(typeof CANARY_BINDINGS.authorizedNetAtomic).toBe('bigint');
    expect(CANARY_BINDINGS.authorizedGrossAtomic).toBe(200_000n);
    expect(CANARY_BINDINGS.authorizedFeeAtomic).toBe(10_000n);
    expect(CANARY_BINDINGS.authorizedNetAtomic).toBe(190_000n);
    expect(
      CANARY_BINDINGS.authorizedGrossAtomic ===
        CANARY_BINDINGS.authorizedFeeAtomic + CANARY_BINDINGS.authorizedNetAtomic,
    ).toBe(true);
  });
});

describe('phase21 pause gate naming', () => {
  it('source names the exception clearly (not a general unpause)', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(
      path.join(here, '../src/phase21-manual-dispatch-permit.ts'),
      'utf8',
    );
    expect(src).toContain('evaluatePhase21ManualDispatchPauseGate');
    expect(src).toContain('NOT a general unpause');
    expect(src).toContain('PAYOUT_DISPATCH_PAUSE');
  });
});

void vi;
