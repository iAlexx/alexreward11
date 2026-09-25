/**
 * Phase 11 — provider limits are configuration, not code.
 *
 * The Owner requirement is explicit: replacing an approved provider value (for example the
 * documented 30 requests/user/UTC day with 100) must be a new approved, sourced rule
 * version — never an application change. This suite proves that by changing only rows in
 * `provider_limit_rules` and observing the enforced limit move, while the unrelated SUCCESS
 * dimension stays at its own approved value of 25.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { authorizeRewardedAdSession, resolveEffectiveProviderLimits } from '../src/index.js';

import {
  ADSGRAM_CODE,
  ADSGRAM_PROVIDER_ID,
  ADSGRAM_REQUEST_RULE_ID,
  PHASE11_APPROVER_ADMIN_ID,
  createAdBudgetPeriod,
  createAdRewardRule,
  createTestUser,
  phase11DatabaseUrl,
  resetAndMigrate,
  setDailyCounters,
  usdtAssetId,
  utcDayString,
} from './harness.js';

/**
 * Supersede the ACTIVE REQUEST rule and activate the Owner-approved replacement.
 *
 * This is the whole "change": two rows. The superseded version keeps its history, and the
 * replacement carries its own version number, trusted source and approver — the exclusion
 * constraint in migration 0009 guarantees the two never overlap in time.
 */
async function replaceRequestLimit(
  pool: Pool,
  input: { readonly maxCount: number; readonly cutover: Date; readonly ruleVersion: number },
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE provider_limit_rules
       SET status = 'SUPERSEDED', valid_to = $2::timestamptz, updated_at = now()
       WHERE id = $1::uuid`,
      [ADSGRAM_REQUEST_RULE_ID, input.cutover.toISOString()],
    );
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO provider_limit_rules (
         provider_id, limit_scope, limit_metric, limit_window, max_count, rule_version,
         status, valid_from, source_type, source_reference, reason,
         approved_by_admin_id, approved_at
       ) VALUES (
         $1::uuid, 'PROVIDER_HARD', 'REQUEST', 'UTC_DAY', $2, $3,
         'ACTIVE', $4::timestamptz, 'WRITTEN_SUPPORT',
         'AdsGram written support answer: revised provider request allowance',
         'Owner-approved limit revision', $5::uuid, now()
       )
       RETURNING id`,
      [
        ADSGRAM_PROVIDER_ID,
        input.maxCount,
        input.ruleVersion,
        input.cutover.toISOString(),
        PHASE11_APPROVER_ADMIN_ID,
      ],
    );
    await client.query('COMMIT');
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new Error('replacement limit rule insert failed');
    return id;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

describe.skipIf(phase11DatabaseUrl === '')('Phase 11 versioned provider limits', () => {
  let pool: Pool;
  let assetId: string;
  let budgetPeriodId: string;

  beforeAll(async () => {
    await resetAndMigrate(phase11DatabaseUrl);
    pool = new Pool({ connectionString: phase11DatabaseUrl });
    assetId = await usdtAssetId(pool);
    budgetPeriodId = await createAdBudgetPeriod(pool, { assetId });
    await createAdRewardRule(pool, { assetId, providerId: ADSGRAM_PROVIDER_ID });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
  });

  it('raises the REQUEST limit from 30 to 100 through a new rule version only', async () => {
    const utcDay = utcDayString();

    const before = await resolveEffectiveProviderLimits(pool, {
      providerId: ADSGRAM_PROVIDER_ID,
      asOf: new Date(),
    });
    expect(before.requestUtcDay?.maxCount).toBe(30);
    expect(before.requestUtcDay?.decidingRule.ruleVersion).toBe(1);

    // At 30 counted requests the approved value refuses a new session.
    const blockedUser = await createTestUser(pool);
    await setDailyCounters(pool, {
      userId: blockedUser,
      providerId: ADSGRAM_PROVIDER_ID,
      utcDay,
      providerRequests: 30,
    });
    await expect(
      authorizeRewardedAdSession(pool, {
        providerCode: ADSGRAM_CODE,
        userId: blockedUser,
        assetId,
        budgetPeriodId,
        environment: 'LOCAL',
        evaluateMembershipBonus: false,
      }),
    ).rejects.toMatchObject({ code: 'REQUEST_LIMIT_REACHED', details: { maxCount: 30 } });

    // The only change: a superseded version and an approved replacement row.
    const cutover = new Date(Date.now() - 1000);
    const replacementId = await replaceRequestLimit(pool, {
      maxCount: 100,
      cutover,
      ruleVersion: 2,
    });

    const after = await resolveEffectiveProviderLimits(pool, {
      providerId: ADSGRAM_PROVIDER_ID,
      asOf: new Date(),
    });
    expect(after.requestUtcDay?.maxCount).toBe(100);
    expect(after.requestUtcDay?.decidingRule.ruleId).toBe(replacementId);
    expect(after.requestUtcDay?.decidingRule.ruleVersion).toBe(2);
    expect(after.requestUtcDay?.decidingRule.sourceType).toBe('WRITTEN_SUPPORT');

    // The SUCCESS dimension was not part of the change and must not drift.
    expect(after.successUtcDay?.maxCount).toBe(25);
    expect(after.successUtcDay?.decidingRule.ruleVersion).toBe(1);

    // The same user that was refused a moment ago is now allowed — no code changed.
    const authorized = await authorizeRewardedAdSession(pool, {
      providerCode: ADSGRAM_CODE,
      userId: blockedUser,
      assetId,
      budgetPeriodId,
      environment: 'LOCAL',
      evaluateMembershipBonus: false,
    });
    expect(authorized.state).toBe('AUTHORIZED');
    expect(authorized.effectiveRequestLimit).toBe(100);
    expect(authorized.effectiveSuccessLimit).toBe(25);

    // SUCCESS is still enforced at its own approved value.
    const successUser = await createTestUser(pool);
    await setDailyCounters(pool, {
      userId: successUser,
      providerId: ADSGRAM_PROVIDER_ID,
      utcDay,
      providerRequests: 0,
      successfulRewards: 25,
    });
    await expect(
      authorizeRewardedAdSession(pool, {
        providerCode: ADSGRAM_CODE,
        userId: successUser,
        assetId,
        budgetPeriodId,
        environment: 'LOCAL',
        evaluateMembershipBonus: false,
      }),
    ).rejects.toMatchObject({ code: 'SUCCESS_LIMIT_REACHED', details: { maxCount: 25 } });

    // History is preserved: the old value is superseded, not overwritten.
    const versions = await pool.query<{ rule_version: number; max_count: number; status: string }>(
      `SELECT rule_version, max_count, status::text AS status
       FROM provider_limit_rules
       WHERE provider_id = $1::uuid AND limit_metric = 'REQUEST' AND limit_window = 'UTC_DAY'
       ORDER BY rule_version`,
      [ADSGRAM_PROVIDER_ID],
    );
    expect(versions.rows).toEqual([
      { rule_version: 1, max_count: 30, status: 'SUPERSEDED' },
      { rule_version: 2, max_count: 100, status: 'ACTIVE' },
    ]);
  });

  it('refuses to authorize when a required limit dimension has no ACTIVE rule', async () => {
    await pool.query(
      `UPDATE provider_limit_rules SET status = 'REVOKED', updated_at = now()
       WHERE provider_id = $1::uuid AND limit_metric = 'SUCCESS'`,
      [ADSGRAM_PROVIDER_ID],
    );
    try {
      const userId = await createTestUser(pool);
      await expect(
        authorizeRewardedAdSession(pool, {
          providerCode: ADSGRAM_CODE,
          userId,
          assetId,
          budgetPeriodId,
          environment: 'LOCAL',
          evaluateMembershipBonus: false,
        }),
      ).rejects.toMatchObject({ code: 'LIMIT_RULE_MISSING' });
    } finally {
      await pool.query(
        `UPDATE provider_limit_rules SET status = 'ACTIVE', updated_at = now()
         WHERE provider_id = $1::uuid AND limit_metric = 'SUCCESS'`,
        [ADSGRAM_PROVIDER_ID],
      );
    }
  });
});
