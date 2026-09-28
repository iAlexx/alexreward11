/**
 * LOOTRA Step 5 — Tasks / Friends authority invariants.
 * Engines remain disabled; UI must not invent missions, referrals, or earnings.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TaskListItemDto } from '@alex-rewards/contracts';
import { describe, expect, it } from 'vitest';

import {
  ALLOWED_TASK_NAME_KEYS,
  isKnownTaskState,
  resolveTaskDisplayName,
  safeTaskProgress,
} from '../src/lib/tasks/task-display';

const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));

async function readSrc(relative: string): Promise<string> {
  return readFile(join(srcRoot, relative), 'utf8');
}

async function collectRuntimeSources(dir = srcRoot): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      out.push(...(await collectRuntimeSources(full)));
    } else if (/\.(tsx?|jsx?|css)$/.test(entry.name)) {
      out.push(await readFile(full, 'utf8'));
    }
  }
  return out;
}

describe('LOOTRA Step 5 Tasks authority', () => {
  it('A — ENGINE_NOT_ENABLED does not render fake task cards', async () => {
    const screen = await readSrc('components/TasksScreen.tsx');
    expect(screen).toMatch(/EngineUnavailableState/);
    expect(screen).toMatch(/ENGINE_NOT_ENABLED/);
    expect(screen).not.toMatch(/fakeTask|mockTask|sampleMission/i);
    // Items only render under READY
    expect(screen).toMatch(/data\.status === 'READY'/);
  });

  it('B — ENGINE_NOT_ENABLED is not empty-working-engine semantics', async () => {
    const screen = await readSrc('components/TasksScreen.tsx');
    const engine = await readSrc('components/EngineUnavailableState.tsx');
    expect(screen).toMatch(/engineDisabled/);
    expect(engine).toMatch(/comingSoon|engineTitle/);
    expect(screen).not.toMatch(/emptyTitle=\{t\('empty'\)\}.*ENGINE_NOT_ENABLED/s);
    // Distinct EMPTY branch for READY with zero items
    expect(screen).toMatch(/data\.items\.length === 0/);
  });

  it('C — no task Claim Reward button exists', async () => {
    const screen = await readSrc('components/TasksScreen.tsx');
    expect(screen).not.toMatch(/Claim Reward|claimReward|t\('claim'\)/i);
    expect(screen).not.toMatch(/onClick.*claim/i);
  });

  it('D — no task mutation API call exists', async () => {
    const client = await readSrc('lib/api/client.ts');
    const screen = await readSrc('components/TasksScreen.tsx');
    expect(client).toMatch(/getTasks\(\)/);
    expect(client).not.toMatch(/\/v1\/tasks\/[^'"]+\/(claim|verify|complete|progress)/);
    expect(screen).not.toMatch(/claimTask|verifyTask|completeTask|mutateTask/);
    expect(screen).toMatch(/api\.getTasks/);
  });

  it('E — READY items render read-only server fields only', async () => {
    const screen = await readSrc('components/TasksScreen.tsx');
    expect(screen).toMatch(/item\.taskCode/);
    expect(screen).toMatch(/item\.progressCount/);
    expect(screen).toMatch(/item\.target/);
    expect(screen).toMatch(/item\.state/);
    expect(screen).not.toMatch(/rewardAmount|taskUrl|claimable|expiresAt|description/);
  });

  it('F — COMPLETED task does not automatically expose a claim action', async () => {
    const screen = await readSrc('components/TasksScreen.tsx');
    expect(screen).toMatch(/COMPLETED does not expose a claim/);
    expect(screen).not.toMatch(/state === ['"]COMPLETED['"].*claim|CLAIM.*button/is);
  });

  it('G — no task reward amount is fabricated', async () => {
    const screen = await readSrc('components/TasksScreen.tsx');
    expect(screen).toMatch(/rewardServerNote/);
    expect(screen).not.toMatch(/\+0\.02|\+500|USDT|rewardAmount/i);
  });

  it('H — task progress does not mutate financial/account state', () => {
    const item: TaskListItemDto = {
      taskCode: 't1',
      nameKey: 'unknown.key',
      state: 'IN_PROGRESS',
      progressCount: 2,
      target: 5,
    };
    const p = safeTaskProgress(item.progressCount, item.target);
    expect(p.progress).toBe(2);
    expect(p.target).toBe(5);
    expect(p.ratio).toBe(0.4);
    expect(resolveTaskDisplayName(item.nameKey, 'Task')).toBe('Task');
    expect(ALLOWED_TASK_NAME_KEYS.size).toBe(0);
    expect(isKnownTaskState('COMPLETED')).toBe(true);
    expect(isKnownTaskState('CLAIMABLE')).toBe(false);
  });
});

describe('LOOTRA Step 5 Friends / referral authority', () => {
  it('I — ENGINE_NOT_ENABLED does not show zero referral counts as truth', async () => {
    const screen = await readSrc('components/FriendsScreen.tsx');
    expect(screen).toMatch(/EngineUnavailableState/);
    expect(screen).toMatch(/ENGINE_NOT_ENABLED/);
    // Counts only inside READY summary with server data
    expect(screen).toMatch(/data\.invitedCount/);
    expect(screen).toMatch(/data\.activatedCount/);
    expect(screen).not.toMatch(/invitedCount:\s*0|activatedCount:\s*0/);
  });

  it('J/K/L/M — no fake usernames, percentages, earnings, or referral list', async () => {
    const screen = await readSrc('components/FriendsScreen.tsx');
    expect(screen).not.toMatch(/Mikhail|Sofia|Nour/);
    expect(screen).not.toMatch(/10%|3\.81|pendingCount|avatar|username/i);
    expect(screen).not.toMatch(/earned|commission|lifetime referral/i);
    expect(screen).not.toMatch(/mockReferral|fakeFriend|referralList/i);
  });

  it('N — Invite/Share is not enabled while engine is unavailable', async () => {
    const screen = await readSrc('components/FriendsScreen.tsx');
    const engine = await readSrc('components/EngineUnavailableState.tsx');
    expect(screen).not.toMatch(/t\('invite'\)|t\('shareLink'\)|Invite Friends|Share Link/);
    expect(engine).not.toMatch(/t\('invite'\)|t\('shareLink'\)|Invite|Share Link/i);
    expect(engine).not.toMatch(/clipboard|writeText/);
  });

  it('O/P — READY summary uses exact server invitedCount/activatedCount/referralCode', async () => {
    const screen = await readSrc('components/FriendsScreen.tsx');
    expect(screen).toMatch(/data\.invitedCount/);
    expect(screen).toMatch(/data\.activatedCount/);
    expect(screen).toMatch(/data\.referralCode/);
    expect(screen).toMatch(/navigator\.clipboard\.writeText\(data\.referralCode\)/);
  });

  it('Q — no Telegram deep link is fabricated from hardcoded business assumptions', async () => {
    const screen = await readSrc('components/FriendsScreen.tsx');
    expect(screen).not.toMatch(/t\.me\/|telegram\.me\/|startapp|botUsername|referralUrl/i);
  });
});

describe('LOOTRA Step 5 source scan', () => {
  it('forbids prototype literals and Claim Reward in runtime Mini App source', async () => {
    const sources = await collectRuntimeSources();
    const blob = sources.join('\n');
    expect(blob).not.toMatch(/\bMikhail\b/);
    expect(blob).not.toMatch(/\bSofia\b/);
    expect(blob).not.toMatch(/\bNour\b/);
    expect(blob).not.toMatch(/\b3\.81\b/);
    expect(blob).not.toMatch(/\b10%/);
    expect(blob).not.toMatch(/12 active/i);
    expect(blob).not.toMatch(/4 pending/i);
    expect(blob).not.toMatch(/Claim Reward/i);
    expect(blob).not.toMatch(/mockReferral/i);
    expect(blob).not.toMatch(/fakeTask/i);
  });

  it('tasks/friends use brand assets and keep loading/error/engine/ready distinct', async () => {
    const tasks = await readSrc('components/TasksScreen.tsx');
    const friends = await readSrc('components/FriendsScreen.tsx');
    expect(tasks).toMatch(/tasks-hero\.png/);
    expect(friends).toMatch(/bot-hero\.png/);
    expect(tasks).toMatch(/TasksSkeleton/);
    expect(friends).toMatch(/FriendsSkeleton/);
    expect(tasks).toMatch(/state=\"ERROR\"|state=\{'ERROR'\}|state=\"ERROR\"/);
    expect(tasks).toMatch(/EngineUnavailableState/);
    expect(tasks).toMatch(/READY/);
  });
});
