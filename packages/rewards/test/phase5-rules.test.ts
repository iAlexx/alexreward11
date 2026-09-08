import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  activateRewardRuleVersion,
  createRewardRuleVersion,
  resolveRewardRule,
  RewardDomainError,
  withLedgerTransaction,
} from '../src/index.js';
import {
  createTestUser,
  phase5DatabaseUrl,
  resetAndMigrate,
  truncateRewardTables,
  usdtAssetId,
} from './harness.js';

describe.skipIf(phase5DatabaseUrl === '')('Phase 5 reward rules', () => {
  let pool: Pool;
  let assetId: string;

  beforeAll(async () => {
    await resetAndMigrate(phase5DatabaseUrl);
    pool = new Pool({ connectionString: phase5DatabaseUrl });
    assetId = await usdtAssetId(pool);
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await truncateRewardTables(pool);
    await createTestUser(pool, String(910_000_000_000 + Math.floor(Math.random() * 1_000_000)));
  });

  it('resolves exactly one ACTIVE rule and fails closed on zero matches', async () => {
    await withLedgerTransaction(pool, async (client) => {
      await createRewardRuleVersion(client, {
        code: 'test-only-rule-a',
        sourceType: 'PROMOTION',
        assetId,
        fixedRewardAtomic: '100',
        quoteTtlSeconds: 60,
        activate: true,
      });
    });

    const resolved = await withLedgerTransaction(pool, (client) =>
      resolveRewardRule(client, new Date(), {
        sourceType: 'PROMOTION',
        assetId,
      }),
    );
    expect(resolved.code).toBe('test-only-rule-a');

    await expect(
      withLedgerTransaction(pool, (client) =>
        resolveRewardRule(client, new Date(), {
          sourceType: 'TASK',
          assetId,
        }),
      ),
    ).rejects.toMatchObject({ code: 'RULE_NOT_FOUND' });
  });

  it('fails closed when multiple ACTIVE codes match the same context', async () => {
    await withLedgerTransaction(pool, async (client) => {
      await createRewardRuleVersion(client, {
        code: 'test-only-rule-x',
        sourceType: 'PROMOTION',
        assetId,
        fixedRewardAtomic: '100',
        quoteTtlSeconds: 60,
        activate: true,
      });
      await createRewardRuleVersion(client, {
        code: 'test-only-rule-y',
        sourceType: 'PROMOTION',
        assetId,
        fixedRewardAtomic: '200',
        quoteTtlSeconds: 60,
        activate: true,
      });
    });

    await expect(
      withLedgerTransaction(pool, (client) =>
        resolveRewardRule(client, new Date(), {
          sourceType: 'PROMOTION',
          assetId,
        }),
      ),
    ).rejects.toMatchObject({ code: 'RULE_AMBIGUOUS' });
  });

  it('rejects in-place financial mutation on reward_rules', async () => {
    const rule = await withLedgerTransaction(pool, (client) =>
      createRewardRuleVersion(client, {
        code: 'test-only-immutable',
        sourceType: 'PROMOTION',
        assetId,
        fixedRewardAtomic: '100',
        quoteTtlSeconds: 60,
        activate: true,
      }),
    );

    await expect(
      pool.query(`UPDATE reward_rules SET fixed_reward_atomic = 999 WHERE id = $1`, [rule.id]),
    ).rejects.toThrow(/immutable/i);
  });

  it('activates a draft by superseding the prior ACTIVE family window', async () => {
    const first = await withLedgerTransaction(pool, (client) =>
      createRewardRuleVersion(client, {
        code: 'test-only-versioned',
        sourceType: 'PROMOTION',
        assetId,
        fixedRewardAtomic: '100',
        quoteTtlSeconds: 60,
        activate: true,
      }),
    );
    const second = await withLedgerTransaction(pool, (client) =>
      createRewardRuleVersion(client, {
        code: 'test-only-versioned',
        sourceType: 'PROMOTION',
        assetId,
        fixedRewardAtomic: '250',
        quoteTtlSeconds: 60,
        activate: false,
      }),
    );
    expect(second.status).toBe('DRAFT');

    const activated = await withLedgerTransaction(pool, (client) =>
      activateRewardRuleVersion(client, second.id),
    );
    expect(activated.status).toBe('ACTIVE');
    expect(activated.fixedRewardAtomic).toBe('250');

    const prior = await pool.query<{ status: string }>(
      `SELECT status::text AS status FROM reward_rules WHERE id = $1`,
      [first.id],
    );
    expect(prior.rows[0]?.status).toBe('SUPERSEDED');
  });

  it('surfaces RewardDomainError type', () => {
    expect(new RewardDomainError('VALIDATION', 'x')).toBeInstanceOf(Error);
  });
});
