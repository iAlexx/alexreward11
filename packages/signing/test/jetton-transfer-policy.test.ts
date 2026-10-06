import { describe, expect, it } from 'vitest';

import {
  PHASE10_TESTNET_SPIKE_TRANSFER_POLICY,
  PHASE21_ATTACHED_GRAM_POLICY_STATUS,
  PHASE21_MAINNET_FORWARD_APPROVED_POLICY_TEMPLATE,
  PHASE21_OWNER_APPROVED_ATTACHED_GRAM_ATOMIC,
  PHASE21_OWNER_APPROVED_FORWARD_GRAM_ATOMIC,
  SPIKE_JETTON_ATTACHED_TON,
  SPIKE_JETTON_FORWARD_TON,
  SPIKE_SEND_MODE,
  assertJettonTransferPolicyValid,
  assertPhase21MainnetTransferPolicy,
  isPhase21AttachedGramPolicySourceReady,
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

  it('rejects SPIKE/Testnet policy sourceReference even when amount matches Owner-approved', () => {
    expect(() =>
      assertPhase21MainnetTransferPolicy({
        attachedTonAtomic: PHASE21_OWNER_APPROVED_ATTACHED_GRAM_ATOMIC,
        forwardTonAtomic: PHASE21_OWNER_APPROVED_FORWARD_GRAM_ATOMIC,
        sendMode: SPIKE_SEND_MODE,
        networkScope: 'MAINNET_OWNER_APPROVED',
        sourceReference: 'PHASE10_TESTNET_SPIKE_CONSTANTS',
        attachedGramLifecycle: 'OWNER_APPROVED',
      }),
    ).toThrow(/SPIKE|Testnet/);
  });

  it('requires Owner-approved forward = 1 nanogram', () => {
    expect(() =>
      assertPhase21MainnetTransferPolicy({
        attachedTonAtomic: PHASE21_OWNER_APPROVED_ATTACHED_GRAM_ATOMIC,
        forwardTonAtomic: 2n,
        sendMode: SPIKE_SEND_MODE,
        networkScope: 'MAINNET_OWNER_APPROVED',
        sourceReference: 'bad-forward',
        attachedGramLifecycle: 'OWNER_APPROVED',
      }),
    ).toThrow(/1 nanogram/);
  });

  it('rejects attached amount other than Owner-approved 50000000', () => {
    expect(() =>
      assertPhase21MainnetTransferPolicy({
        attachedTonAtomic: 60_000_000n,
        forwardTonAtomic: PHASE21_OWNER_APPROVED_FORWARD_GRAM_ATOMIC,
        sendMode: SPIKE_SEND_MODE,
        networkScope: 'MAINNET_OWNER_APPROVED',
        sourceReference: 'bad-attached-amount',
        attachedGramLifecycle: 'OWNER_APPROVED',
      }),
    ).toThrow(/PHASE21_ATTACHED_GRAM_ATOMIC_MISMATCH|50000000/);
  });

  it('ESTIMATED attached blocks live resolve', () => {
    expect(PHASE21_ATTACHED_GRAM_POLICY_STATUS).toBe('OWNER_APPROVED');
    expect(() =>
      resolveJettonTransferPolicy({
        phase21MainnetEnabled: true,
        transferPolicy: {
          attachedTonAtomic: PHASE21_OWNER_APPROVED_ATTACHED_GRAM_ATOMIC,
          forwardTonAtomic: PHASE21_OWNER_APPROVED_FORWARD_GRAM_ATOMIC,
          sendMode: SPIKE_SEND_MODE,
          networkScope: 'MAINNET_OWNER_APPROVED',
          sourceReference: 'estimated-attached',
          attachedGramLifecycle: 'ESTIMATED',
        },
      }),
    ).toThrow(/BLOCKED_OWNER_DECISION_MAINNET_ATTACHED_GRAM|not Owner-approved/);
  });

  it('accepts Owner-approved Mainnet policy with attached=50000000 and forward=1', () => {
    const approved = PHASE21_MAINNET_FORWARD_APPROVED_POLICY_TEMPLATE;
    const policy = resolveJettonTransferPolicy({
      phase21MainnetEnabled: true,
      transferPolicy: approved,
    });
    expect(policy.attachedTonAtomic).toBe(50_000_000n);
    expect(policy.forwardTonAtomic).toBe(1n);
    expect(policy.attachedGramLifecycle).toBe('OWNER_APPROVED');
    expect(policy.networkScope).toBe('MAINNET_OWNER_APPROVED');
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

  it('source forward and attached Owner-approved policies are ready', () => {
    expect(isPhase21ForwardGramPolicySourceReady()).toBe(true);
    expect(isPhase21AttachedGramPolicySourceReady()).toBe(true);
    expect(PHASE21_OWNER_APPROVED_ATTACHED_GRAM_ATOMIC).toBe(50_000_000n);
    expect(PHASE21_OWNER_APPROVED_ATTACHED_GRAM_ATOMIC).toBe(SPIKE_JETTON_ATTACHED_TON);
  });
});
