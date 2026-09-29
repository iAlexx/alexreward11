/**
 * Phase 15 Step 7 — referral code policy + ensureReferralCode + summary reads.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  assertReferralCodePolicyShape,
  ensureReferralCode,
  readReferralSummary,
  referralCodeEntropyBits,
  ReferralDomainError,
} from '../src/index.js';
import {
  createPool,
  createTestUser,
  phase15DatabaseUrl,
  resetAndMigrate,
  withClient,
} from './harness.js';

const TEST_ALPHABET =
  'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function entropyOkLength(): number {
  let len = 8;
  while (referralCodeEntropyBits(TEST_ALPHABET.length, len) < 96) len += 1;
  return len;
}

async function seedActivePolicy(
  pool: Pool,
  input: { readonly alphabet?: string; readonly length?: number; readonly version?: number } = {},
): Promise<void> {
  const alphabet = input.alphabet ?? TEST_ALPHABET;
  const length = input.length ?? entropyOkLength();
  assertReferralCodePolicyShape({ alphabet, codeLength: length });
  await pool.query(
    `INSERT INTO referral_code_policy_versions (
       policy_version, code_length, alphabet, status, effective_from, reason
     ) VALUES ($1, $2, $3, 'ACTIVE', now() - interval '1 hour', 'phase15-step7-test')`,
    [input.version ?? 1, length, alphabet],
  );
}

describe('Phase 15 code policy entropy (pure)', () => {
  it('rejects insufficient entropy and unsafe alphabet', () => {
    expect(referralCodeEntropyBits(2, 10)).toBeCloseTo(10, 5);
    expect(() =>
      assertReferralCodePolicyShape({ alphabet: 'ab', codeLength: 10 }),
    ).toThrow(ReferralDomainError);
    expect(() =>
      assertReferralCodePolicyShape({ alphabet: 'abc&def', codeLength: 40 }),
    ).toThrow(ReferralDomainError);
    expect(() =>
      assertReferralCodePolicyShape({ alphabet: 'aabb', codeLength: 40 }),
    ).toThrow(ReferralDomainError);
  });
});

describe.skipIf(phase15DatabaseUrl === '')('Phase 15 referral code policy DB', () => {
  let pool: Pool;
  let seq = 0;

  beforeAll(async () => {
    await resetAndMigrate(phase15DatabaseUrl);
    pool = createPool(phase15DatabaseUrl);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE TABLE
        referral_edges,
        referral_codes,
        referral_code_policy_versions,
        users
      RESTART IDENTITY CASCADE
    `);
    seq += 1;
  });

  it('fail-closes when no ACTIVE policy exists', async () => {
    const userId = await createTestUser(pool, String(17_000_000 + seq));
    await expect(
      withClient(pool, (client) => ensureReferralCode(client, { userId })),
    ).rejects.toMatchObject({ code: 'REFERRAL_CODE_POLICY_NOT_CONFIGURED' });
  });

  it('generates server-side code with pinned policy and is idempotent concurrently', async () => {
    await seedActivePolicy(pool);
    const userId = await createTestUser(pool, String(17_000_100 + seq));

    const first = await withClient(pool, (client) =>
      ensureReferralCode(client, { userId }),
    );
    expect(first.created).toBe(true);
    expect(first.policyVersion).toBe(1);
    expect(first.code.length).toBe(entropyOkLength());

    const second = await withClient(pool, (client) =>
      ensureReferralCode(client, { userId }),
    );
    expect(second.created).toBe(false);
    expect(second.code).toBe(first.code);
    expect(second.codeId).toBe(first.codeId);

    const [a, b] = await Promise.all([
      withClient(pool, (client) => ensureReferralCode(client, { userId })),
      withClient(pool, (client) => ensureReferralCode(client, { userId })),
    ]);
    expect(a.code).toBe(first.code);
    expect(b.code).toBe(first.code);

    const count = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM referral_codes WHERE user_id = $1`,
      [userId],
    );
    expect(count.rows[0]?.c).toBe('1');
  });

  it('summary counts are exact DB values with no fabricated rows', async () => {
    await seedActivePolicy(pool);
    const referrer = await createTestUser(pool, String(17_000_200 + seq));
    const invitee1 = await createTestUser(pool, String(17_000_201 + seq));
    const invitee2 = await createTestUser(pool, String(17_000_202 + seq));
    await withClient(pool, (client) => ensureReferralCode(client, { userId: referrer }));
    const codeId = (
      await pool.query<{ id: string }>(`SELECT id FROM referral_codes WHERE user_id = $1`, [
        referrer,
      ])
    ).rows[0]?.id;
    if (codeId === undefined) throw new Error('code missing');

    await pool.query(
      `INSERT INTO referral_rule_versions (
         rule_version, activation_account_age_seconds, activation_valid_ad_count,
         base_rate_bps, status, effective_from, reason
       ) VALUES (1, 0, 0, 123, 'ACTIVE', now() - interval '1 hour', 'step7-test')
       ON CONFLICT (rule_version) DO NOTHING`,
    );

    await pool.query(
      `INSERT INTO referral_edges (
         referrer_user_id, referred_user_id, code_id, state
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'PENDING')`,
      [referrer, invitee1, codeId],
    );
    await pool.query(
      `INSERT INTO referral_edges (
         referrer_user_id, referred_user_id, code_id, state,
         activation_rule_version, activated_at
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'ACTIVE', 1, now())`,
      [referrer, invitee2, codeId],
    );

    const summary = await withClient(pool, (client) =>
      readReferralSummary(client, { userId: referrer }),
    );
    expect(summary.invitedCount).toBe(2);
    expect(summary.activatedCount).toBe(1);
    expect(summary.referralCode).not.toBeNull();
  });
});
