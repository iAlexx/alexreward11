import { describe, expect, it } from 'vitest';

import { parseStrictRfc3339, tryParseStrictRfc3339 } from '../src/strict-rfc3339.js';

describe('parseStrictRfc3339', () => {
  it('accepts Z, fractional, and offset forms and normalizes to ISO UTC', () => {
    expect(parseStrictRfc3339('2026-10-01T03:48:46Z')).toBe('2026-10-01T03:48:46.000Z');
    expect(parseStrictRfc3339('2026-10-01T03:48:46.745Z')).toBe('2026-10-01T03:48:46.745Z');
    expect(parseStrictRfc3339('2026-10-01T03:48:46+00:00')).toBe('2026-10-01T03:48:46.000Z');
    expect(parseStrictRfc3339('2026-10-01T05:48:46+02:00')).toBe('2026-10-01T03:48:46.000Z');
  });

  it('rejects non-RFC3339 forms that Date.parse may accept', () => {
    const rejects = [
      '2026-10-01',
      '2026-10-01 03:48:46Z',
      '10/01/2026',
      '2026-10-01T03:48Z',
      '2026-10-01T03:48:46',
      'garbage',
      '',
      '2026-13-01T03:48:46Z',
      '2026-10-32T03:48:46Z',
    ];
    for (const value of rejects) {
      expect(() => parseStrictRfc3339(value)).toThrow(/STRICT_RFC3339_INVALID/);
      expect(tryParseStrictRfc3339(value)).toBeNull();
    }
  });
});
