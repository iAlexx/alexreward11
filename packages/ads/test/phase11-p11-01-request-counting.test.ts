/**
 * Phase 11 P11-01 remediation — client signals must not be authoritative
 * provider-request counts; conservative authorize safety is session-based.
 *
 * These tests are designed to FAIL on the pre-remediation model (client
 * REQUEST_APPROVED → provider_requests++) and PASS after the fix.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  attemptVerifyAndIssueAdReward,
  authorizeRewardedAdSession,
  getProvider,
  ingestAdsGramRewardUrl,
  recordAdSessionOutcome,
  recordClientSignal,
  refuseClientAuthoritativeProviderRequestCount,
  type AuthorizeAdResult,
} from '../src/index.js';

import {
  ADSGRAM_CODE,
  ADSGRAM_PROVIDER_ID,
  ADSGRAM_REQUEST_RULE_ID,
  PHASE11_APPROVER_ADMIN_ID,
  countDailySessions,
  countLedgerTransactions,
  createAdBudgetPeriod,
  createAdRewardRule,
  createTestUser,
  phase11DatabaseUrl,
  readDailyProviderRequests,
  readSessionRow,
  resetAndMigrate,
  seedTerminalAuthorizedSessions,
  setDailyCounters,
  telegramUserIdOf,
  usdtAssetId,
  utcDayString,
} from './harness.js';

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
       WHERE id = $1::uuid AND status = 'ACTIVE'`,
      [ADSGRAM_REQUEST_RULE_ID, input.cutover.toISOString()],
    );
    // Also supersede any later ACTIVE replacement from a prior test in this file.
    await client.query(
      `UPDATE provider_limit_rules
       SET status = 'SUPERSEDED',
           valid_to = COALESCE(valid_to, $2::timestamptz),
           updated_at = now()
       WHERE provider_id = $1::uuid
         AND limit_metric = 'REQUEST'
         AND limit_window = 'UTC_DAY'
         AND status = 'ACTIVE'`,
      [ADSGRAM_PROVIDER_ID, input.cutover.toISOString()],
    );
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO provider_limit_rules (
         provider_id, limit_scope, limit_metric, limit_window, max_count, rule_version,
         status, valid_from, source_type, source_reference, reason,
         approved_by_admin_id, approved_at
       ) VALUES (
         $1::uuid, 'PROVIDER_HARD', 'REQUEST', 'UTC_DAY', $2, $3,
         'ACTIVE', $4::timestamptz, 'WRITTEN_SUPPORT',
         'P11-01 remediation test rule revision',
         'test limit revision', $5::uuid, now()
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

describe.skipIf(phase11DatabaseUrl === '')('Phase 11 P11-01 request counting remediation', () => {
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

  async function authorize(userId: string): Promise<AuthorizeAdResult> {
    return authorizeRewardedAdSession(pool, {
      providerCode: ADSGRAM_CODE,
      userId,
      assetId,
      budgetPeriodId,
      environment: 'LOCAL',
      evaluateMembershipBonus: false,
    });
  }

  it('P11-R1: client REQUEST_APPROVED stores CLIENT evidence without incrementing provider_requests', async () => {
    const utcDay = utcDayString();
    const userId = await createTestUser(pool);
    const session = await authorize(userId);
    expect(
      await readDailyProviderRequests(pool, { userId, providerId: ADSGRAM_PROVIDER_ID, utcDay }),
    ).toBe(0);

    const signal = await recordClientSignal(pool, {
      adSessionId: session.adSessionId,
      userId,
      eventType: 'REQUEST_APPROVED',
    });
    expect(signal.signalCreated).toBe(true);
    expect(signal.signalType).toBe('REQUEST_APPROVED');

    const stored = await pool.query<{ source: string; authenticity: string }>(
      `SELECT source::text AS source, authenticity_status::text AS authenticity
       FROM ad_session_signals
       WHERE ad_session_id = $1::uuid AND signal_type = 'REQUEST_APPROVED'`,
      [session.adSessionId],
    );
    expect(stored.rows[0]).toMatchObject({ source: 'CLIENT', authenticity: 'UNVERIFIED' });
    expect(
      await readDailyProviderRequests(pool, { userId, providerId: ADSGRAM_PROVIDER_ID, utcDay }),
    ).toBe(0);
    expect((await readSessionRow(pool, session.adSessionId)).providerRequestCounted).toBe(false);
  });

  it('P11-R2: duplicate client REQUEST_APPROVED still leaves provider_requests at 0', async () => {
    const utcDay = utcDayString();
    const userId = await createTestUser(pool);
    const session = await authorize(userId);
    await recordClientSignal(pool, {
      adSessionId: session.adSessionId,
      userId,
      eventType: 'REQUEST_APPROVED',
    });
    const dup = await recordClientSignal(pool, {
      adSessionId: session.adSessionId,
      userId,
      eventType: 'REQUEST_APPROVED',
    });
    expect(dup.signalCreated).toBe(false);
    expect(
      await readDailyProviderRequests(pool, { userId, providerId: ADSGRAM_PROVIDER_ID, utcDay }),
    ).toBe(0);
  });

  it('P11-R3: omitting REQUEST_APPROVED cannot bypass conservative authorize allowance', async () => {
    const utcDay = utcDayString();
    const userId = await createTestUser(pool);
    await seedTerminalAuthorizedSessions(pool, {
      userId,
      providerId: ADSGRAM_PROVIDER_ID,
      utcDay,
      count: 30,
    });
    // No client telemetry at all — authorize itself must refuse.
    await expect(authorize(userId)).rejects.toMatchObject({
      code: 'REQUEST_LIMIT_REACHED',
      details: { maxCount: 30 },
    });
  });

  it('P11-R4: fabricated NO_FILL yields no reward, no success count, no provider_requests', async () => {
    const utcDay = utcDayString();
    const userId = await createTestUser(pool);
    const session = await authorize(userId);
    const ledgerBefore = await countLedgerTransactions(pool);

    await recordClientSignal(pool, {
      adSessionId: session.adSessionId,
      userId,
      eventType: 'REQUEST_APPROVED',
    });
    const outcome = await recordAdSessionOutcome(pool, {
      adSessionId: session.adSessionId,
      userId,
      outcome: 'NO_FILL',
      failureCode: 'NO_FILL',
    });
    expect(outcome.state).toBe('NO_FILL');
    expect(await countLedgerTransactions(pool)).toBe(ledgerBefore);
    expect(
      await readDailyProviderRequests(pool, { userId, providerId: ADSGRAM_PROVIDER_ID, utcDay }),
    ).toBe(0);

    const counters = await pool.query<{ successful_rewards: number }>(
      `SELECT successful_rewards FROM ad_daily_counters
       WHERE user_id = $1::uuid AND provider_id = $2::uuid AND utc_day = $3::date`,
      [userId, ADSGRAM_PROVIDER_ID, utcDay],
    );
    expect(counters.rows[0]?.successful_rewards ?? 0).toBe(0);
  });

  it('P11-R5: AdsGram has no authoritative provider-request proof path; client path refuse-closed', async () => {
    expect(getProvider(ADSGRAM_CODE).getCapabilities().productionMonetaryStatus).toBe('BLOCKED');
    expect(() => refuseClientAuthoritativeProviderRequestCount()).toThrow(
      /cannot increment authoritative provider_requests/,
    );
  });

  it('P11-R6: conservative REQUEST limit 30 comes from versioned data', async () => {
    const utcDay = utcDayString();
    const userId = await createTestUser(pool);
    await seedTerminalAuthorizedSessions(pool, {
      userId,
      providerId: ADSGRAM_PROVIDER_ID,
      utcDay,
      count: 30,
    });
    await expect(authorize(userId)).rejects.toMatchObject({
      code: 'REQUEST_LIMIT_REACHED',
      details: { maxCount: 30, decidingRuleId: ADSGRAM_REQUEST_RULE_ID },
    });
  });

  it('P11-R7: new approved REQUEST rule 30→100 changes authorize allowance without code edit', async () => {
    const utcDay = utcDayString();
    const userId = await createTestUser(pool);
    await seedTerminalAuthorizedSessions(pool, {
      userId,
      providerId: ADSGRAM_PROVIDER_ID,
      utcDay,
      count: 30,
    });
    await expect(authorize(userId)).rejects.toMatchObject({ code: 'REQUEST_LIMIT_REACHED' });

    const cutover = new Date(Date.now() - 1000);
    await replaceRequestLimit(pool, { maxCount: 100, cutover, ruleVersion: 20 });

    const authorized = await authorize(userId);
    expect(authorized.state).toBe('AUTHORIZED');
    expect(authorized.effectiveRequestLimit).toBe(100);
  });

  it('P11-R8: client cannot exceed hard limit by omitting telemetry', async () => {
    const utcDay = utcDayString();
    // Restore a hard ceiling of 30 for this user-scale check via a fresh rule version.
    const cutover = new Date(Date.now() - 500);
    await replaceRequestLimit(pool, { maxCount: 30, cutover, ruleVersion: 21 });

    const userId = await createTestUser(pool);
    await seedTerminalAuthorizedSessions(pool, {
      userId,
      providerId: ADSGRAM_PROVIDER_ID,
      utcDay,
      count: 30,
    });
    await expect(authorize(userId)).rejects.toMatchObject({
      code: 'REQUEST_LIMIT_REACHED',
      details: { maxCount: 30 },
    });
  });

  it('P11-R9: AdsGram remains monetary BLOCKED', async () => {
    expect(getProvider(ADSGRAM_CODE).getCapabilities().productionMonetaryStatus).toBe('BLOCKED');
    const open = await pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM provider_clarification_items
       WHERE provider_id = $1::uuid AND status = 'OPEN'`,
      [ADSGRAM_PROVIDER_ID],
    );
    expect(Number(open.rows[0]?.total)).toBeGreaterThan(0);
  });

  it('P11-R10: client completion alone cannot issue reward', async () => {
    const userId = await createTestUser(pool);
    const session = await authorize(userId);
    for (const event of ['REQUEST_APPROVED', 'AD_LOADED', 'AD_STARTED', 'CLIENT_COMPLETION']) {
      await recordClientSignal(pool, {
        adSessionId: session.adSessionId,
        userId,
        eventType: event,
      });
    }
    const ledgerBefore = await countLedgerTransactions(pool);
    const result = await attemptVerifyAndIssueAdReward(pool, {
      adSessionId: session.adSessionId,
      userId,
    });
    expect(result.issued).toBe(false);
    expect(await countLedgerTransactions(pool)).toBe(ledgerBefore);
  });

  it('P11-R11: Reward URL remains evidence-only / UNVERIFIED', async () => {
    const userId = await createTestUser(pool);
    const telegramUserId = await telegramUserIdOf(pool, userId);
    const session = await authorize(userId);
    const ingested = await ingestAdsGramRewardUrl(pool, {
      query: {
        userid: telegramUserId,
        session_id: session.adSessionId,
      },
      receivedAt: new Date(),
    });
    expect(ingested.rewardCredited).toBe(false);
    expect(ingested.authenticity).toBe('UNVERIFIED');
  });

  it('P11-R12: NO_FILL / FAILED / SKIPPED cannot reward', async () => {
    for (const outcome of ['NO_FILL', 'FAILED', 'SKIPPED'] as const) {
      const userId = await createTestUser(pool);
      const session = await authorize(userId);
      const ledgerBefore = await countLedgerTransactions(pool);
      const result = await recordAdSessionOutcome(pool, {
        adSessionId: session.adSessionId,
        userId,
        outcome,
        failureCode: outcome,
      });
      expect(result.state).toBe(outcome);
      expect(await countLedgerTransactions(pool)).toBe(ledgerBefore);
    }
  });

  it('P11-R13: concurrent authorize at limit boundary creates at most N sessions', async () => {
    const utcDay = utcDayString();
    const cutover = new Date(Date.now() - 250);
    await replaceRequestLimit(pool, { maxCount: 3, cutover, ruleVersion: 22 });

    const userId = await createTestUser(pool);
    await seedTerminalAuthorizedSessions(pool, {
      userId,
      providerId: ADSGRAM_PROVIDER_ID,
      utcDay,
      count: 2,
    });

    const results = await Promise.allSettled(Array.from({ length: 12 }, () => authorize(userId)));
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBeLessThanOrEqual(1);
    expect(rejected.length).toBeGreaterThan(0);

    const total = await countDailySessions(pool, {
      userId,
      providerId: ADSGRAM_PROVIDER_ID,
      utcDay,
    });
    expect(total).toBeLessThanOrEqual(3);

    // Boundary exhaustion: after N sessions, further authorize refuses.
    if (total < 3) {
      await seedTerminalAuthorizedSessions(pool, {
        userId,
        providerId: ADSGRAM_PROVIDER_ID,
        utcDay,
        count: 3 - total,
      });
    }
    // Terminate any live winner so REQUEST_LIMIT (not SESSION_ALREADY_ACTIVE) is observed.
    await pool.query(
      `UPDATE ad_sessions SET state = 'NO_FILL', failure_code = 'TEST_TERMINATE', updated_at = now()
       WHERE user_id = $1::uuid AND provider_id = $2::uuid
         AND state IN ('CREATED','QUOTED','AUTHORIZED','REQUESTED','LOADED','STARTED',
                       'CLIENT_COMPLETION_RECEIVED','PROVIDER_CONFIRMATION_RECEIVED',
                       'PENDING_VERIFICATION','VERIFIED')`,
      [userId, ADSGRAM_PROVIDER_ID],
    );
    await expect(authorize(userId)).rejects.toMatchObject({
      code: 'REQUEST_LIMIT_REACHED',
      details: { maxCount: 3 },
    });
    expect(
      await countDailySessions(pool, { userId, providerId: ADSGRAM_PROVIDER_ID, utcDay }),
    ).toBe(3);
  });

  it('P11-R14: historical AUTHORIZATION_PASSED still identifies rule version N after N+1 activates', async () => {
    const cutoverN = new Date(Date.now() - 200);
    const ruleNId = await replaceRequestLimit(pool, {
      maxCount: 40,
      cutover: cutoverN,
      ruleVersion: 30,
    });

    const userId = await createTestUser(pool);
    const session = await authorize(userId);

    const authSignal = await pool.query<{
      requestLimitRuleId: string | null;
      requestLimitRuleVersion: number | null;
      effectiveRequestLimit: number | null;
    }>(
      `SELECT
         safe_payload_redacted->>'requestLimitRuleId' AS "requestLimitRuleId",
         (safe_payload_redacted->>'requestLimitRuleVersion')::int AS "requestLimitRuleVersion",
         (safe_payload_redacted->>'effectiveRequestLimit')::int AS "effectiveRequestLimit"
       FROM ad_session_signals
       WHERE ad_session_id = $1::uuid AND signal_type = 'AUTHORIZATION_PASSED'`,
      [session.adSessionId],
    );
    expect(authSignal.rows[0]).toMatchObject({
      requestLimitRuleId: ruleNId,
      requestLimitRuleVersion: 30,
      effectiveRequestLimit: 40,
    });

    const cutoverN1 = new Date(Date.now() - 50);
    await replaceRequestLimit(pool, { maxCount: 99, cutover: cutoverN1, ruleVersion: 31 });

    // Historical evidence must not drift to the new ACTIVE rule.
    const after = await pool.query<{
      requestLimitRuleId: string | null;
      requestLimitRuleVersion: number | null;
      effectiveRequestLimit: number | null;
    }>(
      `SELECT
         safe_payload_redacted->>'requestLimitRuleId' AS "requestLimitRuleId",
         (safe_payload_redacted->>'requestLimitRuleVersion')::int AS "requestLimitRuleVersion",
         (safe_payload_redacted->>'effectiveRequestLimit')::int AS "effectiveRequestLimit"
       FROM ad_session_signals
       WHERE ad_session_id = $1::uuid AND signal_type = 'AUTHORIZATION_PASSED'`,
      [session.adSessionId],
    );
    expect(after.rows[0]).toMatchObject({
      requestLimitRuleId: ruleNId,
      requestLimitRuleVersion: 30,
      effectiveRequestLimit: 40,
    });
  });

  it('P11-R15: conservative session usage > 0 while provider_requests stays 0', async () => {
    const utcDay = utcDayString();
    // Ensure a usable REQUEST allowance after prior tests mutated rules.
    const cutover = new Date(Date.now() - 10);
    await replaceRequestLimit(pool, { maxCount: 30, cutover, ruleVersion: 40 });

    const userId = await createTestUser(pool);
    await authorize(userId);
    await authorize(userId).catch(() => undefined); // may hit SESSION_ALREADY_ACTIVE
    // Terminate and authorize again so we have ≥1 session without client signals.
    await pool.query(
      `UPDATE ad_sessions SET state = 'NO_FILL', failure_code = 'TEST_TERMINATE', updated_at = now()
       WHERE user_id = $1::uuid AND provider_id = $2::uuid
         AND state NOT IN ('NO_FILL','FAILED','SKIPPED','REWARDED','REJECTED','EXPIRED')`,
      [userId, ADSGRAM_PROVIDER_ID],
    );
    await authorize(userId);

    const sessions = await countDailySessions(pool, {
      userId,
      providerId: ADSGRAM_PROVIDER_ID,
      utcDay,
    });
    expect(sessions).toBeGreaterThan(0);
    expect(
      await readDailyProviderRequests(pool, { userId, providerId: ADSGRAM_PROVIDER_ID, utcDay }),
    ).toBe(0);
    // Counter row exists as lock container with zeros.
    await setDailyCounters(pool, {
      userId,
      providerId: ADSGRAM_PROVIDER_ID,
      utcDay,
      providerRequests: 0,
      successfulRewards: 0,
    });
    expect(
      await readDailyProviderRequests(pool, { userId, providerId: ADSGRAM_PROVIDER_ID, utcDay }),
    ).toBe(0);
  });
});
