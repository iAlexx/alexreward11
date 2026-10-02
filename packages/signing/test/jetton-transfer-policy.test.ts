import { describe, expect, it } from 'vitest';

import {
  PHASE10_TESTNET_SPIKE_TRANSFER_POLICY,
  SPIKE_JETTON_ATTACHED_TON,
  SPIKE_JETTON_FORWARD_TON,
  SPIKE_SEND_MODE,
  SignerError,
  assertJettonTransferPolicyValid,
  resolveJettonTransferPolicy,
} from '../src/index.js';

describe('jetton transfer execution policy', () => {
  it('Phase10/Testnet uses historical SPIKE policy by default', () => {
    const policy = resolveJettonTransferPolicy({ phase21MainnetEnabled: false });
    expect(policy).toEqual(PHASE10_TESTNET_SPIKE_TRANSFER_POLICY);
    expect(policy.attachedTonAtomic).toBe(SPIKE_JETTON_ATTACHED_TON);
    expect(policy.forwardTonAtomic).toBe(SPIKE_JETTON_FORWARD_TON);
    expect(policy.sendMode).toBe(SPIKE_SEND_MODE);
    expect(policy.networkScope).toBe('TESTNET_SPIKE');
  });

  it('Phase21 without approved Mainnet policy is blocked', () => {
    expect(() =>
      resolveJettonTransferPolicy({ phase21MainnetEnabled: true, transferPolicy: null }),
    ).toThrow(/BLOCKED_OWNER_DECISION_MAINNET_TRANSFER_GAS_POLICY|Owner-approved/);
  });

  it('Phase21 cannot silently use SPIKE constants', () => {
    expect(() =>
      resolveJettonTransferPolicy({
        phase21MainnetEnabled: true,
        transferPolicy: PHASE10_TESTNET_SPIKE_TRANSFER_POLICY,
      }),
    ).toThrow(/cannot use Testnet SPIKE/);
  });

  it('network mismatch fails for non MAINNET_OWNER_APPROVED scope', () => {
    expect(() =>
      resolveJettonTransferPolicy({
        phase21MainnetEnabled: true,
        transferPolicy: {
          attachedTonAtomic: 1n,
          forwardTonAtomic: 1n,
          sendMode: 1,
          networkScope: 'TESTNET_SPIKE',
          sourceReference: 'forged',
        },
      }),
    ).toThrow(SignerError);
  });

  it('invalid negative values fail', () => {
    expect(() =>
      assertJettonTransferPolicyValid({
        attachedTonAtomic: -1n,
        forwardTonAtomic: 1n,
        sendMode: 1,
        networkScope: 'MAINNET_OWNER_APPROVED',
        sourceReference: 'owner-test-fixture',
      }),
    ).toThrow(/non-negative/);
  });

  it('accepts Owner-approved Mainnet policy when explicitly supplied', () => {
    const approved = {
      attachedTonAtomic: 60_000_000n,
      forwardTonAtomic: 1n,
      sendMode: SPIKE_SEND_MODE,
      networkScope: 'MAINNET_OWNER_APPROVED' as const,
      sourceReference: 'OWNER_APPROVED_FIXTURE_STEP2_TEST_ONLY',
    };
    const policy = resolveJettonTransferPolicy({
      phase21MainnetEnabled: true,
      transferPolicy: approved,
    });
    expect(policy).toEqual(approved);
  });
});
