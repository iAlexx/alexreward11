import { afterEach, describe, expect, it } from 'vitest';

import {
  assertMainnetProviderUrl,
  PHASE21_DEFAULT_PROVIDER_HOST_ALLOWLIST,
} from '../src/mainnet-provider-http.js';

describe('assertMainnetProviderUrl SSRF / allowlist', () => {
  const prev = process.env.PHASE21_PROVIDER_HOST_ALLOWLIST;

  afterEach(() => {
    if (prev === undefined) delete process.env.PHASE21_PROVIDER_HOST_ALLOWLIST;
    else process.env.PHASE21_PROVIDER_HOST_ALLOWLIST = prev;
  });

  it('accepts allowlisted https toncenter / tonapi', () => {
    expect(assertMainnetProviderUrl('https://toncenter.com/api/v2', 't')).toBe(
      'https://toncenter.com/api/v2',
    );
    expect(assertMainnetProviderUrl('https://tonapi.io', 't')).toBe('https://tonapi.io');
    expect(PHASE21_DEFAULT_PROVIDER_HOST_ALLOWLIST).toContain('toncenter.com');
  });

  it('rejects http, credentials, query, fragment', () => {
    expect(() => assertMainnetProviderUrl('http://toncenter.com/api/v2', 't')).toThrow(
      /https/,
    );
    expect(() =>
      assertMainnetProviderUrl('https://user:pass@toncenter.com/api/v2', 't'),
    ).toThrow(/username|password/i);
    expect(() =>
      assertMainnetProviderUrl('https://toncenter.com/api/v2?api_key=secret', 't'),
    ).toThrow(/query/i);
    expect(() => assertMainnetProviderUrl('https://toncenter.com/api/v2#frag', 't')).toThrow(
      /fragment/i,
    );
  });

  it('rejects localhost / RFC1918 / unknown hosts', () => {
    expect(() => assertMainnetProviderUrl('https://localhost/api', 't')).toThrow(/forbidden|allowlist/i);
    expect(() => assertMainnetProviderUrl('https://127.0.0.1/api', 't')).toThrow(/forbidden|allowlist/i);
    expect(() => assertMainnetProviderUrl('https://10.0.0.5/api', 't')).toThrow(/forbidden|allowlist/i);
    expect(() => assertMainnetProviderUrl('https://192.168.1.1/api', 't')).toThrow(/forbidden|allowlist/i);
    expect(() => assertMainnetProviderUrl('https://169.254.1.1/api', 't')).toThrow(/forbidden|allowlist/i);
    expect(() => assertMainnetProviderUrl('https://evil.example/api', 't')).toThrow(/allowlist/i);
  });

  it('allows Owner allowlist override', () => {
    process.env.PHASE21_PROVIDER_HOST_ALLOWLIST = 'custom-provider.example';
    expect(assertMainnetProviderUrl('https://custom-provider.example/v2', 't')).toBe(
      'https://custom-provider.example/v2',
    );
  });

  it('rejects testnet hosts', () => {
    expect(() => assertMainnetProviderUrl('https://testnet.toncenter.com/api/v2', 't')).toThrow(
      /testnet|NETWORK_MISMATCH|forbidden/i,
    );
  });
});
