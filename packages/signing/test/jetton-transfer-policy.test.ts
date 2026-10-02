import { describe, expect, it } from 'vitest';

import {
  PHASE10_TESTNET_SPIKE_TRANSFER_POLICY,
  PHASE21_ATTACHED_GRAM_POLICY_STATUS,
  PHASE21_OWNER_APPROVED_FORWARD_GRAM_ATOMIC,
  SPIKE_JETTON_ATTACHED_TON,
  SPIKE_JETTON_FORWARD_TON,
  SPIKE_SEND_MODE,
  SignerError,
  assertJettonTransferPolicyValid,
  assertPhase21MainnetTransferPolicy,
  isPhase21ForwardGramPolicySourceReady,
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

  it('rejects SPIKE attached amount even with MAINNET scope', () => {
    expect(() =>
      assertPhase21MainnetTransferPolicy({
        attachedTonAtomic: SPIKE_JETTON_ATTACHED_TON,
        forwardTonAtomic: PHASE21_OWNER_APPROVED_FORWARD_GRAM_ATOMIC,
        sendMode: SPIKE_SEND_MODE,
        networkScope: 'MAINNET_OWNER_APPROVED',
        sourceReference: 'bad-spike',
        attachedGramLifecycle: 'OWNER_APPROVED',
      }),
    ).toThrow(/SPIKE attached/);
  });

  it('requires Owner-approved forward = 1 nanogram', () => {
    expect(() =>
      assertPhase21MainnetTransferPolicy({
        attachedTonAtomic: 60_000_000n,
        forwardTonAtomic: 2n,
        sendMode: SPIKE_SEND_MODE,
        networkScope: 'MAINNET_OWNER_APPROVED',
        sourceReference: 'bad-forward',
        attachedGramLifecycle: 'OWNER_APPROVED',
      }),
    ).toThrow(/1 nanogram/);
  });

  it('ESTIMATED attached blocks live resolve (OWNER_DECISION_REQUIRED)', () => {
    expect(PHASE21_ATTACHED_GRAM_POLICY_STATUS).toBe('ESTIMATED');
    expect(() =>
      resolveJettonTransferPolicy({
        phase21MainnetEnabled: true,
        transferPolicy: {
          attachedTonAtomic: 60_000_000n,
          forwardTonAtomic: PHASE21_OWNER_APPROVED_FORWARD_GRAM_ATOMIC,
          sendMode: SPIKE_SEND_MODE,
          networkScope: 'MAINNET_OWNER_APPROVED',
          sourceReference: 'estimated-attached',
          attachedGramLifecycle: 'ESTIMATED',
        },
      }),
    ).toThrow(/BLOCKED_OWNER_DECISION_MAINNET_ATTACHED_GRAM|not Owner-approved/);
  });

  it('accepts future Owner-approved Mainnet policy with forward=1n and non-SPIKE attached', () => {
    const approved = {
      attachedTonAtomic: 60_000_000n,
      forwardTonAtomic: PHASE21_OWNER_APPROVED_FORWARD_GRAM_ATOMIC,
      sendMode: SPIKE_SEND_MODE,
      networkScope: 'MAINNET_OWNER_APPROVED' as const,
      sourceReference: 'OWNER_APPROVED_FIXTURE_STEP3_TEST_ONLY',
      attachedGramLifecycle: 'OWNER_APPROVED' as const,
    };
    const policy = resolveJettonTransferPolicy({
      phase21MainnetEnabled: true,
      transferPolicy: approved,
    });
    expect(policy).toEqual(approved);
    expect(policy.forwardTonAtomic).toBe(1n);
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

  it('source forward policy ready while attached remains ESTIMATED', () => {
    expect(isPhase21ForwardGramPolicySourceReady()).toBe(true);
  });
});
