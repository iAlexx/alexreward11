/**
 * Phase 20 Step 2 — empty mission list honesty (disposable DB).
 * TEST / DISPOSABLE DB ONLY — no fabricated rewards when no ACTIVE missions.
 *
 * Gate: PHASE20_DATABASE_URL, or PHASE16_DATABASE_URL, or
 * PHASE20_STEP2_REQUIRE_DB_GATES=1 (required), or PHASE20_MISSION_TESTS=1 + DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { listUserMissions } from '../src/index.js';
import { createPool, createTestUser, resetAndMigrate } from './harness.js';

function resolvePhase20DatabaseUrl(): string {
  const explicit = process.env.PHASE20_DATABASE_URL ?? process.env.PHASE16_DATABASE_URL ?? '';
  if (explicit !== '') return explicit;
  if (process.env.PHASE20_STEP2_REQUIRE_DB_GATES === '1') {
    throw new Error(
      'PHASE20_STEP2_REQUIRE_DB_GATES=1 requires PHASE20_DATABASE_URL (disposable *_test DB)',
    );
  }
  if (process.env.PHASE20_MISSION_TESTS === '1') {
    return process.env.DATABASE_URL ?? '';
  }
  return '';
}

const dbUrl = resolvePhase20DatabaseUrl();

describe.skipIf(dbUrl === '')('Phase 20 mission list empty (DB)', () => {
  let pool!: Pool;

  beforeAll(async () => {
    // TEST/DISPOSABLE ONLY
    await resetAndMigrate(dbUrl);
    pool = createPool(dbUrl);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  });

  it('listUserMissions returns [] with no fabricated rewards when no ACTIVE missions', async () => {
    const userId = await createTestUser(pool, String(Date.now()));
    const items = await listUserMissions(pool, { userId });
    expect(items).toEqual([]);
    expect(items.every((i) => i.reward === null && i.rewardAtomic === null)).toBe(true);

    const rewards = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM reward_events WHERE user_id = $1::uuid`,
      [userId],
    );
    expect(rewards.rows[0]!.c).toBe(0);

    const ledger = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM ledger_entries`,
    );
    expect(ledger.rows[0]!.c).toBe(0);
  });
});