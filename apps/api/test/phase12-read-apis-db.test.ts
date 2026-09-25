/**
 * Phase 12 — read APIs against the real schema.
 *
 * Opt-in and destructive: set `PHASE12_DATABASE_URL`, or `PHASE12_API_TESTS=1` together with
 * a `DATABASE_URL` that the destructive-database guard in `@alex-rewards/db` recognises as a
 * test database. Without one of those the suite skips instead of inventing a fake database.
 *
 * Everything asserted here comes from migrations and real rows: the AdsGram BLOCKED verdict
 * is migration 0030's seeded policy data, and the zero balances are the genuine absence of
 * any ledger posting.
 */
import { ADSGRAM_CODE, getEarnSummaryForUser } from '@alex-rewards/ads';
import {
  assertConnectedDestructiveTestDatabase,
  assertSafeDestructiveTestDatabaseUrl,
  migrateDatabase,
} from '@alex-rewards/db';
import { readUserLedgerBalances } from '@alex-rewards/ledger';
import { readUserLifetimeEarned } from '@alex-rewards/rewards';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { toEarnProviderCard } from '../src/ads/earn-summary.js';
import { toUserBalancesResponse } from '../src/me/balances.js';

const explicitUrl = process.env.PHASE12_DATABASE_URL ?? '';
const optedInUrl = process.env.PHASE12_API_TESTS === '1' ? (process.env.DATABASE_URL ?? '') : '';
const databaseUrl = explicitUrl !== '' ? explicitUrl : optedInUrl;

const NETWORK_CODE = 'TON_TESTNET';
const ASSET_SYMBOL = 'USDT';

describe.skipIf(databaseUrl === '')('Phase 12 read APIs', () => {
  let pool: Pool;
  let userId: string;

  beforeAll(async () => {
    assertSafeDestructiveTestDatabaseUrl(databaseUrl);
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await assertConnectedDestructiveTestDatabase(client);
      await client.query('DROP SCHEMA IF EXISTS public CASCADE');
      await client.query('CREATE SCHEMA public');
      await client.query('GRANT ALL ON SCHEMA public TO PUBLIC');
    } finally {
      await client.end();
    }
    await migrateDatabase(databaseUrl);

    pool = new Pool({ connectionString: databaseUrl });
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO users (telegram_user_id, preferred_locale)
       VALUES ($1::bigint, 'en')
       RETURNING id`,
      ['912000000001'],
    );
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new Error('user insert failed');
    userId = id;
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  });

  it('reads authoritative zero balances without provisioning any ledger account', async () => {
    const balances = await readUserLedgerBalances(pool, {
      userId,
      networkCode: NETWORK_CODE,
      assetSymbol: ASSET_SYMBOL,
    });
    const lifetime = await readUserLifetimeEarned(pool, { userId, assetId: balances.assetId });
    const response = toUserBalancesResponse(balances, lifetime.amountAtomic);

    expect(response.available).toMatchObject({ state: 'READY', amountAtomic: '0' });
    expect(response.pending).toMatchObject({ state: 'READY', amountAtomic: '0' });
    expect(response.reserved).toMatchObject({ state: 'READY', amountAtomic: '0' });
    expect(response.lifetimeEarned).toMatchObject({ state: 'READY', amountAtomic: '0' });

    // Reading a balance is not a financial event: no account may have been created.
    const accounts = await pool.query<{ total: string }>(
      `SELECT count(*)::text AS total
       FROM ledger_accounts
       WHERE owner_type = 'USER' AND owner_id = $1::uuid`,
      [userId],
    );
    expect(accounts.rows[0]?.total).toBe('0');
  });

  it('reports the seeded AdsGram provider as BLOCKED for production money', async () => {
    const summary = await getEarnSummaryForUser(pool, {
      providerCode: ADSGRAM_CODE,
      userId,
      environment: 'STAGING',
    });
    const card = toEarnProviderCard(summary);

    expect(card.productionMonetaryStatus).toBe('BLOCKED');
    expect(card.monetaryEligible).toBe(false);
    expect(card.reasonCodes).toContain('PRODUCTION_MONETARY_STATUS_BLOCKED');
    // Versioned rules from migration 0030: REQUEST=30, SUCCESS=25, nothing used yet.
    expect(card.opportunitiesRemaining.request.maxCount).toBe(30);
    expect(card.opportunitiesRemaining.request.remaining).toBe(30);
    expect(card.opportunitiesRemaining.success.maxCount).toBe(25);
    expect(card.opportunitiesRemaining.success.remaining).toBe(25);
    // The seeded unit carries a placeholder, not a public block id.
    expect(card.blockIdPublic).toBeNull();
  });

  it('counts consumed opportunities from the authoritative daily counters', async () => {
    const provider = await pool.query<{ id: string }>(
      `SELECT id FROM ad_providers WHERE code = $1`,
      [ADSGRAM_CODE],
    );
    const providerId = provider.rows[0]?.id;
    expect(providerId).toBeDefined();

    await pool.query(
      `INSERT INTO ad_daily_counters (user_id, provider_id, utc_day, provider_requests, successful_rewards)
       VALUES ($1::uuid, $2::uuid, (now() AT TIME ZONE 'utc')::date, 3, 2)
       ON CONFLICT (user_id, provider_id, utc_day) DO UPDATE
         SET provider_requests = EXCLUDED.provider_requests,
             successful_rewards = EXCLUDED.successful_rewards`,
      [userId, providerId],
    );

    const card = toEarnProviderCard(
      await getEarnSummaryForUser(pool, {
        providerCode: ADSGRAM_CODE,
        userId,
        environment: 'STAGING',
      }),
    );
    expect(card.opportunitiesRemaining.request.usedCount).toBe(3);
    expect(card.opportunitiesRemaining.request.remaining).toBe(27);
    expect(card.opportunitiesRemaining.success.usedCount).toBe(2);
    expect(card.opportunitiesRemaining.success.remaining).toBe(23);
    expect(card.monetaryEligible).toBe(false);
  });
});
