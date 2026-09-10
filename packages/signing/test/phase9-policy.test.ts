import { describe, expect, it } from 'vitest';

import {
  LocalEphemeralSignPort,
  SignerError,
  assertSigningPolicy,
  localSigningFixtureConfig,
  type SigningViewRow,
} from '../src/index.js';
import { signVerify } from '@ton/crypto';

function baseRow(overrides: Partial<SigningViewRow> = {}): SigningViewRow {
  const validUntil = new Date(Date.now() + 60_000);
  return {
    withdrawal_attempt_id: '00000000-0000-4000-8000-000000000001',
    withdrawal_id: '00000000-0000-4000-8000-000000000002',
    attempt_number: 1,
    hot_wallet_id: '00000000-0000-4000-8000-000000000003',
    expected_seqno: '1',
    query_id: '42',
    valid_until: validUntil,
    canonical_message_hash: 'ab'.repeat(32),
    signed_message_hash: null,
    signer_key_reference: 'local',
    dispatch_fencing_token: '1',
    broadcast_result_state: 'PENDING',
    signing_started_at: null,
    broadcast_started_at: null,
    settled_at: null,
    withdrawal_state: 'QUEUED',
    requested_amount_atomic: '110',
    fee_amount_atomic: '10',
    net_amount_atomic: '100',
    recipient_raw_address: '0:11',
    recipient_friendly_address: 'UQ',
    recipient_wallet_verified: true,
    recipient_wallet_disabled_at: null,
    hot_wallet_address: '0:22',
    hot_wallet_version: 'v5R1',
    hot_wallet_signer_type: 'KMS',
    hot_wallet_signer_reference: 'local',
    hot_wallet_status: 'ACTIVE',
    payout_jetton_wallet_address: '0:33',
    network_code: 'TON_TESTNET',
    network_chain: 'TON',
    network_environment: 'TESTNET',
    global_chain_identifier: 'ton:testnet',
    network_status: 'ACTIVE',
    asset_symbol: 'USDT',
    asset_decimals: 6,
    asset_is_native: false,
    asset_contract_identity: 'MASTER',
    asset_status: 'ACTIVE',
    quote_requested_amount_atomic: '110',
    quote_fee_amount_atomic: '10',
    quote_net_amount_atomic: '100',
    approval_id: '00000000-0000-4000-8000-000000000004',
    approval_decision: 'APPROVE',
    current_dispatch_fencing_token: '1',
    dispatch_lease_expires_at: new Date(Date.now() + 60_000),
    dispatch_lease_released_at: null,
    payout_dispatch_paused: false,
    ...overrides,
  };
}

describe('Phase 9 signer policy', () => {
  const config = localSigningFixtureConfig();

  it('rejects Phase 7 fake-hash and MAINNET', () => {
    expect(() =>
      assertSigningPolicy(baseRow({ canonical_message_hash: 'fake-hash:w:1' }), config),
    ).toThrow(/FAKE_PHASE7_HASH|fake-hash/);
    expect(() =>
      assertSigningPolicy(baseRow({ network_environment: 'MAINNET' }), config),
    ).toThrow(SignerError);
  });

  it('rejects HELD/REJECTED/CONFIRMED and native asset', () => {
    expect(() => assertSigningPolicy(baseRow({ withdrawal_state: 'HELD' }), config)).toThrow(
      SignerError,
    );
    expect(() => assertSigningPolicy(baseRow({ withdrawal_state: 'REJECTED' }), config)).toThrow(
      SignerError,
    );
    expect(() => assertSigningPolicy(baseRow({ withdrawal_state: 'CONFIRMED' }), config)).toThrow(
      SignerError,
    );
    expect(() => assertSigningPolicy(baseRow({ asset_is_native: true }), config)).toThrow(
      SignerError,
    );
  });

  it('rejects expired valid_until, paused dispatch, and missing jetton wallet', () => {
    expect(() =>
      assertSigningPolicy(baseRow({ valid_until: new Date(Date.now() - 1_000) }), config),
    ).toThrow(SignerError);
    expect(() =>
      assertSigningPolicy(baseRow({ payout_dispatch_paused: true }), config),
    ).toThrow(SignerError);
    expect(() =>
      assertSigningPolicy(baseRow({ payout_jetton_wallet_address: null }), config),
    ).toThrow(SignerError);
    expect(() =>
      assertSigningPolicy(baseRow({ hot_wallet_status: 'COMPROMISED' }), config),
    ).toThrow(SignerError);
    expect(() =>
      assertSigningPolicy(baseRow({ broadcast_started_at: new Date() }), config),
    ).toThrow(SignerError);
    expect(() =>
      assertSigningPolicy(baseRow({ approval_id: null, approval_decision: null }), config),
    ).toThrow(SignerError);
  });
});

describe('Phase 9 local ephemeral crypto', () => {
  it('signs and verifies locally (not formal KMS evidence)', async () => {
    const port = new LocalEphemeralSignPort(Buffer.alloc(32, 11));
    const pk = await port.getPublicKey();
    const msg = Buffer.alloc(32, 4);
    const sig = await port.signEd25519RawMessage(msg);
    expect(signVerify(msg, sig, pk)).toBe(true);
    const altered = Buffer.alloc(32);
    msg.copy(altered);
    altered.writeUInt8(altered.readUInt8(0) ^ 1, 0);
    expect(signVerify(altered, sig, pk)).toBe(false);
  });
});
