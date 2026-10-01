/**
 * P19-SEC-001 — MembershipsAdminController.issueClaimCode confirmation proofs (DB).
 * Disposable DB only: PHASE19_SECURITY_DATABASE_URL / OWNER_ADMIN_AUTH_DATABASE_URL /
 * PHASE19_CLAIM_CODE_TESTS=1 + DATABASE_URL.
 */
import { createHash, randomUUID } from 'node:crypto';

import {
  assertConnectedDestructiveTestDatabase,
  assertSafeDestructiveTestDatabaseUrl,
  migrateDatabase,
} from '@alex-rewards/db';
import {
  confirmAdminWebConfirmation,
  prepareAdminWebConfirmation,
  type VerifiedAdminSession,
} from '@alex-rewards/auth';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MembershipsAdminController } from '../src/admin/memberships-admin.controller.js';

const dbUrl =
  process.env.PHASE19_SECURITY_DATABASE_URL ??
  process.env.OWNER_ADMIN_AUTH_DATABASE_URL ??
  (process.env.PHASE19_CLAIM_CODE_TESTS === '1' ? (process.env.DATABASE_URL ?? '') : '');

const BEARER = 'phase19-claim-code-admin-test';
const EXPECTED_VERSION = '1';

const apiConfig = {
  DEPLOYMENT_ENV: 'local',
  CORS_ORIGINS: ['http://localhost:3001'],
  ADMIN_WEBAUTHN_ORIGIN: 'http://localhost:3001',
} as never;

function bearerRequest(): { headers: { authorization: string } } {
  return { headers: { authorization: `Bearer ${BEARER}` } };
}

async function resetAndMigrate(url: string): Promise<void> {
  assertSafeDestructiveTestDatabaseUrl(url);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await assertConnectedDestructiveTestDatabase(client);
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query('GRANT ALL ON SCHEMA public TO PUBLIC');
  } finally {
    await client.end();
  }
  await migrateDatabase(url);
}

type ClaimPayload = {
  readonly reason: string;
  readonly expiresAt: string | null;
  readonly issuedForReference: string | null;
  readonly reserveFounderNumber: boolean;
};

describe.skipIf(dbUrl === '')('P19-SEC-001 claim-code confirmation (DB)', () => {
  let pool!: Pool;
  let controller: MembershipsAdminController;
  let session: VerifiedAdminSession;

  beforeAll(async () => {
    await resetAndMigrate(dbUrl);
    pool = new Pool({ connectionString: dbUrl, max: 8 });
    controller = new MembershipsAdminController(pool, apiConfig);

    const admin = await pool.query<{ id: string }>(
      `INSERT INTO admin_users (email, display_name, status)
       VALUES ($1, 'Phase19 Claim Code Admin', 'ACTIVE')
       RETURNING id`,
      [`phase19-claim-${randomUUID()}@example.invalid`],
    );
    const adminUserId = admin.rows[0]!.id;
    const role = await pool.query<{ id: string }>(
      `SELECT id FROM admin_roles WHERE code = 'OWNER' AND status = 'ACTIVE'`,
    );
    await pool.query(
      `INSERT INTO admin_role_bindings (admin_user_id, role_id)
       VALUES ($1::uuid, $2::uuid)
       ON CONFLICT DO NOTHING`,
      [adminUserId, role.rows[0]!.id],
    );

    const sessionId = randomUUID();
    const tokenHash = createHash('sha256').update(BEARER).digest('hex');
    await pool.query(
      `INSERT INTO admin_sessions (
         id, admin_user_id, session_token_hash, idle_expires_at, absolute_expires_at,
         reauthenticated_at
       ) VALUES (
         $1::uuid, $2::uuid, $3, now() + interval '1 hour', now() + interval '8 hours',
         now()
       )`,
      [sessionId, adminUserId, tokenHash],
    );

    session = {
      adminUserId,
      email: 'phase19-claim-code@example.invalid',
      displayName: 'Phase19 Claim Code Admin',
      sessionId,
      reauthenticatedAt: new Date().toISOString(),
      idleExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      absoluteExpiresAt: new Date(Date.now() + 8 * 3_600_000).toISOString(),
      roles: ['OWNER'],
    };
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
  });

  async function prepareConfirm(
    payload: ClaimPayload,
    actionType = 'memberships.founder_claim_code_issue',
    ttlMs?: number,
  ): Promise<string> {
    const prepared = await prepareAdminWebConfirmation(pool, {
      session,
      actionType,
      resourceType: 'membership_plan',
      resourceId: 'FOUNDER_LIFETIME',
      expectedVersion: EXPECTED_VERSION,
      payload,
      ...(ttlMs !== undefined ? { ttlMs } : {}),
    });
    await confirmAdminWebConfirmation(pool, {
      session,
      confirmationId: prepared.confirmationId,
      confirmationPhrase: prepared.confirmationPhrase,
    });
    return prepared.confirmationId;
  }

  type IssueBody = {
    readonly reason: string;
    readonly expectedVersion: string;
    readonly confirmationId: string;
    readonly expiresAt?: string;
    readonly issuedForReference?: string;
    readonly reserveFounderNumber?: boolean;
  };

  function issueBody(
    confirmationId: string,
    overrides: Partial<{
      reason: string;
      expiresAt: string;
      issuedForReference: string;
      reserveFounderNumber: boolean;
    }> = {},
  ): IssueBody {
    const body: IssueBody = {
      reason: overrides.reason ?? 'phase19 claim-code ceremony',
      expectedVersion: EXPECTED_VERSION,
      confirmationId,
    };
    return {
      ...body,
      ...(overrides.expiresAt !== undefined ? { expiresAt: overrides.expiresAt } : {}),
      ...(overrides.issuedForReference !== undefined
        ? { issuedForReference: overrides.issuedForReference }
        : {}),
      ...(overrides.reserveFounderNumber !== undefined
        ? { reserveFounderNumber: overrides.reserveFounderNumber }
        : {}),
    };
  }

  it('1. missing confirmationId => refuse', async () => {
    await expect(
      controller.issueClaimCode(bearerRequest() as never, session, {
        reason: 'phase19 missing confirmation',
        expectedVersion: EXPECTED_VERSION,
      } as never),
    ).rejects.toThrow();
  });

  it('2. unknown confirmationId => refuse', async () => {
    await expect(
      controller.issueClaimCode(bearerRequest() as never, session, issueBody(randomUUID())),
    ).rejects.toThrow();
  });

  it('3. expired confirmation => refuse on consume', async () => {
    const payload: ClaimPayload = {
      reason: 'phase19 expired confirm',
      expiresAt: null,
      issuedForReference: null,
      reserveFounderNumber: false,
    };
    // Short TTL + wait — CHECK constraint forbids backdating expires_at below issued_at.
    const confirmationId = await prepareConfirm(payload, 'memberships.founder_claim_code_issue', 50);
    await new Promise((r) => setTimeout(r, 80));
    await expect(
      controller.issueClaimCode(
        bearerRequest() as never,
        session,
        issueBody(confirmationId, { reason: payload.reason }),
      ),
    ).rejects.toThrow();
  });

  it('4. prepared-only (not confirmed) => refuse', async () => {
    const payload: ClaimPayload = {
      reason: 'phase19 prepared only',
      expiresAt: null,
      issuedForReference: null,
      reserveFounderNumber: false,
    };
    const prepared = await prepareAdminWebConfirmation(pool, {
      session,
      actionType: 'memberships.founder_claim_code_issue',
      resourceType: 'membership_plan',
      resourceId: 'FOUNDER_LIFETIME',
      expectedVersion: EXPECTED_VERSION,
      payload,
    });
    await expect(
      controller.issueClaimCode(
        bearerRequest() as never,
        session,
        issueBody(prepared.confirmationId, { reason: payload.reason }),
      ),
    ).rejects.toThrow();
  });

  it('5-6. exact confirmed one-time success + replay refuse', async () => {
    const reason = 'phase19 claim one-time success';
    const payload: ClaimPayload = {
      reason,
      expiresAt: null,
      issuedForReference: null,
      reserveFounderNumber: false,
    };
    const confirmationId = await prepareConfirm(payload);
    const issued = await controller.issueClaimCode(
      bearerRequest() as never,
      session,
      issueBody(confirmationId, { reason }),
    );
    expect(issued.plaintextCode).toBeTruthy();
    expect(typeof issued.plaintextCode).toBe('string');
    expect(issued.plaintextCode.length).toBeGreaterThan(8);
    expect(issued.claimCodeId).toBeTruthy();

    await expect(
      controller.issueClaimCode(
        bearerRequest() as never,
        session,
        issueBody(confirmationId, { reason }),
      ),
    ).rejects.toThrow();
  });

  it('7. wrong action confirmation => refuse', async () => {
    const reason = 'phase19 wrong action';
    const payload: ClaimPayload = {
      reason,
      expiresAt: null,
      issuedForReference: null,
      reserveFounderNumber: false,
    };
    const confirmationId = await prepareConfirm(payload, 'memberships.founder_grant');
    await expect(
      controller.issueClaimCode(
        bearerRequest() as never,
        session,
        issueBody(confirmationId, { reason }),
      ),
    ).rejects.toThrow();
  });

  it('8. changed expiresAt vs confirmation payload => refuse', async () => {
    const reason = 'phase19 expiresAt bind';
    const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const payload: ClaimPayload = {
      reason,
      expiresAt,
      issuedForReference: null,
      reserveFounderNumber: false,
    };
    const confirmationId = await prepareConfirm(payload);
    const otherExpiry = new Date(Date.now() + 14 * 86_400_000).toISOString();
    await expect(
      controller.issueClaimCode(
        bearerRequest() as never,
        session,
        issueBody(confirmationId, { reason, expiresAt: otherExpiry }),
      ),
    ).rejects.toThrow();
  });

  it('9. changed issuedForReference => refuse', async () => {
    const reason = 'phase19 ref bind';
    const payload: ClaimPayload = {
      reason,
      expiresAt: null,
      issuedForReference: 'ref-original',
      reserveFounderNumber: false,
    };
    const confirmationId = await prepareConfirm(payload);
    await expect(
      controller.issueClaimCode(
        bearerRequest() as never,
        session,
        issueBody(confirmationId, { reason, issuedForReference: 'ref-changed' }),
      ),
    ).rejects.toThrow();
  });

  it('10. changed reserveFounderNumber => refuse', async () => {
    const reason = 'phase19 reserve bind';
    const payload: ClaimPayload = {
      reason,
      expiresAt: null,
      issuedForReference: null,
      reserveFounderNumber: false,
    };
    const confirmationId = await prepareConfirm(payload);
    await expect(
      controller.issueClaimCode(
        bearerRequest() as never,
        session,
        issueBody(confirmationId, { reason, reserveFounderNumber: true }),
      ),
    ).rejects.toThrow();
  });

  it('11. changed reason => refuse', async () => {
    const payload: ClaimPayload = {
      reason: 'phase19 reason original',
      expiresAt: null,
      issuedForReference: null,
      reserveFounderNumber: false,
    };
    const confirmationId = await prepareConfirm(payload);
    await expect(
      controller.issueClaimCode(
        bearerRequest() as never,
        session,
        issueBody(confirmationId, { reason: 'phase19 reason changed' }),
      ),
    ).rejects.toThrow();
  });

  it('12-15. success stores hash-only, audit clean, zero ledger/rewards', async () => {
    const reason = 'phase19 claim hash-only proof';
    const issuedForReference = 'ops-ticket-p19';
    const payload: ClaimPayload = {
      reason,
      expiresAt: null,
      issuedForReference,
      reserveFounderNumber: false,
    };
    const beforeCodes = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM membership_claim_codes`,
    );
    const beforeRewards = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM reward_events`,
    );
    const beforeLedger = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM ledger_transactions`,
    );

    const confirmationId = await prepareConfirm(payload);
    const issued = await controller.issueClaimCode(
      bearerRequest() as never,
      session,
      issueBody(confirmationId, { reason, issuedForReference }),
    );
    expect(issued.plaintextCode).toBeTruthy();
    const plaintext = issued.plaintextCode;

    const afterCodes = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM membership_claim_codes`,
    );
    expect(afterCodes.rows[0]!.c).toBe(beforeCodes.rows[0]!.c + 1);

    const row = await pool.query(
      `SELECT id, code_hash, membership_plan_id, founder_number_reserved,
              issued_for_reference, expires_at, consumed_at, consumed_by_user_id,
              granted_membership_id, created_by_admin_id, created_at, updated_at
       FROM membership_claim_codes WHERE id = $1::uuid`,
      [issued.claimCodeId],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]!.code_hash).toBeTruthy();
    const rowJson = JSON.stringify(row.rows[0]);
    expect(rowJson.includes(plaintext)).toBe(false);

    const audits = await pool.query(
      `SELECT action_type, reason, after_snapshot
       FROM audit_logs
       WHERE action_type = 'membership.founder_claim_code_issue'
         AND resource_id = $1::uuid`,
      [issued.claimCodeId],
    );
    expect(audits.rows.length).toBeGreaterThan(0);
    for (const audit of audits.rows) {
      expect(JSON.stringify(audit).includes(plaintext)).toBe(false);
    }

    const afterRewards = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM reward_events`,
    );
    const afterLedger = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM ledger_transactions`,
    );
    expect(afterRewards.rows[0]!.c).toBe(beforeRewards.rows[0]!.c);
    expect(afterLedger.rows[0]!.c).toBe(beforeLedger.rows[0]!.c);
    expect(afterRewards.rows[0]!.c).toBe(0);
    expect(afterLedger.rows[0]!.c).toBe(0);
  });
});
