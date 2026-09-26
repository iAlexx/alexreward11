/**
 * CV-03 — security-gate database log summary must never emit credentials or full URLs.
 */
import { describe, expect, it } from 'vitest';

import { summarizeSecurityGateDatabaseTarget } from '../src/security-gate-db-summary.js';

describe('CV-03 security-gate database summary', () => {
  it('redacts userinfo and omits query-string secrets', () => {
    const samples = [
      'postgresql://owner:s3cret@127.0.0.1:55432/alex_rewards_test',
      // Colon-containing password (percent-encoded) + @ in password
      'postgresql://owner:p%40ss%3Awith%3Acolons@127.0.0.1:55432/alex_rewards_test',
      'postgresql://owner:s3cret@127.0.0.1:55432/alex_rewards_test?password=leak&sslmode=disable',
      'postgres://u:%2F%2Fweird%3Apass@db.example:5432/alex_rewards_phase7',
    ];
    for (const url of samples) {
      const out = summarizeSecurityGateDatabaseTarget(url);
      expect(out.ok).toBe(true);
      expect(out.summary).not.toMatch(/s3cret|p@ss|leak|weird|owner:|password=/i);
      expect(out.summary).not.toContain('://');
      expect(out.summary).toMatch(/^driver=postgresql db=/);
      expect(out.summary).toMatch(/host_kind=/);
    }
  });

  it('allowlists only driver, db name, and host_kind', () => {
    const out = summarizeSecurityGateDatabaseTarget(
      'postgresql://alice:hunter2@10.0.0.5:5432/alex_rewards_test',
    );
    expect(out).toEqual({
      ok: true,
      summary: 'driver=postgresql db=alex_rewards_test host_kind=ip',
    });
  });

  it('does not echo unparseable material', () => {
    const out = summarizeSecurityGateDatabaseTarget('not a url at all %%%');
    expect(out.ok).toBe(false);
    expect(out.summary).toBe('driver=postgresql parse=unparseable');
    expect(out.summary).not.toMatch(/%|not a url/i);
  });
});
