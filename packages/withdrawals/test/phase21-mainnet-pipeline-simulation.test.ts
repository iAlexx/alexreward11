/**
 * Focused Mainnet (-239) simulation regressions for Phase 21 audit remediation.
 * Full payout E2E still needs heavier fixtures (DB attempt/sign/broadcast harness);
 * this file covers the network-identity slice that blocked MAINNET_READY.
 */
import { createHash } from 'node:crypto';

import {
  FakeTonChainProvider,
  TON_MAINNET_NETWORK_GLOBAL_ID,
  TON_TESTNET_NETWORK_GLOBAL_ID,
  admitWalletSeqno,
  deriveWalletV5R1AddressRaw,
} from '@alex-rewards/ton';
import { describe, expect, it } from 'vitest';

import { matchIntendedJettonPayout } from '../src/confirmation.js';
import { isCompleteIntendedPayoutProof } from '../src/phase10-payout-invariants.js';
import { resolveReconcileNetworkGlobalId } from '../src/real-chain-reconcile-only.js';

const PUBLIC_KEY_HEX = '22'.repeat(32);
const FINGERPRINT = createHash('sha256')
  .update(Buffer.from(PUBLIC_KEY_HEX, 'hex'))
  .digest('hex');

describe('phase21 Mainnet pipeline simulation (network identity)', () => {
  it('FakeTonChainProvider constructs with networkGlobalId -239', async () => {
    const fake = new FakeTonChainProvider({ networkGlobalId: TON_MAINNET_NETWORK_GLOBAL_ID });
    expect(fake.networkGlobalId).toBe(-239);
    expect((await fake.health()).networkGlobalId).toBe(-239);
  });

  it('defaults FakeTonChainProvider to Testnet -3', () => {
    expect(new FakeTonChainProvider().networkGlobalId).toBe(TON_TESTNET_NETWORK_GLOBAL_ID);
  });

  it('admitWalletSeqno succeeds for -239 with dual Fake providers seeded active V5R1', async () => {
    const address = deriveWalletV5R1AddressRaw({
      publicKeyHex: PUBLIC_KEY_HEX,
      networkGlobalId: TON_MAINNET_NETWORK_GLOBAL_ID,
    });
    const primary = new FakeTonChainProvider({ networkGlobalId: TON_MAINNET_NETWORK_GLOBAL_ID });
    const secondary = new FakeTonChainProvider({ networkGlobalId: TON_MAINNET_NETWORK_GLOBAL_ID });
    for (const fake of [primary, secondary]) {
      fake.seedActiveV5R1({
        address,
        seqno: 3,
        publicKeyHex: PUBLIC_KEY_HEX,
        networkGlobalId: TON_MAINNET_NETWORK_GLOBAL_ID,
      });
    }
    const result = await admitWalletSeqno({
      networkGlobalId: TON_MAINNET_NETWORK_GLOBAL_ID,
      hotWalletAddress: address,
      publicKeyHex: PUBLIC_KEY_HEX,
      signerKeyReference: FINGERPRINT,
      approvedSignerKeyReference: FINGERPRINT,
      primary,
      secondary,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.seqno).toBe(3);
      expect(result.requiresStateInit).toBe(false);
    }
  });

  it('matchIntendedJettonPayout true for -239/-239 and false on mismatch', () => {
    const expected = {
      hotWallet: '0:hot',
      jettonMaster: '0:master',
      recipient: '0:recv',
      amountAtomic: '190000',
      queryId: '99',
      networkGlobalId: TON_MAINNET_NETWORK_GLOBAL_ID,
      senderJettonWallet: '0:sjw',
    };
    const evidence = {
      ...expected,
      success: true,
      bounced: false,
      providerKind: 'tonapi',
      proofStage: 'COMPLETE' as const,
      hotWalletTxHash: 'aa'.repeat(32),
      jettonWalletTxHash: 'bb'.repeat(32),
      recipientEvidence: 'ok',
    };
    expect(matchIntendedJettonPayout(evidence, expected)).toBe(true);
    expect(
      matchIntendedJettonPayout(
        { ...evidence, networkGlobalId: TON_TESTNET_NETWORK_GLOBAL_ID },
        expected,
      ),
    ).toBe(false);
  });

  it('isCompleteIntendedPayoutProof accepts Mainnet -239', () => {
    const expected = {
      withdrawalId: '11111111-1111-4111-8111-111111111111',
      attemptId: '22222222-2222-4222-8222-222222222222',
      queryId: '12345',
      recipient: '0:recv',
      amountAtomic: '190000',
      jettonMaster: '0:master',
      hotWallet: '0:hot',
      senderJettonWallet: '0:sjw',
    };
    const proof = {
      withdrawalId: expected.withdrawalId,
      attemptId: expected.attemptId,
      queryId: expected.queryId,
      recipient: expected.recipient,
      amountAtomic: expected.amountAtomic,
      jettonMaster: expected.jettonMaster,
      hotWallet: expected.hotWallet,
      senderJettonWallet: expected.senderJettonWallet,
      networkGlobalId: -239,
      proofStage: 'COMPLETE',
      success: true,
      bounced: false,
      nonBounce: true,
      txIdentity: 'primary-tx-1',
      testPath: false,
      secondaryAgree: true,
      primaryProviderKind: 'toncenter',
      secondaryProviderKind: 'tonapi',
      secondaryProofStage: 'COMPLETE',
      secondaryTxIdentity: 'secondary-tx-1',
      secondarySuccess: true,
      secondaryNonBounce: true,
    };
    expect(isCompleteIntendedPayoutProof(proof, expected)).toBe(true);
    expect(isCompleteIntendedPayoutProof({ ...proof, networkGlobalId: -1 }, expected)).toBe(false);
  });

  it('resolveReconcileNetworkGlobalId maps ton:mainnet to -239 and fails closed otherwise', () => {
    expect(resolveReconcileNetworkGlobalId('ton:mainnet')).toBe(TON_MAINNET_NETWORK_GLOBAL_ID);
    expect(resolveReconcileNetworkGlobalId('ton:testnet')).toBe(TON_TESTNET_NETWORK_GLOBAL_ID);
    expect(resolveReconcileNetworkGlobalId('-239')).toBe(TON_MAINNET_NETWORK_GLOBAL_ID);
    expect(() => resolveReconcileNetworkGlobalId(null)).toThrow(/missing/);
    expect(() => resolveReconcileNetworkGlobalId('ethereum:1')).toThrow(/unsupported/i);
  });
});
