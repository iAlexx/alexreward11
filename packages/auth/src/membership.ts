import type { Pool, PoolClient } from 'pg';

import { AuthDomainError } from './errors.js';
import { hashClaimCode } from './crypto.js';

export interface MembershipView {
  readonly active: boolean;
  readonly planCode: string | null;
  readonly status: string | null;
  readonly isFounder: boolean;
  readonly founderNumber: number | null;
  readonly source: string | null;
  readonly grantedAt: string | null;
  readonly claimedAt: string | null;
  readonly userStatus: string;
  readonly withdrawalStatus: string;
  readonly securityBypass: false;
  readonly entitlements: ReadonlyArray<{
    readonly code: string;
    readonly name: string;
    readonly valueType: string;
    readonly securityClassification: string;
    readonly description: string | null;
  }>;
}

export interface FounderClaimResult {
  readonly membershipId: string;
  readonly planCode: string;
  readonly founderNumber: number;
  readonly status: string;
  readonly claimedAt: string;
}

async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
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

export async function getMembershipView(pool: Pool, userId: string): Promise<MembershipView> {
  const user = await pool.query<{ status: string; withdrawal_status: string }>(
    `SELECT status, withdrawal_status FROM users WHERE id = $1`,
    [userId],
  );
  const userRow = user.rows[0];
  if (userRow === undefined) {
    throw new AuthDomainError('UNAUTHENTICATED', 'Authentication required');
  }

  const membership = await pool.query<{
    id: string;
    status: string;
    source: string;
    founder_number: number | null;
    granted_at: Date;
    claimed_at: Date | null;
    plan_code: string;
  }>(
    `SELECT um.id, um.status, um.source, um.founder_number, um.granted_at, um.claimed_at, mp.code AS plan_code
     FROM user_memberships um
     INNER JOIN membership_plans mp ON mp.id = um.membership_plan_id
     WHERE um.user_id = $1 AND um.status = 'ACTIVE'
     ORDER BY CASE WHEN mp.code = 'FOUNDER_LIFETIME' THEN 0 ELSE 1 END, um.granted_at DESC
     LIMIT 1`,
    [userId],
  );
  const row = membership.rows[0];

  // Non-sensitive vocabulary only. FINANCIAL entitlement values are never returned here;
  // benefit resolution/execution belongs to later phases.
  const entitlements =
    row === undefined
      ? {
          rows: [] as Array<{
            code: string;
            name: string;
            value_type: string;
            security_classification: string;
            description: string | null;
          }>,
        }
      : await pool.query<{
          code: string;
          name: string;
          value_type: string;
          security_classification: string;
          description: string | null;
        }>(
          `SELECT e.code, e.name, e.value_type, e.security_classification, e.description
           FROM entitlements e
           WHERE e.security_classification IN ('PUBLIC', 'INTERNAL')
           ORDER BY e.code`,
        );

  return {
    active: row !== undefined,
    planCode: row?.plan_code ?? null,
    status: row?.status ?? null,
    isFounder: row?.plan_code === 'FOUNDER_LIFETIME',
    founderNumber: row?.founder_number ?? null,
    source: row?.source ?? null,
    grantedAt: row?.granted_at.toISOString() ?? null,
    claimedAt: row?.claimed_at?.toISOString() ?? null,
    userStatus: userRow.status,
    withdrawalStatus: userRow.withdrawal_status,
    securityBypass: false,
    entitlements: entitlements.rows.map((item) => ({
      code: item.code,
      name: item.name,
      valueType: item.value_type,
      securityClassification: item.security_classification,
      description: item.description,
    })),
  };
}

/**
 * Atomically consumes an Owner-issued Founder claim code for the authenticated user.
 * Creates zero ledger postings and issues zero money.
 */
export async function claimFounderCode(
  pool: Pool,
  input: {
    readonly userId: string;
    readonly rawClaimCode: string;
    readonly ipHash?: string | null;
    readonly userAgentSummary?: string | null;
    readonly traceId?: string | null;
  },
): Promise<FounderClaimResult> {
  const code = input.rawClaimCode.trim();
  if (code.length < 8 || code.length > 128) {
    throw new AuthDomainError('CLAIM_REJECTED', 'Claim could not be completed');
  }
  const codeHash = hashClaimCode(code);

  return withTransaction(pool, async (client) => {
    const user = await client.query<{ status: string }>(
      `SELECT status FROM users WHERE id = $1 FOR UPDATE`,
      [input.userId],
    );
    const userRow = user.rows[0];
    if (userRow === undefined) {
      throw new AuthDomainError('UNAUTHENTICATED', 'Authentication required');
    }
    if (
      userRow.status === 'BANNED' ||
      userRow.status === 'DELETED_ANONYMIZED' ||
      userRow.status === 'SUSPENDED'
    ) {
      throw new AuthDomainError('FORBIDDEN', 'Claim could not be completed', {
        details: { reason: 'USER_STATUS_BLOCKED' },
      });
    }

    const claim = await client.query<{
      id: string;
      membership_plan_id: string;
      founder_number_reserved: number | null;
      expires_at: Date | null;
      consumed_at: Date | null;
      plan_code: string;
    }>(
      `SELECT c.id, c.membership_plan_id, c.founder_number_reserved, c.expires_at, c.consumed_at,
              p.code AS plan_code
       FROM membership_claim_codes c
       INNER JOIN membership_plans p ON p.id = c.membership_plan_id
       WHERE c.code_hash = $1
       FOR UPDATE OF c`,
      [codeHash],
    );
    const claimRow = claim.rows[0];
    // Generalized rejection: do not reveal whether the code exists.
    if (claimRow === undefined || claimRow.plan_code !== 'FOUNDER_LIFETIME') {
      throw new AuthDomainError('CLAIM_REJECTED', 'Claim could not be completed', {
        details: { reason: 'INVALID_OR_UNKNOWN' },
      });
    }
    if (claimRow.consumed_at !== null) {
      throw new AuthDomainError('CLAIM_REJECTED', 'Claim could not be completed', {
        details: { reason: 'ALREADY_CONSUMED' },
      });
    }
    if (claimRow.expires_at !== null && claimRow.expires_at.getTime() <= Date.now()) {
      throw new AuthDomainError('CLAIM_REJECTED', 'Claim could not be completed', {
        details: { reason: 'EXPIRED' },
      });
    }

    const existingFounder = await client.query(
      `SELECT um.id
       FROM user_memberships um
       INNER JOIN membership_plans mp ON mp.id = um.membership_plan_id
       WHERE um.user_id = $1 AND mp.code = 'FOUNDER_LIFETIME' AND um.status = 'ACTIVE'`,
      [input.userId],
    );
    if ((existingFounder.rowCount ?? 0) > 0) {
      throw new AuthDomainError('CLAIM_REJECTED', 'Claim could not be completed', {
        details: { reason: 'ALREADY_FOUNDER' },
      });
    }

    const priorClaim = await client.query(
      `SELECT id FROM membership_claim_codes WHERE consumed_by_user_id = $1`,
      [input.userId],
    );
    if ((priorClaim.rowCount ?? 0) > 0) {
      throw new AuthDomainError('CLAIM_REJECTED', 'Claim could not be completed', {
        details: { reason: 'USER_ALREADY_CLAIMED' },
      });
    }

    let founderNumber = claimRow.founder_number_reserved;
    if (founderNumber === null) {
      const seq = await client.query<{ nextval: string }>(
        `SELECT nextval('founder_number_seq')::text AS nextval`,
      );
      const next = seq.rows[0]?.nextval;
      if (next === undefined) {
        throw new AuthDomainError('INTERNAL', 'Claim could not be completed');
      }
      founderNumber = Number(next);
    }

    const membership = await client.query<{
      id: string;
      status: string;
      founder_number: number;
      claimed_at: Date;
    }>(
      `INSERT INTO user_memberships (
         user_id, membership_plan_id, founder_number, status, source, claimed_at
       ) VALUES ($1, $2, $3, 'ACTIVE', 'CLAIM_CODE', now())
       RETURNING id, status, founder_number, claimed_at`,
      [input.userId, claimRow.membership_plan_id, founderNumber],
    );
    const membershipRow = membership.rows[0];
    if (membershipRow === undefined) {
      throw new AuthDomainError('INTERNAL', 'Claim could not be completed');
    }

    const consume = await client.query(
      `UPDATE membership_claim_codes
       SET consumed_at = now(),
           consumed_by_user_id = $2,
           granted_membership_id = $3
       WHERE id = $1 AND consumed_at IS NULL
       RETURNING id`,
      [claimRow.id, input.userId, membershipRow.id],
    );
    if (consume.rowCount !== 1) {
      throw new AuthDomainError('CLAIM_REJECTED', 'Claim could not be completed', {
        details: { reason: 'RACE_LOST' },
      });
    }

    await client.query(
      `INSERT INTO membership_grant_events (
         user_membership_id, event_type, to_user_id, claim_code_id, actor_source, reason, after_snapshot
       ) VALUES ($1, 'CLAIMED', $2, $3, 'API', $4, $5::jsonb)`,
      [
        membershipRow.id,
        input.userId,
        claimRow.id,
        'Founder claim code consumed',
        JSON.stringify({
          planCode: 'FOUNDER_LIFETIME',
          founderNumber: membershipRow.founder_number,
          source: 'CLAIM_CODE',
          // Never include raw claim code.
        }),
      ],
    );

    await client.query(
      `INSERT INTO audit_logs (
         admin_user_id, actor_type, action_type, resource_type, resource_id,
         after_snapshot, reason, source, ip_hash, user_agent_summary, trace_id
       ) VALUES (
         NULL, 'USER', 'membership.founder_claim', 'user_membership', $1,
         $2::jsonb, $3, 'API', $4, $5, $6
       )`,
      [
        membershipRow.id,
        JSON.stringify({
          userId: input.userId,
          planCode: 'FOUNDER_LIFETIME',
          founderNumber: membershipRow.founder_number,
          claimCodeId: claimRow.id,
        }),
        'Founder membership claimed',
        input.ipHash ?? null,
        input.userAgentSummary ?? null,
        input.traceId ?? null,
      ],
    );

    // Explicit zero-money invariant: no ledger tables are touched in this transaction.
    return {
      membershipId: membershipRow.id,
      planCode: 'FOUNDER_LIFETIME',
      founderNumber: membershipRow.founder_number,
      status: membershipRow.status,
      claimedAt: membershipRow.claimed_at.toISOString(),
    };
  });
}
