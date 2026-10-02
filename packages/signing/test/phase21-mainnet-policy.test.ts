import { describe, expect, it } from 'vitest';
import { keyPairFromSeed } from '@ton/crypto';

import {
  SignerError,
  SPIKE_SEND_MODE,
  assertSigningPolicy,
  buildCanonicalSigningMessageAsync,
  deriveWalletV5R1,
  identityFromSeed,
  localSigningFixtureConfig,
  type SigningViewRow,
} from '../src/index.js';

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
    hot_wallet_signer_type: 'FALLBACK_ENCRYPTED',
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
    requires_state_init: false,
    ...overrides,
  };
}

describe('Phase 21 Mainnet signing policy allow-path', () => {
  it('default Phase9 config still rejects Mainnet', () => {
    const config = localSigningFixtureConfig();
    expect(config.phase21MainnetEnabled).toBe(false);
    expect(() => assertSigningPolicy(baseRow({ network_environment: 'MAINNET' }), config)).toThrow(
      SignerError,
    );
    const kp = keyPairFromSeed(Buffer.alloc(32, 7));
    expect(() =>
      deriveWalletV5R1({ publicKey: Buffer.from(kp.publicKey), networkGlobalId: -239 }),
    ).toThrow(/MAINNET_REJECTED|MAINNET/);
    expect(() => identityFromSeed(Buffer.alloc(32, 9), { networkGlobalId: -239, workchain: 0 })).toThrow(
      /MAINNET/,
    );
  });

  it('Phase21 mode accepts -239 derivation and requires Mainnet policy path', async () => {
    const config = localSigningFixtureConfig({
      phase21MainnetEnabled: true,
      networkCode: 'TON_MAINNET',
      networkGlobalId: -239,
      keyMode: 'self_hosted_encrypted',
    });
    const kp = keyPairFromSeed(Buffer.alloc(32, 7));
    const derived = deriveWalletV5R1({
      publicKey: Buffer.from(kp.publicKey),
      networkGlobalId: -239,
      phase21MainnetEnabled: true,
    });
    expect(derived.networkGlobalId).toBe(-239);

    expect(() =>
      assertSigningPolicy(
        baseRow({
          network_code: 'TON_MAINNET',
          network_environment: 'MAINNET',
          global_chain_identifier: 'ton:mainnet',
        }),
        config,
      ),
    ).not.toThrow();

    const ownerApprovedPolicy = {
      attachedTonAtomic: 60_000_000n,
      forwardTonAtomic: 1n,
      sendMode: SPIKE_SEND_MODE,
      networkScope: 'MAINNET_OWNER_APPROVED' as const,
      sourceReference: 'OWNER_APPROVED_FIXTURE_STEP3_TEST_ONLY',
      attachedGramLifecycle: 'OWNER_APPROVED' as const,
    };

    await expect(
      buildCanonicalSigningMessageAsync(
        {
          publicKey: Buffer.from(kp.publicKey),
          networkGlobalId: -239,
          workchain: 0,
          subwalletNumber: 0,
          seqno: 1,
          validUntil: Math.floor(Date.now() / 1000) + 120,
          queryId: 1n,
          netAmountAtomic: 100n,
          recipientAddress: derived.addressRaw,
          hotWalletAddress: derived.addressRaw,
          payoutJettonWalletAddress: derived.addressRaw,
          jettonMasterIdentity: 'EQD0vdSA_NedR9uvbgN9EikRX-suesDxGeFg69XQMavfLqIw',
        },
        { phase21MainnetEnabled: true, transferPolicy: ownerApprovedPolicy },
      ),
    ).resolves.toBeTruthy();

    await expect(
      buildCanonicalSigningMessageAsync(
        {
          publicKey: Buffer.from(kp.publicKey),
          networkGlobalId: -239,
          workchain: 0,
          subwalletNumber: 0,
          seqno: 1,
          validUntil: Math.floor(Date.now() / 1000) + 120,
          queryId: 1n,
          netAmountAtomic: 100n,
          recipientAddress: derived.addressRaw,
          hotWalletAddress: derived.addressRaw,
          payoutJettonWalletAddress: derived.addressRaw,
          jettonMasterIdentity: 'EQD0vdSA_NedR9uvbgN9EikRX-suesDxGeFg69XQMavfLqIw',
        },
        {
          phase21MainnetEnabled: true,
          transferPolicy: {
            ...ownerApprovedPolicy,
            attachedGramLifecycle: 'ESTIMATED',
          },
        },
      ),
    ).rejects.toThrow(/BLOCKED_OWNER_DECISION_MAINNET_ATTACHED_GRAM|not Owner-approved/);

    await expect(
      buildCanonicalSigningMessageAsync(
        {
          publicKey: Buffer.from(kp.publicKey),
          networkGlobalId: -239,
          workchain: 0,
          subwalletNumber: 0,
          seqno: 1,
          validUntil: Math.floor(Date.now() / 1000) + 120,
          queryId: 1n,
          netAmountAtomic: 100n,
          recipientAddress: derived.addressRaw,
          hotWalletAddress: derived.addressRaw,
          payoutJettonWalletAddress: derived.addressRaw,
          jettonMasterIdentity: 'EQD0vdSA_NedR9uvbgN9EikRX-suesDxGeFg69XQMavfLqIw',
        },
        { phase21MainnetEnabled: true },
      ),
    ).rejects.toThrow(/BLOCKED_OWNER_DECISION_MAINNET_TRANSFER_GAS_POLICY|Owner-approved/);
  });

  it('Testnet attempt cannot Mainnet-sign (network global id mismatch)', async () => {
    const config = localSigningFixtureConfig();
    const kp = keyPairFromSeed(Buffer.alloc(32, 7));
    const derived = deriveWalletV5R1({
      publicKey: Buffer.from(kp.publicKey),
      networkGlobalId: -3,
    });
    await expect(
      buildCanonicalSigningMessageAsync({
        publicKey: Buffer.from(kp.publicKey),
        networkGlobalId: -239,
        workchain: 0,
        subwalletNumber: 0,
        seqno: 1,
        validUntil: Math.floor(Date.now() / 1000) + 120,
        queryId: 1n,
        netAmountAtomic: 100n,
        recipientAddress: derived.addressRaw,
        hotWalletAddress: derived.addressRaw,
        payoutJettonWalletAddress: derived.addressRaw,
        jettonMasterIdentity: 'MASTER',
      }),
    ).rejects.toThrow(/MAINNET/);
    expect(config.networkGlobalId).toBe(-3);
  });

  it('missing phase21MainnetEnabled flag still rejects Mainnet canonical message', async () => {
    const kp = keyPairFromSeed(Buffer.alloc(32, 7));
    const derived = deriveWalletV5R1({
      publicKey: Buffer.from(kp.publicKey),
      networkGlobalId: -3,
    });
    await expect(
      buildCanonicalSigningMessageAsync({
        publicKey: Buffer.from(kp.publicKey),
        networkGlobalId: -239,
        workchain: 0,
        subwalletNumber: 0,
        seqno: 1,
        validUntil: Math.floor(Date.now() / 1000) + 120,
        queryId: 1n,
        netAmountAtomic: 100n,
        recipientAddress: derived.addressRaw,
        hotWalletAddress: derived.addressRaw,
        payoutJettonWalletAddress: derived.addressRaw,
        jettonMasterIdentity: 'EQ_owner_approved_mainnet_usdt_jetton_master',
      }),
    ).rejects.toThrow(/MAINNET/);
  });
});
