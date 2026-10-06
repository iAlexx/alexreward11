import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  PHASE21_CANARY_PAYOUT_EXPECTED_NET_ATOMIC,
  PHASE21_CANARY_FORWARD_TON_ATOMIC,
} from '../src/phase21-canary-payout-plan.js';
import {
  phase21CanaryPayoutJsonReplacer,
  stringifyPhase21CanaryPayoutJson,
} from '../src/phase21-canary-payout-json.js';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('phase21 canary PLAN JSON BigInt serialization', () => {
  it('serializes top-level BigInt as exact decimal string', () => {
    const raw = stringifyPhase21CanaryPayoutJson(190_000n, undefined);
    expect(raw).toBe('"190000"');
    expect(JSON.parse(raw)).toBe('190000');
  });

  it('serializes nested BigInt values', () => {
    const parsed = JSON.parse(
      stringifyPhase21CanaryPayoutJson({
        intendedTransfer: {
          usdtNetAtomic: PHASE21_CANARY_PAYOUT_EXPECTED_NET_ATOMIC,
          forwardTonAtomic: PHASE21_CANARY_FORWARD_TON_ATOMIC,
          nested: { attached: 50_000_000n },
        },
      }),
    );
    expect(parsed.intendedTransfer.usdtNetAtomic).toBe('190000');
    expect(parsed.intendedTransfer.forwardTonAtomic).toBe('1');
    expect(parsed.intendedTransfer.nested.attached).toBe('50000000');
  });

  it('keeps financial atomic amounts as exact strings (never Number)', () => {
    const huge = 9_007_199_254_740_993n; // beyond Number.MAX_SAFE_INTEGER
    const parsed = JSON.parse(
      stringifyPhase21CanaryPayoutJson({ grossAtomic: huge, feeAtomic: 10_000n }),
    );
    expect(parsed.grossAtomic).toBe('9007199254740993');
    expect(parsed.feeAtomic).toBe('10000');
    expect(typeof parsed.grossAtomic).toBe('string');
    expect(Number.isSafeInteger(Number(parsed.grossAtomic))).toBe(false);
  });

  it('leaves normal numbers/booleans/strings unchanged', () => {
    const parsed = JSON.parse(
      stringifyPhase21CanaryPayoutJson({
        n: 42,
        b: true,
        s: 'APPROVED',
        z: null,
      }),
    );
    expect(parsed).toEqual({ n: 42, b: true, s: 'APPROVED', z: null });
    expect(phase21CanaryPayoutJsonReplacer('n', 42)).toBe(42);
    expect(phase21CanaryPayoutJsonReplacer('b', false)).toBe(false);
    expect(phase21CanaryPayoutJsonReplacer('s', 'x')).toBe('x');
  });

  it('PLAN safety flags remain false in serialized envelope', () => {
    const parsed = JSON.parse(
      stringifyPhase21CanaryPayoutJson({
        ok: true,
        mode: 'PLAN',
        applied: false,
        mutated: false,
        signed: false,
        broadcast: false,
        productionMutationOccurred: false,
        signerActionOccurred: false,
        broadcastOccurred: false,
        readyForLivePayout: false,
        applyEnabled: false,
        intendedTransfer: {
          usdtNetAtomic: 190_000n,
          forwardTonAtomic: 1n,
        },
      }),
    );
    expect(parsed.productionMutationOccurred).toBe(false);
    expect(parsed.signerActionOccurred).toBe(false);
    expect(parsed.broadcastOccurred).toBe(false);
    expect(parsed.mutated).toBe(false);
    expect(parsed.signed).toBe(false);
    expect(parsed.broadcast).toBe(false);
    expect(parsed.applyEnabled).toBe(false);
    expect(parsed.intendedTransfer.usdtNetAtomic).toBe('190000');
  });

  it('CLI uses stringifyPhase21CanaryPayoutJson and has no raw JSON.stringify', () => {
    const src = readFileSync(path.resolve(here, '../src/cli/phase21-canary-payout.ts'), 'utf8');
    expect(src).toMatch(/stringifyPhase21CanaryPayoutJson/);
    expect(src).not.toMatch(/JSON\.stringify/);
    expect(src).toMatch(/applyPhase21CanaryPayout/);
  });
});
