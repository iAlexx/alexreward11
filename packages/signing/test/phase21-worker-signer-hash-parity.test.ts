import { describe, expect, it } from 'vitest';
import { keyPairFromSeed } from '@ton/crypto';

import {
  PHASE21_MAINNET_FORWARD_APPROVED_POLICY_TEMPLATE,
  buildCanonicalSigningMessageAsync,
  deriveWalletV5R1,
  localSigningFixtureConfig,
  resolveJettonTransferPolicy,
} from '../src/index.js';

/**
 * Regression: Worker activities.ts and Signer sign-attempt.ts must build the
 * identical Mainnet canonical hash when both use the Owner-approved policy template.
 */
describe('Phase 21 Worker/Signer canonical hash parity', () => {
  it('Worker builder options and Signer resolveJettonTransferPolicy produce the same hash', async () => {
    const kp = keyPairFromSeed(Buffer.alloc(32, 21));
    const publicKey = Buffer.from(kp.publicKey);
    const derived = deriveWalletV5R1({ publicKey, networkGlobalId: -239, phase21MainnetEnabled: true });
    const intent = {
      publicKey,
      networkGlobalId: -239 as const,
      workchain: 0,
      subwalletNumber: 0,
      seqno: 7,
      validUntil: 1_800_000_000,
      queryId: 42n,
      netAmountAtomic: 190_000n,
      recipientAddress: derived.addressRaw,
      hotWalletAddress: derived.addressRaw,
      payoutJettonWalletAddress: derived.addressRaw,
      jettonMasterIdentity: 'EQCxE6m7GNvT83yuAF31XuKqhokXbxkOe9RZNVBRTbSP9n5r',
    };

    // Mirror apps/worker/src/activities.ts (Mainnet path).
    const workerBuilt = await buildCanonicalSigningMessageAsync(intent, {
      phase21MainnetEnabled: true,
      transferPolicy: PHASE21_MAINNET_FORWARD_APPROVED_POLICY_TEMPLATE,
    });

    // Mirror apps/signer sign-attempt via runtime mainnetTransferPolicy.
    const signerRuntime = localSigningFixtureConfig({
      phase21MainnetEnabled: true,
      networkCode: 'TON_MAINNET',
      networkGlobalId: -239,
      mainnetTransferPolicy: PHASE21_MAINNET_FORWARD_APPROVED_POLICY_TEMPLATE,
    });
    const signerPolicy = resolveJettonTransferPolicy({
      phase21MainnetEnabled: signerRuntime.phase21MainnetEnabled,
      transferPolicy: signerRuntime.mainnetTransferPolicy ?? null,
    });
    const signerBuilt = await buildCanonicalSigningMessageAsync(intent, {
      phase21MainnetEnabled: true,
      transferPolicy: signerPolicy,
    });

    expect(workerBuilt.canonicalMessageHashHex).toBe(signerBuilt.canonicalMessageHashHex);
    expect(workerBuilt.canonicalMessageHashHex).toMatch(/^[0-9a-f]{64}$/);
    expect(signerPolicy).toEqual(PHASE21_MAINNET_FORWARD_APPROVED_POLICY_TEMPLATE);
  });

  it('omitting transferPolicy on Mainnet fails closed (both sides)', async () => {
    const kp = keyPairFromSeed(Buffer.alloc(32, 22));
    const publicKey = Buffer.from(kp.publicKey);
    const derived = deriveWalletV5R1({ publicKey, networkGlobalId: -239, phase21MainnetEnabled: true });
    const intent = {
      publicKey,
      networkGlobalId: -239 as const,
      workchain: 0,
      subwalletNumber: 0,
      seqno: 1,
      validUntil: 1_800_000_000,
      queryId: 1n,
      netAmountAtomic: 100n,
      recipientAddress: derived.addressRaw,
      hotWalletAddress: derived.addressRaw,
      payoutJettonWalletAddress: derived.addressRaw,
      jettonMasterIdentity: 'EQCxE6m7GNvT83yuAF31XuKqhokXbxkOe9RZNVBRTbSP9n5r',
    };

    await expect(
      buildCanonicalSigningMessageAsync(intent, { phase21MainnetEnabled: true }),
    ).rejects.toThrow(/BLOCKED_OWNER_DECISION_MAINNET_TRANSFER_GAS_POLICY|Owner-approved/);

    expect(() =>
      resolveJettonTransferPolicy({
        phase21MainnetEnabled: true,
        transferPolicy: null,
      }),
    ).toThrow(/BLOCKED_OWNER_DECISION_MAINNET_TRANSFER_GAS_POLICY|Owner-approved/);
  });
});
