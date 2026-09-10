import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { PHASE9_DEFERRED_TO_PHASE_10, SIGNER_BOUNDARY } from '../src/index.js';

describe('Phase 9 boundary invariants', () => {
  it('documents no broadcast / no DB write / attempt-id-only input', () => {
    expect(SIGNER_BOUNDARY.mayBroadcastTon).toBe(false);
    expect(SIGNER_BOUNDARY.mayCallTonRpc).toBe(false);
    expect(SIGNER_BOUNDARY.mayWriteFinancialDb).toBe(false);
    expect(SIGNER_BOUNDARY.acceptedCallerInput).toEqual(['withdrawalAttemptId']);
    expect(PHASE9_DEFERRED_TO_PHASE_10.length).toBeGreaterThan(0);
  });

  it('packages/signing source does not import KMS client or TonClient', () => {
    const files = [
      'src/index.ts',
      'src/sign-attempt.ts',
      'src/canonical-message.ts',
      'src/local-ephemeral-kms.ts',
    ];
    for (const file of files) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      expect(source).not.toMatch(/@aws-sdk\/client-kms/);
      expect(source).not.toMatch(/TonClient/);
      expect(source).not.toMatch(/\.sendBoc\s*\(/);
    }
  });
});
