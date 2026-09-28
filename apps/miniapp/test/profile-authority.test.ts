/**
 * LOOTRA Step 6 — Profile / Founder / Support authority invariants.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { canReplyToSupportTicket } from '../src/lib/profile/profile-display';

const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));

async function readSrc(relative: string): Promise<string> {
  return readFile(join(srcRoot, relative), 'utf8');
}

describe('LOOTRA Step 6 settings authority', () => {
  it('A — only preferredLocale and publicPayoutIdentityMode are submitted', async () => {
    const profile = await readSrc('components/ProfileScreen.tsx');
    expect(profile).toMatch(/preferredLocale:\s*locale/);
    expect(profile).toMatch(/publicPayoutIdentityMode:\s*mode/);
    expect(profile).not.toMatch(/marketingNotificationsEnabled\s*:/);
    expect(profile).not.toMatch(/securityNotificationsEnabled\s*:/);
    expect(profile).toMatch(/api\.patchSettings\(body\)/);
  });

  it('B/C — marketing and security have NO mutation controls', async () => {
    const profile = await readSrc('components/ProfileScreen.tsx');
    expect(profile).toMatch(/Read-only status/);
    expect(profile).toMatch(/marketingNotificationsEnabled \? common\('on'\)/);
    expect(profile).not.toMatch(/patchSettings\.mutate\(\{[^}]*Notifications/);
    expect(profile).not.toMatch(
      /onChange=\{[^}]*marketingNotifications|onChange=\{[^}]*securityNotifications/,
    );
    expect(profile).not.toMatch(/type=["']checkbox["'][^>]*(marketing|security)/i);
  });

  it('D — security notifications cannot be disabled', async () => {
    const profile = await readSrc('components/ProfileScreen.tsx');
    expect(profile).toMatch(/notificationsSecurityLocked/);
    expect(profile).toMatch(/common\('on'\)/);
  });

  it('E/F — locale and payout privacy use server mutation', async () => {
    const profile = await readSrc('components/ProfileScreen.tsx');
    expect(profile).toMatch(/patchSettings\.mutate\(\{\s*preferredLocale/);
    expect(profile).toMatch(/patchSettings\.mutate\(\{\s*publicPayoutIdentityMode/);
    expect(profile).toMatch(/setPreferredLocale\(result\.preferredLocale\)/);
  });
});

describe('LOOTRA Step 6 Founder authority', () => {
  it('G/H/I — Founder status/number/entitlements from server', async () => {
    const founder = await readSrc('components/FounderClaimForm.tsx');
    expect(founder).toMatch(/api\.getMembership/);
    expect(founder).toMatch(/api\.getEntitlements/);
    expect(founder).toMatch(/view\.founderNumber/);
    expect(founder).not.toMatch(/founderNumber\s*[:=]\s*\d+/);
    expect(founder).toMatch(/entitlements\.data\?\.entitlements/);
  });

  it('J/K/L — claim requires claimCode; never persisted; cleared after terminal', async () => {
    const founder = await readSrc('components/FounderClaimForm.tsx');
    expect(founder).toMatch(/api\.claimFounder\(code\)/);
    expect(founder).toMatch(/claimCode\.trim\(\)/);
    expect(founder).toMatch(/clearCode/);
    expect(founder).toMatch(/onSuccess/);
    expect(founder).toMatch(/onError/);
    expect(founder).not.toMatch(/localStorage/);
    expect(founder).not.toMatch(/sessionStorage/);
  });

  it('M/N — no money animation; securityBypass debug not displayed', async () => {
    const founder = await readSrc('components/FounderClaimForm.tsx');
    expect(founder).toMatch(/moneyIssued: false|not a reward payout/i);
    expect(founder).not.toMatch(/securityBypass:\s*\{/);
    expect(founder).not.toMatch(/String\(view\.securityBypass\)/);
    expect(founder).not.toMatch(/animate.*money|confetti|ledgerPostings\s*\+/i);
  });
});

describe('LOOTRA Step 6 Support authority', () => {
  it('O/P/Q — list/detail/message use real wrappers', async () => {
    const list = await readSrc('components/SupportScreen.tsx');
    const detail = await readSrc('components/SupportDetailScreen.tsx');
    expect(list).toMatch(/api\.listSupportTickets/);
    expect(list).toMatch(/api\.createSupportTicket/);
    expect(detail).toMatch(/api\.getSupportTicket/);
    expect(detail).toMatch(/api\.postSupportMessage/);
    expect(detail).toMatch(/queryKeys\.supportTicket/);
  });

  it('R/S — CLOSED and RESOLVED reply disabled', () => {
    expect(canReplyToSupportTicket('CLOSED')).toBe(false);
    expect(canReplyToSupportTicket('RESOLVED')).toBe(false);
    expect(canReplyToSupportTicket('OPEN')).toBe(true);
    expect(canReplyToSupportTicket('WAITING_USER')).toBe(true);
  });

  it('T/U/V — no fake replies; body from server; ownership-safe failure', async () => {
    const detail = await readSrc('components/SupportDetailScreen.tsx');
    expect(detail).not.toMatch(/mockSupport|fakeReply|sampleMessage/i);
    expect(detail).toMatch(/message\.body/);
    expect(detail).toMatch(/supportUnavailable/);
    expect(detail).not.toMatch(/belongs to another|other user|IDOR/i);
  });
});

describe('LOOTRA Step 6 account deletion', () => {
  it('W/X/Y — review request only with explicit confirmation', async () => {
    const profile = await readSrc('components/ProfileScreen.tsx');
    expect(profile).toMatch(/requestAccountDeletion/);
    expect(profile).toMatch(/deletionConfirmLabel/);
    expect(profile).toMatch(/type=\"checkbox\"/);
    expect(profile).toMatch(/!deletionConfirmed/);
    expect(profile).toMatch(/review request|Deletion review|deletion review/i);
    expect(profile).not.toMatch(/Delete account now|immediate deletion of your account now/i);
  });

  it('Z/AA/AB — no local financial mutation; no auto logout; created=false honored', async () => {
    const profile = await readSrc('components/ProfileScreen.tsx');
    expect(profile).toMatch(/do not logout/i);
    expect(profile).not.toMatch(/deletionRequest\.mutate\(\);\s*void signOut|onSuccess:[\s\S]{0,200}signOut\(/);
    expect(profile).not.toMatch(/available\s*-=|setQueryData.*balances/);
    expect(profile).toMatch(/deletionRequest\.data\.created/);
    expect(profile).toMatch(/deletionExisting/);
  });
});

describe('LOOTRA Step 6 legal', () => {
  it('AC/AD/AE/AF — Terms/Privacy from env only; no invented URL or auth append', async () => {
    const profile = await readSrc('components/ProfileScreen.tsx');
    const env = await readSrc('lib/env.ts');
    expect(profile).toMatch(/termsOfServiceUrl\(\)/);
    expect(profile).toMatch(/privacyPolicyUrl\(\)/);
    expect(env).toMatch(/Never invents a legal destination/);
    expect(env).toMatch(/return null/);
    expect(profile).not.toMatch(/initData|accessToken|Authorization=/);
    expect(profile).not.toMatch(/https:\/\/lootra\.|terms\.example|privacy\.example/);
  });
});
