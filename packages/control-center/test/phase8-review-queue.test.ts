import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import {
  REVIEW_CASE_TYPES,
  assertFutureDomainMutationAvailable,
  assignReviewCase,
  commentReviewCase,
  ensureReviewCase,
  escalateReviewCase,
  listReviewQueue,
  resolveReviewCaseAfterDomainSuccess,
} from '../src/index.js';
import {
  createOwnerAdmin,
  createPool,
  createTestUser,
  phase8DatabaseUrl,
  resetAndMigrate,
} from './harness.js';

const describePhase8 = phase8DatabaseUrl === '' ? describe.skip : describe;

describePhase8('phase8 review queue', () => {
  let pool: Pool;
  let adminId: string;

  beforeAll(async () => {
    await resetAndMigrate(phase8DatabaseUrl);
    pool = createPool(phase8DatabaseUrl);
    adminId = (await createOwnerAdmin(pool)).adminUserId;
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  it('supports all case types with one live case per resource', async () => {
    const { userId } = await createTestUser(pool, '920001');
    for (const caseType of REVIEW_CASE_TYPES) {
      const first = await ensureReviewCase(pool, {
        caseType,
        resourceType: 'user',
        resourceId: userId,
        summary: `${caseType} open`,
        adminUserId: adminId,
      });
      const second = await ensureReviewCase(pool, {
        caseType,
        resourceType: 'user',
        resourceId: userId,
        summary: 'dup',
        adminUserId: adminId,
      });
      expect(second.id).toBe(first.id);
    }
  });

  it('assigns, comments, escalates, and refuses false resolve', async () => {
    const { userId } = await createTestUser(pool, '920002');
    const review = await ensureReviewCase(pool, {
      caseType: 'FRAUD_REVIEW',
      resourceType: 'user',
      resourceId: userId,
      priority: 'HIGH',
      adminUserId: adminId,
    });
    await assignReviewCase(pool, {
      reviewCaseId: review.id,
      adminUserId: adminId,
      assigneeAdminId: adminId,
    });
    await commentReviewCase(pool, {
      reviewCaseId: review.id,
      adminUserId: adminId,
      note: 'internal note',
    });
    await escalateReviewCase(pool, {
      reviewCaseId: review.id,
      adminUserId: adminId,
      note: 'needs Owner',
    });
    await expect(
      resolveReviewCaseAfterDomainSuccess(pool, {
        reviewCaseId: review.id,
        adminUserId: adminId,
        disposition: 'RESOLVED',
        domainSucceeded: false,
      }),
    ).rejects.toMatchObject({ details: { reason: 'DOMAIN_NOT_SUCCEEDED' } });

    const events = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM review_case_events WHERE review_case_id = $1 ORDER BY created_at`,
      [review.id],
    );
    expect(events.rows.map((r) => r.event_type)).toEqual(
      expect.arrayContaining(['CREATED', 'ASSIGNED', 'COMMENTED', 'STATE_CHANGED']),
    );
    expect((await listReviewQueue(pool)).some((c) => c.id === review.id)).toBe(true);
  });

  it('marks future-domain mutation unavailable rather than simulating', () => {
    expect(() => assertFutureDomainMutationAvailable('fraud.mark_safe')).toThrow(/not available/i);
  });

  it('priority ordering does not auto-resolve', async () => {
    const a = await createTestUser(pool, '920003');
    const b = await createTestUser(pool, '920004');
    await ensureReviewCase(pool, {
      caseType: 'SUPPORT_ESCALATION',
      resourceType: 'user',
      resourceId: a.userId,
      priority: 'NORMAL',
    });
    await ensureReviewCase(pool, {
      caseType: 'SUPPORT_ESCALATION',
      resourceType: 'user',
      resourceId: b.userId,
      priority: 'URGENT',
    });
    const support = (await listReviewQueue(pool, { limit: 10 })).filter(
      (c) => c.caseType === 'SUPPORT_ESCALATION',
    );
    expect(support[0]?.priority).toBe('URGENT');
    expect(support.every((c) => c.state !== 'RESOLVED')).toBe(true);
  });
});
