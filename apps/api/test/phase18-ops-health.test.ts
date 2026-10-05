/**
 * Phase 18 Step 1 — Admin health API authority + public health compatibility.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const apiRoot = fileURLToPath(new URL('../src/', import.meta.url));
const adminSrc = join(apiRoot, 'admin');

describe('Phase 18 Admin ops-health API', () => {
  it('system health endpoints require AdminSessionGuard', () => {
    const source = readFileSync(join(adminSrc, 'system.controller.ts'), 'utf8');
    expect(source).toContain('@UseGuards(AdminSessionGuard)');
    expect(source).toContain("@Get('system')");
    expect(source).toContain("@Get('system/health')");
    expect(source).toContain('evaluateOpsHealth');
    expect(source).toContain('financialAuthority: false');
    expect(source).toContain("authoritativeSource: 'feature_flags'");
    expect(source).toContain('autoUnpause: false');
    expect(source).not.toMatch(/enabled\s*=\s*false/);
    expect(source).not.toMatch(/UPDATE\s+feature_flags/i);
    expect(source).not.toMatch(/\bpassword\b|\bapiKey\b|\bsessionToken\b|\bprivateKey\b|\bDATABASE_URL\b/i);
  });

  it('does not auto-unpause payout dispatch from health path', () => {
    const source = readFileSync(join(adminSrc, 'system.controller.ts'), 'utf8');
    expect(source).not.toMatch(/autoUnpause:\s*true/);
    expect(source).not.toMatch(/setFeatureFlagEnabled/);
    expect(source).toContain('PAYOUT_DISPATCH_PAUSE');
  });

  it('public health live/ready controllers remain present', () => {
    const health = readFileSync(join(apiRoot, 'health.controller.ts'), 'utf8');
    expect(health).toContain("@Get('live')");
    expect(health).toContain("@Get('ready')");
    expect(health).toContain('HealthController');
  });
});
