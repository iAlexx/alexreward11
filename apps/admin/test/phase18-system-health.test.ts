/**
 * Phase 18 Admin System Health UI — read-only invariants.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));

describe('Phase 18 SystemPage read-only', () => {
  it('renders system + business alerts without mutation controls', () => {
    const page = readFileSync(
      join(srcRoot, 'components/pages/SystemPage.tsx'),
      'utf8',
    );
    expect(page).toContain('getSystemHealth');
    expect(page).toContain('Business alerts');
    expect(page).toContain('payoutDispatchPause');
    expect(page).toContain('autoUnpause');
    // Display of autoUnpause=false is allowed; mutation/unpause controls are not.
    expect(page).not.toMatch(/setBalance|editBalance|UPDATE\s+ledger/i);
    expect(page).not.toMatch(/approvePayout|overrideBudget|overrideLimit/i);
    expect(page).not.toMatch(/onClick=\{[^}]*unpause/i);
    expect(page).not.toMatch(/>\s*Unpause\s*</i);
  });

  it('client maps Admin system health without inventing financial authority', () => {
    const client = readFileSync(join(srcRoot, 'lib/admin-api/client.ts'), 'utf8');
    expect(client).toContain("/v1/admin/system");
    expect(client).toContain('financialAuthority: false');
    expect(client).toContain('PAYOUT_DISPATCH_PAUSE');
  });
});
