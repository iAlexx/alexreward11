import { describe, expect, it } from 'vitest';

import {
  runOptionalMainnetProviderReachabilityProbe,
  validateMainnetJettonMasterAddress,
  validateProviderIndependence,
} from '../src/phase21-external-probes.js';

describe('phase21 external probes (read-only)', () => {
  it('rejects empty and forbidden Jetton master placeholders', () => {
    expect(validateMainnetJettonMasterAddress(null).ok).toBe(false);
    expect(validateMainnetJettonMasterAddress('LOCAL-TESTONLY-PLACEHOLDER-USDT-JETTON-MASTER').ok).toBe(
      false,
    );
    expect(validateMainnetJettonMasterAddress('EQ_owner_approved_testnet_jetton_master').ok).toBe(
      false,
    );
  });

  it('validates parseable non-placeholder Jetton master shape', () => {
    const result = validateMainnetJettonMasterAddress(
      'EQD0vdSA_NedR9uvbgN9EikRX-suesDxGeFg69XQMavfLqIw',
    );
    expect(result.ok).toBe(true);
  });

  it('requires provider independence', () => {
    expect(
      validateProviderIndependence(
        { kind: 'toncenter', url: 'https://mainnet.example/a' },
        { kind: 'toncenter', url: 'https://mainnet.example/a' },
      ).ok,
    ).toBe(false);
    expect(
      validateProviderIndependence(
        { kind: 'toncenter', url: 'https://mainnet.example/a' },
        { kind: 'tonapi', url: 'https://mainnet.example/b' },
      ).ok,
    ).toBe(true);
  });

  it('skips live provider probe unless PHASE21_EXTERNAL_PROBE_LIVE=1', async () => {
    const prior = process.env.PHASE21_EXTERNAL_PROBE_LIVE;
    delete process.env.PHASE21_EXTERNAL_PROBE_LIVE;
    const skipped = await runOptionalMainnetProviderReachabilityProbe({
      providerUrl: 'https://example.com',
    });
    expect(skipped.ok).toBe(false);
    expect(skipped.message).toMatch(/skipped/i);
    if (prior === undefined) delete process.env.PHASE21_EXTERNAL_PROBE_LIVE;
    else process.env.PHASE21_EXTERNAL_PROBE_LIVE = prior;
  });
});
