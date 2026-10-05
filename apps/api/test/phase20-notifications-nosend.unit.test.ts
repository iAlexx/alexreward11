/**
 * Phase 20 Step 2 - static no-send / stub proofs for notifications (no DB).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('Phase 20 notifications stub / no-send (unit)', () => {
  it('packages/notifications exports empty stub module', () => {
    const index = readFileSync(
      join(process.cwd(), '../../packages/notifications/src/index.ts'),
      'utf8',
    );
    expect(index).toMatch(/intentionally not implemented/);
    expect(index).toMatch(/export\s*\{\s*\}/);
    expect(index).not.toMatch(/send|dispatch|broadcast|telegram/i);
  });

  it('Admin campaigns controller documents draft-only and refuses SECURITY', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/admin/notifications-admin.controller.ts'),
      'utf8',
    );
    expect(src).toMatch(/draft metadata only/);
    expect(src).toMatch(/category === ['"]SECURITY['"]/);
    expect(src).not.toMatch(/@(Post|Put|Patch)\([^)]*(send|dispatch|broadcast)/i);
  });
});