import { describe, expect, it } from 'vitest';

import { runPhase21Preflight } from '../src/phase21-preflight.js';
import {
  buildPhase21ReadinessReport,
  defaultPhase21Step1Observations,
} from '../src/phase21-readiness.js';

describe('phase21 readiness / preflight', () => {
  it('default Step3 observations remain overall BLOCKED but source-ready foundations PASS', () => {
    const report = buildPhase21ReadinessReport(defaultPhase21Step1Observations());
    expect(report.overall).toBe('BLOCKED');
    expect(report.summary.blockedCount).toBeGreaterThan(0);
    expect(report.summary.productionSignerService).toBe('NOT_PROVISIONED');
    expect(report.summary.balanceSource).toBe(
      'SOURCE_IMPLEMENTED_OWNER_APPROVED_BUT_NOT_EXECUTED',
    );

    const byCode = Object.fromEntries(report.items.map((i) => [i.code, i]));
    for (const required of [
      'PHASE20_ARCHIVED',
      'MAINNET_CODE_SUPPORT',
      'MAINNET_EXPLICIT_GATE',
      'MAINNET_JETTON_MASTER',
      'PRIMARY_PROVIDER',
      'SECONDARY_PROVIDER',
      'SIGNER_SERVICE',
      'SIGNER_CONFIG',
      'SIGNER_LOCKED',
      'SIGNER_IDENTITY',
      'HOT_WALLET_REGISTERED',
      'HOT_WALLET_BALANCE',
      'TON_GAS',
      'REAL_CHAIN_GATE',
      'FAKE_CHAIN_DISABLED',
      'WITHDRAWAL_REQUEST_PAUSE',
      'PAYOUT_DISPATCH_PAUSE',
      'AUTO_PAYOUT_DISABLED',
      'AUTO_UNPAUSE_DISABLED',
      'AUTO_RESEND_DISABLED',
      'RISK_POLICY',
      'TRUST_POLICY',
      'ELIGIBILITY_POLICY',
      'RECONCILIATION',
      'LEDGER_INVARIANTS',
      'MANUAL_APPROVAL_ONLY',
      'REAL_MONEY_BLOCKER_MAPPING',
      'WITHDRAWABLE_BALANCE_SOURCE',
      'WORKER_MAINNET_WIRING',
      'MAINNET_TRANSFER_GAS_POLICY',
      'MAINNET_ATTACHED_GRAM_POLICY',
      'MAINNET_JETTON_EXTERNAL_VERIFICATION',
      'SIGNER_HOSTING_DECISION',
      'GRAM_NAMING_COMPATIBILITY',
      'MULTICHAIN_WALLET_HARDENING',
      'CONTROLLED_PROVISION_TOOLING',
      'OFFLINE_MAINNET_CEREMONY_TOOLING',
    ]) {
      expect(byCode[required], required).toBeDefined();
    }

    expect(byCode['MAINNET_EXPLICIT_GATE']?.status).toBe('PASS');
    expect(byCode['REAL_CHAIN_GATE']?.status).toBe('PASS');
    expect(byCode['MAINNET_TRANSFER_GAS_POLICY']?.status).toBe('PASS');
    expect(byCode['WITHDRAWABLE_BALANCE_SOURCE']?.status).toBe('PASS');
    expect(byCode['MAINNET_ATTACHED_GRAM_POLICY']?.status).toBe('BLOCKED');
    expect(byCode['SIGNER_HOSTING_DECISION']?.message).toMatch(/DEDICATED_CONTROLLED_HOST/);
    expect(byCode['TON_GAS']?.message).toMatch(/GRAM gas/);
  });

  it('preflight never emits READY_FOR_LIVE_PAYOUT; Step3 defaults approach ceremony readiness', () => {
    const preflight = runPhase21Preflight(defaultPhase21Step1Observations());
    expect(preflight.readyForLivePayout).toBe(false);
    expect(preflight.verdict).not.toBe('READY_FOR_LIVE_PAYOUT' as never);
    expect([
      'READY_FOR_OWNER_PROVISIONING_CEREMONY',
      'MAINNET_SOURCE_READY',
      'BLOCKED_FOR_EXTERNAL_RESOURCES',
      'BLOCKED_FOR_OWNER_DECISION',
    ]).toContain(preflight.verdict);
    // Source foundations complete with external still blocked ? ceremony verdict.
    expect(preflight.verdict).toBe('READY_FOR_OWNER_PROVISIONING_CEREMONY');
  });

  it('unpaused dispatch without ceremony is not treated ready', () => {
    const report = buildPhase21ReadinessReport({
      ...defaultPhase21Step1Observations(),
      payoutDispatchPaused: false,
      withdrawalRequestsPaused: false,
    });
    expect(report.items.find((i) => i.code === 'PAYOUT_DISPATCH_PAUSE')?.status).toBe('BLOCKED');
    expect(report.items.find((i) => i.code === 'WITHDRAWAL_REQUEST_PAUSE')?.status).toBe(
      'BLOCKED',
    );
    expect(report.overall).toBe('BLOCKED');
    const preflight = runPhase21Preflight({
      ...defaultPhase21Step1Observations(),
      payoutDispatchPaused: false,
      withdrawalRequestsPaused: false,
    });
    expect(preflight.readyForLivePayout).toBe(false);
    expect(preflight.verdict).toBe('BLOCKED_FOR_OWNER_DECISION');
  });
});
