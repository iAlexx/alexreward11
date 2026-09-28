import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';

import {
  evaluateAndPersistTrust,
  persistTrustSnapshot,
  resolveActiveTrustRuleVersion,
} from '../src/index.js';
import {
  createPool,
  createTestUser,
  insertTrustRule,
  phase14DatabaseUrl,
  resetAndMigrate,
  TEST_TRUST_POLICY_CONFIG,
  waitForBlockedOnHolder,
} from './harness.js';

const SERVER_NOW = new Date('2026-07-01T00:00:00.000Z');
const RESTRICT_VIOLATION = '23001';
const CHECK_VIOLATION = '23514';

function useServerTime(at: Date): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at);
}

async function assetAndNetwork(pool: Pool): Promise<{ assetId: string; networkId: string }> {
  const asset = await pool.query<{ id: string; network_id: string }>(
    `SELECT a.id, a.network_id
     FROM assets a
     INNER JOIN networks n ON n.id = a.network_id
     WHERE n.code = 'TON_TESTNET'
     ORDER BY a.created_at ASC
     LIMIT 1`,
  );
  const row = asset.rows[0];
  if (row === undefined) throw new Error('TON_TESTNET asset missing');
  return { assetId: row.id, networkId: row.network_id };
}

async function setUserCreatedAt(pool: Pool, userId: string, createdAt: Date): Promise<void> {
  await pool.query(`UPDATE users SET created_at = $2::timestamptz WHERE id = $1::uuid`, [
    userId,
    createdAt.toISOString(),
  ]);
}

async function insertVerifiedPrimaryWallet(
  pool: Pool,
  input: { userId: string; networkId: string; verifiedAt: Date; rawSuffix: string },
): Promise<string> {
  const raw = `0:trustwallet${input.rawSuffix}${'a'.repeat(40)}`.slice(0, 66);
  const result = await pool.query<{ id: string }>(
    `INSERT INTO user_wallets (
       user_id, network_id, chain, raw_address, friendly_address,
       is_primary, verified, verification_method, verified_at, became_primary_at, created_at
     ) VALUES (
       $1::uuid, $2::uuid, 'TON', $3, $4,
       true, true, 'TON_PROOF', $5::timestamptz, $5::timestamptz, $5::timestamptz
     )
     RETURNING id`,
    [input.userId, input.networkId, raw, `EQ_TRUST_${input.rawSuffix}`, input.verifiedAt.toISOString()],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('wallet insert failed');
  return id;
}

async function insertAvailableAdReward(
  pool: Pool,
  input: { userId: string; sourceId: string; at: Date },
): Promise<void> {
  const { assetId } = await assetAndNetwork(pool);
  await pool.query(
    `INSERT INTO reward_events (
       user_id, source_type, source_id, asset_id, amount_atomic, state, created_at
     ) VALUES (
       $1::uuid, 'AD'::reward_source_type, $2::uuid, $3::uuid, 100, 'AVAILABLE'::reward_event_state,
       $4::timestamptz
     )`,
    [input.userId, input.sourceId, assetId, input.at.toISOString()],
  );
}

async function ensureFeeRule(pool: Pool, assetId: string, networkId: string): Promise<{
  feeRuleId: string;
  feeRuleVersion: number;
}> {
  const existing = await pool.query<{ id: string; rule_version: number }>(
    `SELECT id, rule_version FROM withdrawal_fee_rules
     WHERE asset_id = $1::uuid AND network_id = $2::uuid AND status = 'ACTIVE'
     ORDER BY rule_version ASC LIMIT 1`,
    [assetId, networkId],
  );
  if (existing.rows[0] !== undefined) {
    return { feeRuleId: existing.rows[0].id, feeRuleVersion: existing.rows[0].rule_version };
  }
  const inserted = await pool.query<{ id: string; rule_version: number }>(
    `INSERT INTO withdrawal_fee_rules (
       asset_id, network_id, rule_version, fixed_fee_atomic, percentage_bps,
       status, valid_from, reason
     ) VALUES (
       $1::uuid, $2::uuid, 1, 0, 0, 'ACTIVE', '2020-01-01'::timestamptz, 'phase14-trust-test-only'
     )
     RETURNING id, rule_version`,
    [assetId, networkId],
  );
  return { feeRuleId: inserted.rows[0]!.id, feeRuleVersion: inserted.rows[0]!.rule_version };
}

async function insertConfirmedWithdrawal(
  pool: Pool,
  input: { userId: string; walletId: string; key: string },
): Promise<void> {
  const { assetId, networkId } = await assetAndNetwork(pool);
  const fee = await ensureFeeRule(pool, assetId, networkId);
  const quote = await pool.query<{ id: string }>(
    `INSERT INTO withdrawal_quotes (
       user_id, asset_id, network_id, primary_wallet_id,
       requested_amount_atomic, fee_amount_atomic, net_amount_atomic,
       fee_rule_id, fee_rule_version, status, expires_at, base_platform_fee_atomic
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid,
       1000, 0, 1000,
       $5::uuid, $6, 'CONSUMED', now() + interval '1 hour', 0
     )
     RETURNING id`,
    [input.userId, assetId, networkId, input.walletId, fee.feeRuleId, fee.feeRuleVersion],
  );
  await pool.query(
    `INSERT INTO withdrawals (
       user_id, withdrawal_quote_id, asset_id, network_id, wallet_id,
       requested_amount_atomic, fee_amount_atomic, net_amount_atomic,
       state, approval_policy_version, priority_review,
       idempotency_scope, idempotency_key,
       fee_rule_id, fee_rule_version, base_platform_fee_atomic, membership_fee_discount_bps,
       confirmed_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
       1000, 0, 1000,
       'CONFIRMED', 1, false,
       $6, $7,
       $8::uuid, $9, 0, 0,
       now()
     )`,
    [
      input.userId,
      quote.rows[0]!.id,
      assetId,
      networkId,
      input.walletId,
      `trust-test:${input.userId}`,
      input.key,
      fee.feeRuleId,
      fee.feeRuleVersion,
    ],
  );
}

async function grantFounder(pool: Pool, userId: string): Promise<void> {
  const plan = await pool.query<{ id: string }>(
    `SELECT id FROM membership_plans WHERE code = 'FOUNDER_LIFETIME'`,
  );
  const planId = plan.rows[0]?.id;
  if (planId === undefined) throw new Error('FOUNDER_LIFETIME plan missing');
  await pool.query(
    `INSERT INTO user_memberships (
       user_id, membership_plan_id, status, source, claimed_at, founder_number
     ) VALUES (
       $1::uuid, $2::uuid, 'ACTIVE', 'OWNER_GRANT', now(),
       nextval('founder_number_seq')
     )`,
    [userId, planId],
  );
}

async function grantStandard(pool: Pool, userId: string): Promise<void> {
  const plan = await pool.query<{ id: string }>(
    `SELECT id FROM membership_plans WHERE code = 'STANDARD'`,
  );
  const planId = plan.rows[0]?.id;
  if (planId === undefined) throw new Error('STANDARD plan missing');
  await pool.query(
    `INSERT INTO user_memberships (
       user_id, membership_plan_id, status, source, claimed_at
     ) VALUES (
       $1::uuid, $2::uuid, 'ACTIVE', 'OWNER_GRANT', now()
     )`,
    [userId, planId],
  );
}

describe.skipIf(phase14DatabaseUrl === '')('Phase 14 Trust policy_config DB gates', () => {
  let pool: Pool;

  beforeAll(async () => {
    await resetAndMigrate(phase14DatabaseUrl);
    pool = createPool(phase14DatabaseUrl);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  it('rejects new ACTIVE trust rule with NULL policy_config', async () => {
    await expect(
      pool.query(
        `INSERT INTO trust_rule_versions (
           rule_version, status, effective_from, effective_to, reason, policy_config
         ) VALUES (
           910, 'ACTIVE'::rule_version_status, '2020-01-01'::timestamptz, NULL,
           'phase14-trust-null-config', NULL
         )`,
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('allows DRAFT trust rule with NULL policy_config', async () => {
    await expect(
      insertTrustRule(pool, {
        ruleVersion: 911,
        status: 'DRAFT',
        effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
        policyConfig: null,
      }),
    ).resolves.toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('rejects non-object policy_config', async () => {
    await expect(
      pool.query(
        `INSERT INTO trust_rule_versions (
           rule_version, status, effective_from, reason, policy_config
         ) VALUES (
           912, 'DRAFT'::rule_version_status, '2020-01-01'::timestamptz,
           'phase14-trust-array-config', '[]'::jsonb
         )`,
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });
});

describe.skipIf(phase14DatabaseUrl === '')('Phase 14 evaluateAndPersistTrust DB', () => {
  let pool: Pool;
  let userId: string;
  let founderUserId: string;
  let standardUserId: string;
  let networkId: string;

  beforeAll(async () => {
    await resetAndMigrate(phase14DatabaseUrl);
    pool = createPool(phase14DatabaseUrl);
    userId = await createTestUser(pool, '14001201');
    founderUserId = await createTestUser(pool, '14001202');
    standardUserId = await createTestUser(pool, '14001203');
    networkId = (await assetAndNetwork(pool)).networkId;

    await insertTrustRule(pool, {
      ruleVersion: 1,
      status: 'ACTIVE',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      effectiveTo: null,
      policyConfig: TEST_TRUST_POLICY_CONFIG,
    });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(() => {
    useServerTime(SERVER_NOW);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await pool.query(`DELETE FROM withdrawals WHERE user_id = ANY($1::uuid[])`, [
      [userId, founderUserId, standardUserId],
    ]);
    await pool.query(`DELETE FROM withdrawal_quotes WHERE user_id = ANY($1::uuid[])`, [
      [userId, founderUserId, standardUserId],
    ]);
    await pool.query(`DELETE FROM reward_events WHERE user_id = ANY($1::uuid[])`, [
      [userId, founderUserId, standardUserId],
    ]);
    await pool.query(`DELETE FROM user_wallets WHERE user_id = ANY($1::uuid[])`, [
      [userId, founderUserId, standardUserId],
    ]);
    await pool.query(`DELETE FROM user_memberships WHERE user_id = ANY($1::uuid[])`, [
      [userId, founderUserId, standardUserId],
    ]);
    await pool.query(
      `UPDATE users SET trust_state = 'NEW'::trust_state, created_at = now()
       WHERE id = ANY($1::uuid[])`,
      [[userId, founderUserId, standardUserId]],
    );
  });

  async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  it('fail closed when no ACTIVE trust rule', async () => {
    await pool.query(
      `UPDATE trust_rule_versions
       SET status = 'SUPERSEDED'::rule_version_status,
           effective_to = COALESCE(effective_to, now())
       WHERE status = 'ACTIVE'`,
    );
    await expect(
      withTx((client) => evaluateAndPersistTrust(client, { userId })),
    ).rejects.toMatchObject({ code: 'TRUST_RULE_NOT_CONFIGURED' });

    await insertTrustRule(pool, {
      ruleVersion: 101,
      status: 'ACTIVE',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      policyConfig: TEST_TRUST_POLICY_CONFIG,
    });
  });

  it('fail closed when ACTIVE policy_config is malformed', async () => {
    await pool.query(
      `UPDATE trust_rule_versions
       SET status = 'SUPERSEDED'::rule_version_status,
           effective_to = COALESCE(effective_to, now())
       WHERE status = 'ACTIVE'`,
    );
    await pool.query(
      `INSERT INTO trust_rule_versions (
         rule_version, status, effective_from, reason, policy_config
       ) VALUES (
         102, 'ACTIVE'::rule_version_status, '2020-01-01'::timestamptz,
         'phase14-trust-malformed', '{}'::jsonb
       )`,
    );
    await expect(
      withTx((client) => evaluateAndPersistTrust(client, { userId })),
    ).rejects.toMatchObject({ code: 'TRUST_POLICY_CONFIG_INVALID' });

    await pool.query(
      `UPDATE trust_rule_versions
       SET status = 'SUPERSEDED'::rule_version_status,
           effective_to = COALESCE(effective_to, now())
       WHERE status = 'ACTIVE'`,
    );
    await insertTrustRule(pool, {
      ruleVersion: 103,
      status: 'ACTIVE',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      policyConfig: TEST_TRUST_POLICY_CONFIG,
    });
  });

  it('projects NEW when no positive signals are present', async () => {
    const result = await withTx((client) => evaluateAndPersistTrust(client, { userId }));
    expect(result.evaluation.score).toBe(0);
    expect(result.evaluation.trustState).toBe('NEW');
    expect(result.snapshot.trustState).toBe('NEW');
    const user = await pool.query<{ trust_state: string }>(
      `SELECT trust_state::text AS trust_state FROM users WHERE id = $1::uuid`,
      [userId],
    );
    expect(user.rows[0]?.trust_state).toBe('NEW');
  });

  it('ACCOUNT_AGE satisfies when created_at age meets minDays', async () => {
    await setUserCreatedAt(pool, userId, new Date('2026-01-01T00:00:00.000Z')); // 181 days before SERVER_NOW
    const result = await withTx((client) => evaluateAndPersistTrust(client, { userId }));
    expect(result.signalFacts.find((f) => f.code === 'ACCOUNT_AGE')?.satisfied).toBe(true);
    expect(result.evaluation.score).toBe(25);
    expect(result.evaluation.trustState).toBe('BASIC');
  });

  it('VERIFIED_PRIMARY_WALLET_AGE satisfies for aged verified primary', async () => {
    await insertVerifiedPrimaryWallet(pool, {
      userId,
      networkId,
      verifiedAt: new Date('2026-01-01T00:00:00.000Z'),
      rawSuffix: 'age1',
    });
    const result = await withTx((client) => evaluateAndPersistTrust(client, { userId }));
    expect(
      result.signalFacts.find((f) => f.code === 'VERIFIED_PRIMARY_WALLET_AGE')?.satisfied,
    ).toBe(true);
    expect(result.evaluation.score).toBe(25);
  });

  it('REWARDED_AD_HISTORY counts AVAILABLE AD reward_events', async () => {
    await insertAvailableAdReward(pool, {
      userId,
      sourceId: randomUUID(),
      at: new Date('2026-06-01T00:00:00.000Z'),
    });
    const result = await withTx((client) => evaluateAndPersistTrust(client, { userId }));
    expect(result.signalFacts.find((f) => f.code === 'REWARDED_AD_HISTORY')?.satisfied).toBe(
      true,
    );
    expect(result.evaluation.score).toBe(25);
  });

  it('CONFIRMED_PAYOUT_HISTORY counts CONFIRMED withdrawals', async () => {
    // Use SQL now() for wallet timestamps so age is 0 against DB clock
    // (vitest fake timers do not affect PostgreSQL now()).
    const raw = `0:trustwalletpay1${'a'.repeat(40)}`.slice(0, 66);
    const wallet = await pool.query<{ id: string }>(
      `INSERT INTO user_wallets (
         user_id, network_id, chain, raw_address, friendly_address,
         is_primary, verified, verification_method, verified_at, became_primary_at, created_at
       ) VALUES (
         $1::uuid, $2::uuid, 'TON', $3, 'EQ_TRUST_pay1',
         true, true, 'TON_PROOF', now(), now(), now()
       )
       RETURNING id`,
      [userId, networkId, raw],
    );
    const walletId = wallet.rows[0]!.id;
    await insertConfirmedWithdrawal(pool, {
      userId,
      walletId,
      key: randomUUID(),
    });
    const result = await withTx((client) => evaluateAndPersistTrust(client, { userId }));
    expect(
      result.signalFacts.find((f) => f.code === 'CONFIRMED_PAYOUT_HISTORY')?.satisfied,
    ).toBe(true);
    expect(
      result.signalFacts.find((f) => f.code === 'VERIFIED_PRIMARY_WALLET_AGE')?.satisfied,
    ).toBe(false);
    expect(result.evaluation.score).toBe(25);
    expect(result.evaluation.trustState).toBe('BASIC');
  });

  it('all four signals produce TRUSTED and update users.trust_state', async () => {
    await setUserCreatedAt(pool, userId, new Date('2025-01-01T00:00:00.000Z'));
    const walletId = await insertVerifiedPrimaryWallet(pool, {
      userId,
      networkId,
      verifiedAt: new Date('2025-06-01T00:00:00.000Z'),
      rawSuffix: 'all4',
    });
    await insertAvailableAdReward(pool, {
      userId,
      sourceId: randomUUID(),
      at: new Date('2026-05-01T00:00:00.000Z'),
    });
    await insertConfirmedWithdrawal(pool, { userId, walletId, key: randomUUID() });

    const result = await withTx((client) =>
      evaluateAndPersistTrust(client, {
        userId,
        safeContext: { evaluationLabel: 'all-four' },
      }),
    );
    expect(result.evaluation.score).toBe(100);
    expect(result.evaluation.trustState).toBe('TRUSTED');
    expect(result.snapshot.trustScore).toBe(100);
    expect(result.snapshot.reasonCodes).toEqual([
      'ACCOUNT_AGE_MET',
      'CONFIRMED_PAYOUT_HISTORY_MET',
      'REWARDED_AD_HISTORY_MET',
      'VERIFIED_PRIMARY_WALLET_AGE_MET',
    ]);

    const user = await pool.query<{ trust_state: string }>(
      `SELECT trust_state::text AS trust_state FROM users WHERE id = $1::uuid`,
      [userId],
    );
    expect(user.rows[0]?.trust_state).toBe('TRUSTED');

    const risk = await pool.query<{ c: string }>(`SELECT count(*)::text AS c FROM risk_snapshots`);
    expect(risk.rows[0]?.c).toBe('0');
    const ledger = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM ledger_entries`,
    );
    expect(ledger.rows[0]?.c).toBe('0');
    const userRow = await pool.query<{
      status: string;
      withdrawal_status: string;
    }>(
      `SELECT status::text AS status, withdrawal_status::text AS withdrawal_status
       FROM users WHERE id = $1::uuid`,
      [userId],
    );
    expect(userRow.rows[0]?.status).toBe('ACTIVE');
    expect(userRow.rows[0]?.withdrawal_status).toBe('ALLOWED');
  });

  it('Founder membership does not change Trust vs STANDARD with same facts', async () => {
    const createdAt = new Date('2025-01-01T00:00:00.000Z');
    await setUserCreatedAt(pool, founderUserId, createdAt);
    await setUserCreatedAt(pool, standardUserId, createdAt);
    await grantFounder(pool, founderUserId);
    await grantStandard(pool, standardUserId);

    const founder = await withTx((client) =>
      evaluateAndPersistTrust(client, { userId: founderUserId }),
    );
    const standard = await withTx((client) =>
      evaluateAndPersistTrust(client, { userId: standardUserId }),
    );

    expect(founder.evaluation.score).toBe(standard.evaluation.score);
    expect(founder.evaluation.trustState).toBe(standard.evaluation.trustState);
    expect(founder.evaluation.satisfiedSignals).toEqual(standard.evaluation.satisfiedSignals);
    expect(founder.evaluation.score).toBe(25);
    expect(founder.evaluation.trustState).toBe('BASIC');
  });

  it('trust snapshot rows are immutable', async () => {
    const snap = await withTx((client) => evaluateAndPersistTrust(client, { userId }));
    await expect(
      pool.query(`UPDATE trust_snapshots SET trust_score = 1 WHERE id = $1::uuid`, [
        snap.snapshot.id,
      ]),
    ).rejects.toBeTruthy();
    await expect(
      pool.query(`DELETE FROM trust_snapshots WHERE id = $1::uuid`, [snap.snapshot.id]),
    ).rejects.toBeTruthy();
  });
});

describe.skipIf(phase14DatabaseUrl === '')(
  'Phase 14 Trust referenced policy_config immutability',
  () => {
    let pool: Pool;
    let userId: string;

    beforeAll(async () => {
      await resetAndMigrate(phase14DatabaseUrl);
      pool = createPool(phase14DatabaseUrl);
      userId = await createTestUser(pool, '14001210');
    }, 120_000);

    afterAll(async () => {
      await pool.end();
    });

    it('rejects policy_config rewrite after first snapshot reference', async () => {
      await insertTrustRule(pool, {
        ruleVersion: 3010,
        status: 'ACTIVE',
        effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
        reason: 'phase14-trust-policy-immutability',
        policyConfig: TEST_TRUST_POLICY_CONFIG,
      });

      const client = await pool.connect();
      try {
        await persistTrustSnapshot(client, {
          userId,
          trustState: 'BASIC',
          trustScore: 25,
          ruleVersion: 3010,
          reasonCodes: ['TRUST_REF'],
          signals: { fixture: true },
        });
      } finally {
        client.release();
      }

      const before = await pool.query<{ policy_config: unknown }>(
        `SELECT policy_config FROM trust_rule_versions WHERE rule_version = 3010`,
      );

      await expect(
        pool.query(
          `UPDATE trust_rule_versions
           SET policy_config = $2::jsonb
           WHERE rule_version = $1`,
          [
            3010,
            JSON.stringify({
              signals: { ACCOUNT_AGE: { weight: 99, minDays: 99 } },
              stateThresholds: { basicMin: 1, establishedMin: 2, trustedMin: 3 },
            }),
          ],
        ),
      ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });

      const after = await pool.query<{ policy_config: unknown }>(
        `SELECT policy_config FROM trust_rule_versions WHERE rule_version = 3010`,
      );
      expect(after.rows[0]?.policy_config).toEqual(before.rows[0]?.policy_config);
    });

    it('evaluation-first: open evaluateAndPersistTrust blocks then rejects concurrent policy rewrite', async () => {
      await pool.query(
        `UPDATE trust_rule_versions SET status = 'SUPERSEDED' WHERE status = 'ACTIVE'`,
      );
      await insertTrustRule(pool, {
        ruleVersion: 3020,
        status: 'ACTIVE',
        effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
        reason: 'phase14-trust-ref-lock',
        policyConfig: TEST_TRUST_POLICY_CONFIG,
      });
      const original = await pool.query<{ policy_config: unknown }>(
        `SELECT policy_config FROM trust_rule_versions WHERE rule_version = 3020`,
      );

      useServerTime(SERVER_NOW);
      const clientA = await pool.connect();
      const clientB = await pool.connect();
      const watcher = await pool.connect();
      try {
        await clientA.query('BEGIN');
        await evaluateAndPersistTrust(clientA, { userId });
        const holderPid = (
          await clientA.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)
        ).rows[0]!.pid;

        const updatePromise = clientB.query(
          `UPDATE trust_rule_versions
           SET policy_config = $1::jsonb
           WHERE rule_version = 3020`,
          [
            JSON.stringify({
              signals: { ACCOUNT_AGE: { weight: 1, minDays: 1 } },
              stateThresholds: { basicMin: 1, establishedMin: 2, trustedMin: 3 },
            }),
          ],
        );
        expect(await waitForBlockedOnHolder(watcher, holderPid)).toBe(true);
        await clientA.query('COMMIT');
        await expect(updatePromise).rejects.toMatchObject({ code: RESTRICT_VIOLATION });

        const after = await pool.query<{ policy_config: unknown }>(
          `SELECT policy_config FROM trust_rule_versions WHERE rule_version = 3020`,
        );
        expect(after.rows[0]?.policy_config).toEqual(original.rows[0]?.policy_config);
      } finally {
        vi.useRealTimers();
        try {
          await clientA.query('ROLLBACK');
        } catch {
          /* ignore */
        }
        clientA.release();
        clientB.release();
        watcher.release();
      }
    }, 60_000);
  },
);

describe.skipIf(phase14DatabaseUrl === '')(
  'Phase 14 resolveActiveTrustRuleVersion requires usable policy_config',
  () => {
    let pool: Pool;

    beforeAll(async () => {
      await resetAndMigrate(phase14DatabaseUrl);
      pool = createPool(phase14DatabaseUrl);
    }, 120_000);

    afterAll(async () => {
      await pool.end();
    });

    it('resolveActiveTrustRuleVersion fails closed on empty object config', async () => {
      await pool.query(`DELETE FROM trust_rule_versions`);
      await pool.query(
        `INSERT INTO trust_rule_versions (
           rule_version, status, effective_from, reason, policy_config
         ) VALUES (
           1, 'ACTIVE'::rule_version_status, '2020-01-01'::timestamptz,
           'phase14-trust-empty-object', '{}'::jsonb
         )`,
      );
      const client = await pool.connect();
      try {
        await expect(resolveActiveTrustRuleVersion(client)).rejects.toMatchObject({
          code: 'TRUST_POLICY_CONFIG_INVALID',
        });
      } finally {
        client.release();
      }
    });
  },
);
