import { describe, expect, it } from 'vitest';

import { formatAtomicAmount, formatOptionalAtomic, parseAtomicAmount } from '../src/lib/money/format';
import { unavailableEnvelope } from '../src/lib/admin-api/client';

describe('Admin money formatting', () => {
  it('parses and formats BigInt-safe atomic amounts', () => {
    expect(parseAtomicAmount('1000000000000')).toBe(1000000000000n);
    expect(formatAtomicAmount('1000000000000')).toBe('1,000,000,000,000');
  });

  it('never invents zero for missing amounts', () => {
    expect(formatOptionalAtomic(null)).toBe('—');
    expect(formatOptionalAtomic(undefined)).toBe('—');
    expect(formatOptionalAtomic('')).toBe('—');
  });
});

describe('Admin UNAVAILABLE envelope', () => {
  it('returns null data rather than fabricated zeros', () => {
    const envelope = unavailableEnvelope<{ amountAtomic: string }>();
    expect(envelope.status).toBe('UNAVAILABLE');
    expect(envelope.data).toBeNull();
  });
});
