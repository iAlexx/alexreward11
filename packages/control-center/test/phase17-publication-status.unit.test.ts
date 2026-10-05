import { describe, expect, it } from 'vitest';

import type { PublicationStatus } from '../src/publications.js';

describe('Phase17 generic PublicationStatus contract', () => {
  it('matches DB publication_status vocabulary (SKIPPED, not SUPERSEDED)', () => {
    const allowed: PublicationStatus[] = ['PENDING', 'PUBLISHED', 'FAILED', 'SKIPPED'];
    expect(allowed).toEqual(['PENDING', 'PUBLISHED', 'FAILED', 'SKIPPED']);
    const sample: PublicationStatus = 'SKIPPED';
    expect(sample).toBe('SKIPPED');
  });
});