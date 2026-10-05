/**
 * Phase 11 certification gate — Owner TEST 1–20.
 *
 * Each `it` below is one numbered Owner test. The suite runs against a real PostgreSQL
 * database with the real migrations applied; there are no fakes, no stubbed money and no
 * fabricated provider payloads. Where a test needs a provider that is approved for
 * production money, it seeds a certification-only provider in the harness — never in a
 * production migration — so that AdsGram itself stays BLOCKED throughout (TEST 14).
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AdsDomainError,
  adRewardIdempotencyKey,
  attemptVerifyAndIssueAdReward,
  authorizeRewardedAdSession,
  expireAdSession,
  getProvider,
  getProviderAdminView,
  ingestAdsGramRewardUrl,
  listProviderCodes,
  recordAdSessionOutcome,
  recordClientSignal,
  recordProviderSignal,
  requireRegisteredProviderForMonetaryUse,
  resolveEffectiveProviderLimits,
  runProviderCertificationCases,
  type AuthorizeAdResult,
} from '../src/index.js';

import {
  ADSGRAM_CODE,
  ADSGRAM_PROVIDER_ID,
  ADSGRAM_REQUEST_RULE_ID,
  ADSGRAM_SUCCESS_RULE_ID,
  HARNESS_CERT_CODE,
  HARNESS_CERT_PROVIDER_ID,
  countLedgerTransactions,
  countLedgerTransactionsForQuote,
  createAdBudgetPeriod,
  createAdRewardRule,
  createTestUser,
  phase11DatabaseUrl,
  readQuoteStatus,
  readSessionRow,
  resetAndMigrate,
  seedHarnessCertProvider,
  seedProviderLimitRule,
  setDailyCounters,
  seedTerminalAuthorizedSessions,
  setProviderHealthSnapshot,
  telegramUserIdOf,
  usdtAssetId,
  utcDayString,
} from './harness.js';

describe.skipIf(phase11DatabaseUrl === '')('Phase 11 certification gate (Owner TEST 1-20)', () => {
  let pool: Pool;
  let assetId: string;
  let budgetPeriodId: string;

  beforeAll(async () => {
    await resetAndMigrate(phase11DatabaseUrl);
    pool = new Pool({ connectionString: phase11DatabaseUrl });
    assetId = await usdtAssetId(pool);
    budgetPeriodId = await createAdBudgetPeriod(pool, { assetId });

    // One ACTIVE AD rule per provider: provider-bound rules keep `resolveRewardRule`
    // unambiguous while two providers coexist in the same suite.
    await createAdRewardRule(pool, { assetId, providerId: ADSGRAM_PROVIDER_ID });
    await seedHarnessCertProvider(pool);
    await createAdRewardRule(pool, { assetId, providerId: HARNESS_CERT_PROVIDER_ID });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
  });

  async function authorize(providerCode: string, userId: string): Promise<AuthorizeAdResult> {
    return authorizeRewardedAdSession(pool, {
      providerCode,
      userId,
      assetId,
      budgetPeriodId,
      adUnitId: null,
      countryCode: null,
      environment: 'LOCAL',
      evaluateMembershipBonus: false,
    });
  }

  /** Drive the client-side half of a session: request → load → start → completion. */
  async function playClientToCompletion(adSessionId: string, userId: string): Promise<void> {
    for (const event of ['REQUEST_APPROVED', 'AD_LOADED', 'AD_STARTED', 'CLIENT_COMPLETION']) {
      await recordClientSignal(pool, { adSessionId, userId, eventType: event });
    }
  }

  // ---------------------------------------------------------------------------
  // TEST 1 — quote ↔ session FK direction
  // ---------------------------------------------------------------------------
  it('TEST 1: reward_quotes.ad_session_id is the sole authoritative FK', async () => {
    const userId = await createTestUser(pool);
    const session = await authorize(ADSGRAM_CODE, userId);

    const quote = await pool.query<{ ad_session_id: string | null; source_id: string }>(
      `SELECT ad_session_id, source_id FROM reward_quotes WHERE id = $1::uuid`,
      [session.rewardQuoteId],
    );
    expect(quote.rows[0]?.ad_session_id).toBe(session.adSessionId);
    expect(quote.rows[0]?.source_id).toBe(session.adSessionId);

    // ad_sessions.reward_quote_id survives only as a mirror of the authoritative FK.
    const mirrored = await readSessionRow(pool, session.adSessionId);
    expect(mirrored.rewardQuoteId).toBe(session.rewardQuoteId);

    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'reward_quotes' AND indexname = 'reward_quotes_ad_session_uidx'`,
    );
    expect(indexes.rowCount).toBe(1);

    // The AD invariant is enforced by the database, not only by application code:
    // breaking source_id = ad_session_id is refused and the stored row is unchanged.
    await expect(
      pool.query(`UPDATE reward_quotes SET source_id = gen_random_uuid() WHERE id = $1::uuid`, [
        session.rewardQuoteId,
      ]),
    ).rejects.toThrowError();
    const unchanged = await pool.query<{ source_id: string }>(
      `SELECT source_id FROM reward_quotes WHERE id = $1::uuid`,
      [session.rewardQuoteId],
    );
    expect(unchanged.rows[0]?.source_id).toBe(session.adSessionId);
  });

  // ---------------------------------------------------------------------------
  // TEST 2 — AdsGram is seeded as data, blocked for money
  // ---------------------------------------------------------------------------
  it('TEST 2: AdsGram is seeded ACTIVE, BLOCKED for money, with an open clarification register', async () => {
    const provider = await pool.query<{
      status: string;
      production_monetary_status: string;
      rewarded_use_allowed: boolean;
      incentivized_crypto_allowed: boolean;
    }>(
      `SELECT status::text AS status,
              production_monetary_status::text AS production_monetary_status,
              rewarded_use_allowed, incentivized_crypto_allowed
       FROM ad_providers WHERE code = $1`,
      [ADSGRAM_CODE],
    );
    expect(provider.rows[0]?.status).toBe('ACTIVE');
    expect(provider.rows[0]?.production_monetary_status).toBe('BLOCKED');
    expect(provider.rows[0]?.rewarded_use_allowed).toBe(true);
    expect(provider.rows[0]?.incentivized_crypto_allowed).toBe(false);

    const clarifications = await pool.query<{ open_count: string }>(
      `SELECT count(*)::text AS open_count FROM provider_clarification_items
       WHERE provider_id = $1::uuid AND status = 'OPEN'`,
      [ADSGRAM_PROVIDER_ID],
    );
    expect(Number(clarifications.rows[0]?.open_count)).toBe(6);

    const rules = await pool.query<{ id: string; limit_metric: string; max_count: number }>(
      `SELECT id, limit_metric::text AS limit_metric, max_count
       FROM provider_limit_rules
       WHERE provider_id = $1::uuid AND status = 'ACTIVE'
       ORDER BY limit_metric`,
      [ADSGRAM_PROVIDER_ID],
    );
    expect(rules.rows.map((row) => [row.limit_metric, row.max_count])).toEqual([
      ['REQUEST', 30],
      ['SUCCESS', 25],
    ]);
  });

  // ---------------------------------------------------------------------------
  // TEST 3 — compile-time provider registry
  // ---------------------------------------------------------------------------
  it('TEST 3: only a compile-time registered adapter can be routed, and registration grants no money', () => {
    expect(listProviderCodes()).toContain(ADSGRAM_CODE);
    expect(() => getProvider('NEVER_REGISTERED')).toThrowError(AdsDomainError);
    try {
      getProvider('NEVER_REGISTERED');
    } catch (error) {
      expect((error as AdsDomainError).code).toBe('PROVIDER_NOT_REGISTERED');
    }

    // Registered but not APPROVED in the database → still refused for monetary use.
    try {
      requireRegisteredProviderForMonetaryUse(ADSGRAM_CODE, 'BLOCKED');
      throw new Error('expected monetary refusal');
    } catch (error) {
      expect((error as AdsDomainError).code).toBe('PROVIDER_MONETARY_BLOCKED');
    }
    expect(requireRegisteredProviderForMonetaryUse(HARNESS_CERT_CODE, 'APPROVED').code).toBe(
      HARNESS_CERT_CODE,
    );
  });

  // ---------------------------------------------------------------------------
  // TEST 4 — per-dimension limit resolution takes the strictest applicable rule
  // ---------------------------------------------------------------------------
  it('TEST 4: effective limits resolve per dimension from versioned data, strictest wins', async () => {
    const asOf = new Date();
    const baseline = await resolveEffectiveProviderLimits(pool, {
      providerId: ADSGRAM_PROVIDER_ID,
      asOf,
    });
    expect(baseline.requestUtcDay?.maxCount).toBe(30);
    expect(baseline.requestUtcDay?.decidingRule.limitScope).toBe('PROVIDER_HARD');
    expect(baseline.successUtcDay?.maxCount).toBe(25);
    expect(baseline.ruleVersions).toHaveLength(2);

    const stricter = await seedProviderLimitRule(pool, {
      providerId: ADSGRAM_PROVIDER_ID,
      limitScope: 'PLATFORM_SOFT',
      limitMetric: 'REQUEST',
      maxCount: 5,
    });
    const looser = await seedProviderLimitRule(pool, {
      providerId: ADSGRAM_PROVIDER_ID,
      limitScope: 'USER_TIER',
      limitMetric: 'SUCCESS',
      maxCount: 9999,
    });
    try {
      const resolved = await resolveEffectiveProviderLimits(pool, {
        providerId: ADSGRAM_PROVIDER_ID,
        asOf,
      });
      // A platform rule may only tighten a provider hard limit...
      expect(resolved.requestUtcDay?.maxCount).toBe(5);
      expect(resolved.requestUtcDay?.hardCeilingMaxCount).toBe(30);
      // ...and can never loosen one.
      expect(resolved.successUtcDay?.maxCount).toBe(25);
    } finally {
      await pool.query(`DELETE FROM provider_limit_rules WHERE id = ANY($1::uuid[])`, [
        [stricter, looser],
      ]);
    }
  });

  // ---------------------------------------------------------------------------
  // TEST 5 — atomic session + quote authorization
  // ---------------------------------------------------------------------------
  it('TEST 5: authorization creates session and quote atomically with pre-generated ids', async () => {
    const userId = await createTestUser(pool);
    const before = await countLedgerTransactions(pool);
    const session = await authorize(ADSGRAM_CODE, userId);

    expect(session.state).toBe('AUTHORIZED');
    expect(session.effectiveRequestLimit).toBe(30);
    expect(session.effectiveSuccessLimit).toBe(25);
    expect(BigInt(session.quotedAmountAtomic)).toBeGreaterThan(0n);
    expect(session.membershipBonusAmountAtomic).toBe('0');

    expect(await readQuoteStatus(pool, session.rewardQuoteId)).toBe('OPEN');

    const signals = await pool.query<{ signal_type: string }>(
      `SELECT signal_type FROM ad_session_signals WHERE ad_session_id = $1::uuid
       ORDER BY received_at, id`,
      [session.adSessionId],
    );
    expect(signals.rows.map((row) => row.signal_type)).toEqual([
      'SESSION_CREATED',
      'QUOTE_COMMITTED',
      'AUTHORIZATION_PASSED',
    ]);

    // A quote is a priced promise backed by a reservation — not money.
    expect(await countLedgerTransactions(pool)).toBe(before);
    const reservation = await pool.query<{ state: string }>(
      `SELECT state::text AS state FROM reward_budget_reservations WHERE reward_quote_id = $1::uuid`,
      [session.rewardQuoteId],
    );
    expect(reservation.rows[0]?.state).toBe('ACTIVE');
  });

  // ---------------------------------------------------------------------------
  // TEST 6 — one live session per user per provider
  // ---------------------------------------------------------------------------
  it('TEST 6: a second live session for the same user and provider is refused', async () => {
    const userId = await createTestUser(pool);
    await authorize(ADSGRAM_CODE, userId);
    await expect(authorize(ADSGRAM_CODE, userId)).rejects.toMatchObject({
      code: 'SESSION_ALREADY_ACTIVE',
    });
  });

  // ---------------------------------------------------------------------------
  // TEST 7 — client evidence has no financial authority
  // ---------------------------------------------------------------------------
  it('TEST 7: a client completion alone can never reach VERIFIED or REWARDED', async () => {
    const userId = await createTestUser(pool);
    const session = await authorize(ADSGRAM_CODE, userId);
    await playClientToCompletion(session.adSessionId, userId);

    const afterClient = await readSessionRow(pool, session.adSessionId);
    expect(afterClient.state).toBe('CLIENT_COMPLETION_RECEIVED');

    const attempt = await attemptVerifyAndIssueAdReward(pool, {
      adSessionId: session.adSessionId,
      userId,
      idempotencyKey: adRewardIdempotencyKey(session.adSessionId),
    });
    expect(attempt.issued).toBe(false);
    expect(attempt.reasonCodes).toContain('PROVIDER_CONFIRMATION_MISSING');
    expect(await countLedgerTransactionsForQuote(pool, session.rewardQuoteId)).toBe(0);
    expect(await readQuoteStatus(pool, session.rewardQuoteId)).toBe('OPEN');
  });

  // ---------------------------------------------------------------------------
  // TEST 8 — Reward URL ingestion stores evidence and cannot credit money
  // ---------------------------------------------------------------------------
  it('TEST 8: the AdsGram Reward URL stores UNVERIFIED evidence and credits nothing', async () => {
    const userId = await createTestUser(pool);
    const telegramUserId = await telegramUserIdOf(pool, userId);
    const session = await authorize(ADSGRAM_CODE, userId);
    await playClientToCompletion(session.adSessionId, userId);

    const ledgerBefore = await countLedgerTransactions(pool);
    const result = await ingestAdsGramRewardUrl(pool, {
      query: { userid: telegramUserId, eventid: `evt-${session.adSessionId}`, blockid: '12345' },
    });

    expect(result.rewardCredited).toBe(false);
    expect(result.authenticity).toBe('UNVERIFIED');
    expect(result.correlation).toBe('CORRELATED');
    expect(result.adSessionId).toBe(session.adSessionId);
    expect(result.reasonCodes).toContain('SERVER_SIGNAL_UNAUTHENTICATED');
    expect(await countLedgerTransactions(pool)).toBe(ledgerBefore);

    // Correlated but unauthenticated evidence still moves the session no further than
    // "waiting for verification" — and verification is a separate, gated decision.
    expect((await readSessionRow(pool, session.adSessionId)).state).toBe('PENDING_VERIFICATION');

    const stored = await pool.query<{ authenticity_status: string; source: string }>(
      `SELECT authenticity_status::text AS authenticity_status, source::text AS source
       FROM ad_session_signals
       WHERE ad_session_id = $1::uuid AND signal_type = 'PROVIDER_CONFIRMATION'`,
      [session.adSessionId],
    );
    expect(stored.rows[0]?.authenticity_status).toBe('UNVERIFIED');
    expect(stored.rows[0]?.source).toBe('PROVIDER');
  });

  // ---------------------------------------------------------------------------
  // TEST 9 — duplicate server callback is idempotent
  // ---------------------------------------------------------------------------
  it('TEST 9: a replayed Reward URL call is recorded once as DUPLICATE', async () => {
    const userId = await createTestUser(pool);
    const telegramUserId = await telegramUserIdOf(pool, userId);
    const session = await authorize(ADSGRAM_CODE, userId);
    await playClientToCompletion(session.adSessionId, userId);

    const providerEventId = `evt-dup-${session.adSessionId}`;
    const query = { userid: telegramUserId, eventid: providerEventId };

    const first = await ingestAdsGramRewardUrl(pool, { query });
    const second = await ingestAdsGramRewardUrl(pool, { query });

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.processingStatus).toBe('DUPLICATE');
    expect(second.rewardCredited).toBe(false);

    const events = await pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM ad_provider_events
       WHERE provider_id = $1::uuid AND provider_event_id = $2`,
      [ADSGRAM_PROVIDER_ID, providerEventId],
    );
    expect(Number(events.rows[0]?.total)).toBe(1);

    const signals = await pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM ad_session_signals
       WHERE ad_session_id = $1::uuid AND signal_type = 'PROVIDER_CONFIRMATION'`,
      [session.adSessionId],
    );
    expect(Number(signals.rows[0]?.total)).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // TEST 10 — ambiguous correlation never becomes money
  // ---------------------------------------------------------------------------
  it('TEST 10: an AMBIGUOUS provider signal blocks the gate even for an approved provider', async () => {
    const userId = await createTestUser(pool);
    const session = await authorize(HARNESS_CERT_CODE, userId);
    await playClientToCompletion(session.adSessionId, userId);

    await recordProviderSignal(pool, {
      adSessionId: session.adSessionId,
      providerCode: HARNESS_CERT_CODE,
      eventType: 'REWARD',
      providerEventId: `evt-ambiguous-${session.adSessionId}`,
      authenticity: 'VERIFIED',
      correlation: 'AMBIGUOUS',
    });

    const attempt = await attemptVerifyAndIssueAdReward(pool, {
      adSessionId: session.adSessionId,
      userId,
      idempotencyKey: adRewardIdempotencyKey(session.adSessionId),
    });

    expect(attempt.issued).toBe(false);
    expect(attempt.monetary?.reasonCodes).toContain('SIGNAL_CORRELATION_AMBIGUOUS');
    expect(await countLedgerTransactionsForQuote(pool, session.rewardQuoteId)).toBe(0);
    expect((await readSessionRow(pool, session.adSessionId)).state).not.toBe('REWARDED');
  });

  // ---------------------------------------------------------------------------
  // TEST 11 — wrong user / wrong session / wrong provider
  // ---------------------------------------------------------------------------
  it('TEST 11: a session can only be advanced by its owner and its own provider', async () => {
    const owner = await createTestUser(pool);
    const stranger = await createTestUser(pool);
    const session = await authorize(ADSGRAM_CODE, owner);

    await expect(
      recordClientSignal(pool, {
        adSessionId: session.adSessionId,
        userId: stranger,
        eventType: 'CLIENT_COMPLETION',
      }),
    ).rejects.toMatchObject({ code: 'SESSION_USER_MISMATCH' });

    await expect(
      attemptVerifyAndIssueAdReward(pool, {
        adSessionId: session.adSessionId,
        userId: stranger,
        idempotencyKey: adRewardIdempotencyKey(session.adSessionId),
      }),
    ).rejects.toMatchObject({ code: 'SESSION_USER_MISMATCH' });

    await expect(
      recordProviderSignal(pool, {
        adSessionId: session.adSessionId,
        providerCode: HARNESS_CERT_CODE,
        eventType: 'REWARD',
        providerEventId: 'evt-wrong-provider',
      }),
    ).rejects.toMatchObject({ code: 'SIGNAL_REJECTED' });

    await expect(
      attemptVerifyAndIssueAdReward(pool, {
        adSessionId: '00000000-0000-4000-8000-000000000000',
        userId: owner,
        idempotencyKey: 'missing-session',
      }),
    ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  });

  // ---------------------------------------------------------------------------
  // TEST 12 — terminal outcomes are immutable and release the promise
  // ---------------------------------------------------------------------------
  it('TEST 12: a NO_FILL outcome is terminal, releases the quote and creates no money', async () => {
    const userId = await createTestUser(pool);
    const session = await authorize(ADSGRAM_CODE, userId);
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
    expect(outcome.quoteReleased).toBe(true);
    expect(await readQuoteStatus(pool, session.rewardQuoteId)).toBe('CANCELLED');

    const reservation = await pool.query<{ state: string }>(
      `SELECT state::text AS state FROM reward_budget_reservations WHERE reward_quote_id = $1::uuid`,
      [session.rewardQuoteId],
    );
    expect(reservation.rows[0]?.state).toBe('RELEASED');

    // Later evidence is still stored, but a terminal session never reopens.
    const late = await recordClientSignal(pool, {
      adSessionId: session.adSessionId,
      userId,
      eventType: 'CLIENT_COMPLETION',
    });
    expect(late.reasonCodes).toContain('TERMINAL_STATE_IMMUTABLE');
    expect((await readSessionRow(pool, session.adSessionId)).state).toBe('NO_FILL');

    await expect(
      attemptVerifyAndIssueAdReward(pool, {
        adSessionId: session.adSessionId,
        userId,
        idempotencyKey: adRewardIdempotencyKey(session.adSessionId),
      }),
    ).rejects.toMatchObject({ code: 'SESSION_TERMINAL' });
    expect(await countLedgerTransactionsForQuote(pool, session.rewardQuoteId)).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // TEST 13 — the evidence window closes
  // ---------------------------------------------------------------------------
  it('TEST 13: an expired session is terminal, releases its quote and cannot be rewarded', async () => {
    const userId = await createTestUser(pool);
    const session = await authorizeRewardedAdSession(pool, {
      providerCode: ADSGRAM_CODE,
      userId,
      assetId,
      budgetPeriodId,
      adUnitId: null,
      countryCode: null,
      environment: 'LOCAL',
      evaluateMembershipBonus: false,
      sessionTtlSeconds: 1,
    });

    const asOf = new Date(Date.now() + 10_000);
    const expired = await expireAdSession(pool, { adSessionId: session.adSessionId, asOf });
    expect(expired.state).toBe('EXPIRED');
    expect(expired.quoteReleased).toBe(true);
    expect(expired.reasonCodes).toContain('EVIDENCE_WINDOW_EXPIRED');
    expect(await readQuoteStatus(pool, session.rewardQuoteId)).toBe('CANCELLED');

    await expect(
      attemptVerifyAndIssueAdReward(pool, {
        adSessionId: session.adSessionId,
        userId,
        idempotencyKey: adRewardIdempotencyKey(session.adSessionId),
      }),
    ).rejects.toMatchObject({ code: 'SESSION_TERMINAL' });
  });

  // ---------------------------------------------------------------------------
  // TEST 14 — AdsGram production money is BLOCKED
  // ---------------------------------------------------------------------------
  it('TEST 14: AdsGram is refused production money even with complete, correlated evidence', async () => {
    const userId = await createTestUser(pool);
    const session = await authorize(ADSGRAM_CODE, userId);
    await playClientToCompletion(session.adSessionId, userId);

    // Deliberately the most favourable evidence this pipeline can ever hold.
    await recordProviderSignal(pool, {
      adSessionId: session.adSessionId,
      providerCode: ADSGRAM_CODE,
      eventType: 'REWARD',
      providerEventId: `evt-blocked-${session.adSessionId}`,
      authenticity: 'VERIFIED',
      correlation: 'CORRELATED',
    });

    const ledgerBefore = await countLedgerTransactions(pool);
    const attempt = await attemptVerifyAndIssueAdReward(pool, {
      adSessionId: session.adSessionId,
      userId,
      idempotencyKey: adRewardIdempotencyKey(session.adSessionId),
    });

    expect(attempt.issued).toBe(false);
    expect(attempt.reward).toBeNull();
    expect(attempt.monetary?.eligible).toBe(false);
    expect(attempt.monetary?.status).toBe('BLOCKED');
    // Every refusal reason is a data fact, not an AdsGram-specific code branch.
    expect(attempt.monetary?.reasonCodes).toEqual(
      expect.arrayContaining([
        'PRODUCTION_MONETARY_STATUS_BLOCKED',
        'CASH_REWARD_POLICY_NOT_APPROVED',
        'SERVER_SIGNAL_AUTHENTICATION_INSUFFICIENT',
        'SESSION_CORRELATION_NOT_CONFIRMED',
        'OPEN_CLARIFICATION_ITEMS',
      ]),
    );
    expect(await countLedgerTransactions(pool)).toBe(ledgerBefore);
    expect(await readQuoteStatus(pool, session.rewardQuoteId)).toBe('OPEN');

    const blocked = await pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM ad_session_signals
       WHERE ad_session_id = $1::uuid AND signal_type = 'MONETARY_GATE_BLOCKED'`,
      [session.adSessionId],
    );
    expect(Number(blocked.rows[0]?.total)).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // TEST 15 — daily caps come from versioned data
  // ---------------------------------------------------------------------------
  it('TEST 15: REQUEST and SUCCESS daily caps are enforced from the approved rule versions', async () => {
    const utcDay = utcDayString();

    // Conservative REQUEST safety uses server-created session count, not provider_requests.
    const requestUser = await createTestUser(pool);
    await seedTerminalAuthorizedSessions(pool, {
      userId: requestUser,
      providerId: ADSGRAM_PROVIDER_ID,
      utcDay,
      count: 30,
    });
    await expect(authorize(ADSGRAM_CODE, requestUser)).rejects.toMatchObject({
      code: 'REQUEST_LIMIT_REACHED',
      details: { maxCount: 30, decidingRuleId: ADSGRAM_REQUEST_RULE_ID },
    });

    const successUser = await createTestUser(pool);
    await setDailyCounters(pool, {
      userId: successUser,
      providerId: ADSGRAM_PROVIDER_ID,
      utcDay,
      successfulRewards: 25,
    });
    await expect(authorize(ADSGRAM_CODE, successUser)).rejects.toMatchObject({
      code: 'SUCCESS_LIMIT_REACHED',
      details: { maxCount: 25, decidingRuleId: ADSGRAM_SUCCESS_RULE_ID },
    });

    // One below the conservative session cap is still allowed.
    const okUser = await createTestUser(pool);
    await seedTerminalAuthorizedSessions(pool, {
      userId: okUser,
      providerId: ADSGRAM_PROVIDER_ID,
      utcDay,
      count: 29,
    });
    await setDailyCounters(pool, {
      userId: okUser,
      providerId: ADSGRAM_PROVIDER_ID,
      utcDay,
      successfulRewards: 24,
    });
    await expect(authorize(ADSGRAM_CODE, okUser)).resolves.toMatchObject({ state: 'AUTHORIZED' });
  });

  // ---------------------------------------------------------------------------
  // TEST 16 — an approved provider posts exactly one ledger transaction
  // ---------------------------------------------------------------------------
  it('TEST 16: an APPROVED provider issues exactly one ledger REWARD_ISSUANCE', async () => {
    const userId = await createTestUser(pool);
    const session = await authorize(HARNESS_CERT_CODE, userId);
    await playClientToCompletion(session.adSessionId, userId);
    await recordProviderSignal(pool, {
      adSessionId: session.adSessionId,
      providerCode: HARNESS_CERT_CODE,
      eventType: 'REWARD',
      providerEventId: `evt-approved-${session.adSessionId}`,
      authenticity: 'VERIFIED',
      correlation: 'CORRELATED',
    });

    const attempt = await attemptVerifyAndIssueAdReward(pool, {
      adSessionId: session.adSessionId,
      userId,
      idempotencyKey: adRewardIdempotencyKey(session.adSessionId),
    });

    expect(attempt.monetary?.eligible).toBe(true);
    expect(attempt.issued).toBe(true);
    expect(attempt.state).toBe('REWARDED');
    expect(attempt.reward?.baseAmountAtomic).toBe(session.baseAmountAtomic);

    // Exactly one posting for the quote, and it is balanced double entry.
    expect(await countLedgerTransactionsForQuote(pool, session.rewardQuoteId)).toBe(1);
    const posting = await pool.query<{
      transaction_type: string;
      entry_count: string;
      net: string;
    }>(
      `SELECT t.transaction_type::text AS transaction_type,
              count(e.id)::text AS entry_count,
              COALESCE(SUM(CASE WHEN e.direction = 'DEBIT' THEN e.amount_atomic
                                ELSE -e.amount_atomic END), 0)::text AS net
       FROM ledger_transactions t
       JOIN ledger_entries e ON e.ledger_transaction_id = t.id
       WHERE t.id = $1::uuid
       GROUP BY t.transaction_type`,
      [attempt.reward?.baseLedgerTransactionId],
    );
    expect(posting.rows[0]?.transaction_type).toBe('REWARD_ISSUANCE');
    expect(Number(posting.rows[0]?.entry_count)).toBe(2);
    expect(posting.rows[0]?.net).toBe('0');

    const events = await pool.query<{ total: string; state: string }>(
      `SELECT count(*)::text AS total, min(state::text) AS state
       FROM reward_events WHERE reward_quote_id = $1::uuid`,
      [session.rewardQuoteId],
    );
    expect(Number(events.rows[0]?.total)).toBe(1);
    expect(events.rows[0]?.state).toBe('PENDING');

    expect(await readQuoteStatus(pool, session.rewardQuoteId)).toBe('CONSUMED');
    const finalSession = await readSessionRow(pool, session.adSessionId);
    expect(finalSession.state).toBe('REWARDED');
    expect(finalSession.successfulRewardCounted).toBe(true);

    const counters = await pool.query<{ successful_rewards: number }>(
      `SELECT successful_rewards FROM ad_daily_counters
       WHERE user_id = $1::uuid AND provider_id = $2::uuid AND utc_day = $3::date`,
      [userId, HARNESS_CERT_PROVIDER_ID, utcDayString()],
    );
    expect(counters.rows[0]?.successful_rewards).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // TEST 17 — issuance is idempotent
  // ---------------------------------------------------------------------------
  it('TEST 17: retrying verification never produces a second reward', async () => {
    const userId = await createTestUser(pool);
    const session = await authorize(HARNESS_CERT_CODE, userId);
    await playClientToCompletion(session.adSessionId, userId);
    await recordProviderSignal(pool, {
      adSessionId: session.adSessionId,
      providerCode: HARNESS_CERT_CODE,
      eventType: 'REWARD',
      providerEventId: `evt-idem-${session.adSessionId}`,
      authenticity: 'VERIFIED',
      correlation: 'CORRELATED',
    });

    const key = adRewardIdempotencyKey(session.adSessionId);
    const first = await attemptVerifyAndIssueAdReward(pool, {
      adSessionId: session.adSessionId,
      userId,
      idempotencyKey: key,
    });
    const second = await attemptVerifyAndIssueAdReward(pool, {
      adSessionId: session.adSessionId,
      userId,
      idempotencyKey: key,
    });

    expect(first.issued).toBe(true);
    expect(second.issued).toBe(false);
    expect(second.alreadyRewarded).toBe(true);
    expect(await countLedgerTransactionsForQuote(pool, session.rewardQuoteId)).toBe(1);

    const events = await pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM reward_events WHERE reward_quote_id = $1::uuid`,
      [session.rewardQuoteId],
    );
    expect(Number(events.rows[0]?.total)).toBe(1);

    const counters = await pool.query<{ successful_rewards: number }>(
      `SELECT successful_rewards FROM ad_daily_counters
       WHERE user_id = $1::uuid AND provider_id = $2::uuid AND utc_day = $3::date`,
      [userId, HARNESS_CERT_PROVIDER_ID, utcDayString()],
    );
    expect(counters.rows[0]?.successful_rewards).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // TEST 18 — health gates new traffic, never earned rewards
  // ---------------------------------------------------------------------------
  it('TEST 18: provider health blocks new sessions and never reverses an issued reward', async () => {
    const userId = await createTestUser(pool);
    const session = await authorize(HARNESS_CERT_CODE, userId);
    await playClientToCompletion(session.adSessionId, userId);
    await recordProviderSignal(pool, {
      adSessionId: session.adSessionId,
      providerCode: HARNESS_CERT_CODE,
      eventType: 'REWARD',
      providerEventId: `evt-health-${session.adSessionId}`,
      authenticity: 'VERIFIED',
      correlation: 'CORRELATED',
    });
    const issued = await attemptVerifyAndIssueAdReward(pool, {
      adSessionId: session.adSessionId,
      userId,
      idempotencyKey: adRewardIdempotencyKey(session.adSessionId),
    });
    expect(issued.issued).toBe(true);

    try {
      await setProviderHealthSnapshot(
        pool,
        HARNESS_CERT_PROVIDER_ID,
        'UNAVAILABLE',
        'CERTIFICATION_OUTAGE',
      );
      const blockedUser = await createTestUser(pool);
      await expect(authorize(HARNESS_CERT_CODE, blockedUser)).rejects.toMatchObject({
        code: 'PROVIDER_UNHEALTHY',
      });

      // The outage is operational. It does not rewrite an earned reward.
      expect((await readSessionRow(pool, session.adSessionId)).state).toBe('REWARDED');
      expect(await countLedgerTransactionsForQuote(pool, session.rewardQuoteId)).toBe(1);
    } finally {
      await setProviderHealthSnapshot(
        pool,
        HARNESS_CERT_PROVIDER_ID,
        'HEALTHY',
        'CERTIFICATION_RECOVERED',
      );
    }
  });

  // ---------------------------------------------------------------------------
  // TEST 19 — the certification suite cannot approve itself
  // ---------------------------------------------------------------------------
  it('TEST 19: a missing certification case is SKIPPED, never an implicit pass', async () => {
    const run = await runProviderCertificationCases(ADSGRAM_CODE, {
      db: pool,
      environment: 'LOCAL',
      cases: {
        VALID_COMPLETION: () => ({ status: 'PASSED', reasonCodes: ['HARNESS_VERIFIED'] }),
      },
    });

    expect(run.summary.mandatoryTotal).toBe(20);
    expect(run.summary.passed).toBe(1);
    expect(run.summary.skipped).toBe(run.summary.total - 1);
    expect(run.summary.allMandatoryPassed).toBe(false);
    expect(run.overallStatus).toBe('BLOCKED');
    expect(run.reasonCodes).toContain('MANDATORY_CASES_INCOMPLETE');

    // Even a fully green suite would not approve money by itself; the data still refuses.
    expect(run.monetary?.eligible).toBe(false);
    expect(run.productionMonetaryApprovalRecommended).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // TEST 20 — implementation completeness is not monetary approval
  // ---------------------------------------------------------------------------
  it('TEST 20: the admin view reports a registered adapter and a refused monetary gate', async () => {
    const adsGram = await getProviderAdminView(pool, { providerCode: ADSGRAM_CODE });
    expect(adsGram.adapterRegistered).toBe(true);
    expect(adsGram.adapterCapabilities?.serverSignalAuthentication).toBe('NONE');
    expect(adsGram.productionMonetaryStatus).toBe('BLOCKED');
    expect(adsGram.monetary.eligible).toBe(false);
    expect(adsGram.openClarificationCount).toBe(6);
    expect(adsGram.limits.requestUtcDay?.maxCount).toBe(30);
    expect(adsGram.limits.successUtcDay?.maxCount).toBe(25);
    expect(adsGram.policyReference).toBe('docs/ADSGRAM_CLARIFICATION_REGISTER.md');

    // The same provider-neutral read approves the certification provider purely on data.
    const harness = await getProviderAdminView(pool, { providerCode: HARNESS_CERT_CODE });
    expect(harness.adapterRegistered).toBe(true);
    expect(harness.monetary.eligible).toBe(true);
    expect(harness.openClarificationCount).toBe(0);
  });
});
