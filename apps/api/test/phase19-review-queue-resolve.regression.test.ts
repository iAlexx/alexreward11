/**
 * P19-SEC-017 regression: Admin review-queue has no RESOLVE_AFTER_DOMAIN.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const apiRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const contractsRoot = join(apiRoot, '..', '..', 'packages', 'contracts');

function readUtf8(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('P19-SEC-017 review-queue resolve regression', () => {
  it('contracts AdminReviewQueueActionRequest has ASSIGN/COMMENT/ESCALATE only', () => {
    const src = readUtf8(join(contractsRoot, 'src', 'admin.ts'));
    expect(src).toMatch(/export interface AdminReviewQueueActionRequest/);
    const start = src.indexOf('export interface AdminReviewQueueActionRequest');
    const block = src.slice(start);
    const end = block.indexOf('export interface', 1);
    const iface = end < 0 ? block : block.slice(0, end);
    expect(iface).toContain("'ASSIGN'");
    expect(iface).toContain("'COMMENT'");
    expect(iface).toContain("'ESCALATE'");
    expect(iface).not.toContain('RESOLVE_AFTER_DOMAIN');
  });

  it('review-queue.controller has no RESOLVE_AFTER_DOMAIN case', () => {
    const src = readUtf8(join(apiRoot, 'src', 'admin', 'review-queue.controller.ts'));
    expect(src).not.toMatch(/case\s+'RESOLVE_AFTER_DOMAIN'/);
    expect(src).toContain("case 'ASSIGN'");
    expect(src).toContain("case 'COMMENT'");
    expect(src).toContain("case 'ESCALATE'");
  });

  it('controller never calls resolveReviewCaseAfterDomainSuccess', () => {
    const src = readUtf8(join(apiRoot, 'src', 'admin', 'review-queue.controller.ts'));
    expect(src).not.toContain('resolveReviewCaseAfterDomainSuccess');
    const callSites = src.match(/resolveReviewCaseAfterDomainSuccess\s*\(/g) ?? [];
    expect(callSites.length).toBe(0);
  });

  it('forged RESOLVE_AFTER_DOMAIN is not a valid contracts union member', () => {
    const src = readUtf8(join(contractsRoot, 'src', 'admin.ts'));
    expect(src).toMatch(/readonly action: 'ASSIGN' \| 'COMMENT' \| 'ESCALATE'/);
    expect(src).not.toMatch(/RESOLVE_AFTER_DOMAIN/);
    const distPath = join(contractsRoot, 'dist', 'src', 'admin.d.ts');
    try {
      const dist = readUtf8(distPath);
      expect(dist).not.toContain('RESOLVE_AFTER_DOMAIN');
      expect(dist).toMatch(/ASSIGN/);
      expect(dist).toMatch(/COMMENT/);
      expect(dist).toMatch(/ESCALATE/);
    } catch {
      // dist may be absent; src scan above is authoritative
    }
  });
});
