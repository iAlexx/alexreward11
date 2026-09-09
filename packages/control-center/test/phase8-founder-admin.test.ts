import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import {
  claimFounderCode,
  getFounderHistory,
  grantFounderMembership,
  issueFounderClaimCode,
  reassignFounderMembership,
  searchFounderMember,
} from '@alex-rewards/auth';

import {
  assertLedgerUntouchedByFounderGrant,
  createOwnerAdmin,
  createPool,
  createTestUser,
  phase8DatabaseUrl,
  resetAndMigrate,
} from './harness.js';

const describePhase8 = phase8DatabaseUrl === '' ? describe.skip : describe;

describePhase8('phase8 founder admin', () => {
  let pool: Pool;
  let adminId: string;

  beforeAll(async () => {
    await resetAndMigrate(phase8DatabaseUrl);
    pool = createPool(phase8DatabaseUrl);
    const owner = await createOwnerAdmin(pool);
    adminId = owner.adminUserId;
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  it('grants FOUNDER_LIFETIME with OWNER_GRANT, 50 USD catalogue, zero ledger', async () => {
    const { userId } = await createTestUser(pool, '910001');
    const granted = await grantFounderMembership(pool, {
      adminUserId: adminId,
      userId,
      reason: 'verified pre-launch payment',
      paymentReferenceRedacted: 'ref-****-42',
      idempotencyKey: 'grant-1',
      actorSource: 'TELEGRAM',
    });
    expect(granted.planCode).toBe('FOUNDER_LIFETIME');
    expect(granted.source).toBe('OWNER_GRANT');
    expect(granted.founderNumber).toBeGreaterThan(0);

    const mem = await pool.query(
      `SELECT purchase_currency, purchase_decimals, purchase_amount_atomic::text AS amt, source
       FROM user_memberships WHERE id = $1`,
      [granted.membershipId],
    );
    expect(mem.rows[0]).toMatchObject({
      purchase_currency: 'USD',
      purchase_decimals: 2,
      amt: '5000',
      source: 'OWNER_GRANT',
    });

    await assertLedgerUntouchedByFounderGrant(pool);

    const recovered = await grantFounderMembership(pool, {
      adminUserId: adminId,
      userId,
      reason: 'verified pre-launch payment',
      paymentReferenceRedacted: 'ref-****-42',
      idempotencyKey: 'grant-1',
      actorSource: 'TELEGRAM',
    });
    expect(recovered.recovered).toBe(true);
    expect(recovered.membershipId).toBe(granted.membershipId);

    await expect(
      grantFounderMembership(pool, {
        adminUserId: adminId,
        userId,
        reason: 'second conflicting grant',
        paymentReferenceRedacted: 'other',
        idempotencyKey: 'grant-2',
      }),
    ).rejects.toMatchObject({ details: { reason: 'ALREADY_FOUNDER' } });
  });

  it('issues claim code with hash-at-rest; raw absent from audit', async () => {
    const issued = await issueFounderClaimCode(pool, {
      adminUserId: adminId,
      issuedForReference: 'batch-A',
    });
    expect(issued.rawCode.length).toBeGreaterThanOrEqual(16);
    const row = await pool.query<{ code_hash: string }>(
      `SELECT code_hash FROM membership_claim_codes WHERE id = $1`,
      [issued.claimCodeId],
    );
    expect(row.rows[0]!.code_hash).not.toBe(issued.rawCode);
    const audit = await pool.query<{ after_snapshot: unknown }>(
      `SELECT after_snapshot FROM audit_logs
       WHERE action_type = 'membership.founder_claim_code_issue'
       ORDER BY created_at DESC LIMIT 1`,
    );
    expect(JSON.stringify(audit.rows[0]!.after_snapshot)).not.toContain(issued.rawCode);
  });

  it('grant vs claim race yields at most one Founder', async () => {
    const { userId } = await createTestUser(pool, '910002');
    const code = await issueFounderClaimCode(pool, { adminUserId: adminId });
    const results = await Promise.allSettled([
      grantFounderMembership(pool, {
        adminUserId: adminId,
        userId,
        reason: 'race grant',
        paymentReferenceRedacted: 'race-ref',
        idempotencyKey: `race-g-${userId}`,
      }),
      claimFounderCode(pool, { userId, rawClaimCode: code.rawCode }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(1);
    const count = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM user_memberships
       WHERE user_id = $1 AND status = 'ACTIVE'`,
      [userId],
    );
    expect(count.rows[0]!.c).toBe(1);
  });

  it('100 concurrent grants for same user → one membership', async () => {
    const { userId } = await createTestUser(pool, '910003');
    const settled = await Promise.allSettled(
      Array.from({ length: 100 }, (_, i) =>
        grantFounderMembership(pool, {
          adminUserId: adminId,
          userId,
          reason: 'burst',
          paymentReferenceRedacted: 'burst-ref',
          idempotencyKey: `burst-${i}`,
        }),
      ),
    );
    expect(settled.filter((r) => r.status === 'fulfilled').length).toBe(1);
    const count = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM user_memberships WHERE user_id = $1 AND status = 'ACTIVE'`,
      [userId],
    );
    expect(count.rows[0]!.c).toBe(1);
  });

  it('search and history are read-only', async () => {
    const { userId } = await createTestUser(pool, '910004');
    const granted = await grantFounderMembership(pool, {
      adminUserId: adminId,
      userId,
      reason: 'search fixture',
      paymentReferenceRedacted: 'pay-****',
      idempotencyKey: 'search-1',
    });
    const hits = await searchFounderMember(pool, { founderNumber: granted.founderNumber });
    expect(hits[0]?.founderNumber).toBe(granted.founderNumber);
    const history = await getFounderHistory(pool, { founderNumber: granted.founderNumber });
    expect(history?.events.length).toBeGreaterThan(0);
  });

  it('reassignment mutation is unavailable', async () => {
    await expect(reassignFounderMembership()).rejects.toMatchObject({
      details: { reason: 'REASSIGNMENT_UNAVAILABLE' },
    });
  });
});
