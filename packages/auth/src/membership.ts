import type { Pool, PoolClient } from 'pg';

import { AuthDomainError } from './errors.js';
import { generateClaimCode, hashClaimCode } from './crypto.js';

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
    membership_plan_id: string;
    status: string;
    source: string;
    founder_number: number | null;
    granted_at: Date;
    claimed_at: Date | null;
    plan_code: string;
  }>(
    `SELECT um.id, um.membership_plan_id, um.status, um.source, um.founder_number, um.granted_at,
            um.claimed_at, mp.code AS plan_code
     FROM user_memberships um
     INNER JOIN membership_plans mp ON mp.id = um.membership_plan_id
     WHERE um.user_id = $1 AND um.status = 'ACTIVE'
     ORDER BY CASE WHEN mp.code = 'FOUNDER_LIFETIME' THEN 0 ELSE 1 END, um.granted_at DESC
     LIMIT 1`,
    [userId],
  );
  const row = membership.rows[0];

  // Only NON-FINANCIAL entitlements that are actively mapped to this membership's plan
  // through approved, currently-effective plan bindings and rule versions.
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
           FROM membership_plan_entitlements mpe
           INNER JOIN membership_benefit_rule_versions mbrv
             ON mbrv.id = mpe.rule_version_id
           INNER JOIN entitlements e
             ON e.id = mpe.entitlement_id
           WHERE mpe.membership_plan_id = $1
             AND mpe.status = 'ACTIVE'
             AND mpe.valid_from <= now()
             AND (mpe.valid_to IS NULL OR mpe.valid_to > now())
             AND mbrv.status = 'ACTIVE'
             AND mbrv.effective_from <= now()
             AND (mbrv.effective_to IS NULL OR mbrv.effective_to > now())
             AND e.security_classification IN ('PUBLIC', 'INTERNAL')
           ORDER BY e.code`,
          // Note: rule version scalar values are intentionally not selected.
          [row.membership_plan_id],
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

export interface FounderGrantResult {
  readonly membershipId: string;
  readonly planCode: 'FOUNDER_LIFETIME';
  readonly founderNumber: number;
  readonly status: string;
  readonly source: 'OWNER_GRANT';
  readonly grantedAt: string;
  readonly recovered: boolean;
}

/**
 * Audited Owner direct FOUNDER_LIFETIME grant for a verified pre-launch/manual purchaser.
 * Zero ledger postings. Zero reward events. Zero balance mutation.
 */
export async function grantFounderMembership(
  pool: Pool,
  input: {
    readonly adminUserId: string;
    readonly userId: string;
    readonly reason: string;
    readonly paymentReferenceRedacted: string;
    readonly idempotencyKey?: string | null;
    readonly actorSource?: 'TELEGRAM' | 'API' | 'WEB';
    readonly traceId?: string | null;
  },
): Promise<FounderGrantResult> {
  const reason = input.reason.trim();
  const paymentRef = input.paymentReferenceRedacted.trim();
  if (reason.length < 3 || reason.length > 500) {
    throw new AuthDomainError('VALIDATION', 'Grant reason is required');
  }
  if (paymentRef.length < 1 || paymentRef.length > 200) {
    throw new AuthDomainError('VALIDATION', 'Payment reference (redacted) is required');
  }
  if (/claim|secret|token|password|initdata/i.test(paymentRef)) {
    throw new AuthDomainError('VALIDATION', 'Payment reference rejected');
  }
  const actorSource = input.actorSource ?? 'TELEGRAM';
  const idempotencyKey = input.idempotencyKey?.trim() || null;

  return withTransaction(pool, async (client) => {
    if (idempotencyKey !== null) {
      const prior = await client.query<{
        resource_id: string | null;
        after_snapshot: { founderNumber?: number; membershipId?: string } | null;
      }>(
        `SELECT resource_id, after_snapshot
         FROM audit_logs
         WHERE admin_user_id = $1::uuid
           AND action_type = 'membership.founder_owner_grant'
           AND reason = $2
         ORDER BY created_at ASC
         LIMIT 1`,
        [input.adminUserId, `idempotency:${idempotencyKey}|${reason}`],
      );
      const priorRow = prior.rows[0];
      if (priorRow?.resource_id !== undefined && priorRow.resource_id !== null) {
        const existing = await client.query<{
          id: string;
          status: string;
          founder_number: number;
          granted_at: Date;
        }>(
          `SELECT id, status, founder_number, granted_at
           FROM user_memberships WHERE id = $1::uuid`,
          [priorRow.resource_id],
        );
        const row = existing.rows[0];
        if (row !== undefined) {
          return {
            membershipId: row.id,
            planCode: 'FOUNDER_LIFETIME',
            founderNumber: row.founder_number,
            status: row.status,
            source: 'OWNER_GRANT',
            grantedAt: row.granted_at.toISOString(),
            recovered: true,
          };
        }
      }
    }

    const admin = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM admin_users WHERE id = $1::uuid FOR SHARE`,
      [input.adminUserId],
    );
    if (admin.rows[0]?.status !== 'ACTIVE') {
      throw new AuthDomainError('FORBIDDEN', 'Grant could not be completed');
    }

    const user = await client.query<{ status: string }>(
      `SELECT status FROM users WHERE id = $1::uuid FOR UPDATE`,
      [input.userId],
    );
    const userRow = user.rows[0];
    if (userRow === undefined) {
      throw new AuthDomainError('VALIDATION', 'Target user not found');
    }
    if (
      userRow.status === 'BANNED' ||
      userRow.status === 'DELETED_ANONYMIZED' ||
      userRow.status === 'SUSPENDED'
    ) {
      throw new AuthDomainError('FORBIDDEN', 'Grant could not be completed', {
        details: { reason: 'USER_STATUS_BLOCKED' },
      });
    }

    const plan = await client.query<{
      id: string;
      status: string;
      price_currency: string | null;
      price_decimals: number | null;
      price_atomic: string | null;
    }>(
      `SELECT id, status, price_currency, price_decimals, price_atomic::text AS price_atomic
       FROM membership_plans
       WHERE code = 'FOUNDER_LIFETIME'
       FOR SHARE`,
    );
    const planRow = plan.rows[0];
    if (planRow === undefined || planRow.status !== 'ACTIVE') {
      throw new AuthDomainError('VALIDATION', 'FOUNDER_LIFETIME plan is not active');
    }
    if (
      planRow.price_currency !== 'USD' ||
      planRow.price_decimals !== 2 ||
      planRow.price_atomic !== '5000'
    ) {
      throw new AuthDomainError('INTERNAL', 'Founder catalogue price mismatch');
    }

    const existingFounder = await client.query<{
      id: string;
      status: string;
      founder_number: number;
      granted_at: Date;
      source: string;
    }>(
      `SELECT um.id, um.status, um.founder_number, um.granted_at, um.source
       FROM user_memberships um
       WHERE um.user_id = $1::uuid
         AND um.membership_plan_id = $2::uuid
         AND um.status = 'ACTIVE'
       FOR UPDATE`,
      [input.userId, planRow.id],
    );
    if (existingFounder.rows[0] !== undefined) {
      throw new AuthDomainError('CLAIM_REJECTED', 'User already has active Founder membership', {
        details: { reason: 'ALREADY_FOUNDER' },
      });
    }

    const seq = await client.query<{ nextval: string }>(
      `SELECT nextval('founder_number_seq')::text AS nextval`,
    );
    const next = seq.rows[0]?.nextval;
    if (next === undefined) {
      throw new AuthDomainError('INTERNAL', 'Founder number allocation failed');
    }
    const founderNumber = Number(next);

    const membership = await client.query<{
      id: string;
      status: string;
      founder_number: number;
      granted_at: Date;
    }>(
      `INSERT INTO user_memberships (
         user_id, membership_plan_id, founder_number, status, source,
         purchase_currency, purchase_decimals, purchase_amount_atomic,
         payment_reference_redacted, created_by_admin_id, granted_at
       ) VALUES (
         $1::uuid, $2::uuid, $3, 'ACTIVE', 'OWNER_GRANT',
         $4, $5, $6::bigint, $7, $8::uuid, now()
       )
       RETURNING id, status, founder_number, granted_at`,
      [
        input.userId,
        planRow.id,
        founderNumber,
        planRow.price_currency,
        planRow.price_decimals,
        planRow.price_atomic,
        paymentRef,
        input.adminUserId,
      ],
    );
    const membershipRow = membership.rows[0];
    if (membershipRow === undefined) {
      throw new AuthDomainError('INTERNAL', 'Founder grant insert failed');
    }

    const auditReason =
      idempotencyKey !== null ? `idempotency:${idempotencyKey}|${reason}` : reason;

    const audit = await client.query<{ id: string }>(
      `INSERT INTO audit_logs (
         admin_user_id, actor_type, action_type, resource_type, resource_id,
         after_snapshot, reason, source, trace_id
       ) VALUES (
         $1::uuid, 'ADMIN', 'membership.founder_owner_grant', 'user_membership', $2::uuid,
         $3::jsonb, $4, $5::actor_source, $6
       )
       RETURNING id`,
      [
        input.adminUserId,
        membershipRow.id,
        JSON.stringify({
          userId: input.userId,
          planCode: 'FOUNDER_LIFETIME',
          founderNumber: membershipRow.founder_number,
          source: 'OWNER_GRANT',
          purchaseCurrency: planRow.price_currency,
          purchaseDecimals: planRow.price_decimals,
          purchaseAmountAtomic: planRow.price_atomic,
          paymentReferenceRedacted: paymentRef,
          membershipId: membershipRow.id,
        }),
        auditReason,
        actorSource,
        input.traceId ?? null,
      ],
    );

    await client.query(
      `INSERT INTO membership_grant_events (
         user_membership_id, event_type, to_user_id, actor_admin_id, actor_source,
         reason, after_snapshot, audit_log_id
       ) VALUES (
         $1::uuid, 'GRANTED', $2::uuid, $3::uuid, $4::actor_source, $5, $6::jsonb, $7::uuid
       )`,
      [
        membershipRow.id,
        input.userId,
        input.adminUserId,
        actorSource,
        reason,
        JSON.stringify({
          planCode: 'FOUNDER_LIFETIME',
          founderNumber: membershipRow.founder_number,
          source: 'OWNER_GRANT',
          paymentReferenceRedacted: paymentRef,
        }),
        audit.rows[0]?.id ?? null,
      ],
    );

    return {
      membershipId: membershipRow.id,
      planCode: 'FOUNDER_LIFETIME',
      founderNumber: membershipRow.founder_number,
      status: membershipRow.status,
      source: 'OWNER_GRANT',
      grantedAt: membershipRow.granted_at.toISOString(),
      recovered: false,
    };
  });
}

export interface FounderClaimCodeIssueResult {
  readonly claimCodeId: string;
  readonly rawCode: string;
  readonly expiresAt: string | null;
  readonly planCode: 'FOUNDER_LIFETIME';
  readonly founderNumberReserved: number | null;
}

/**
 * Owner-issued one-time Founder claim code. Raw secret returned once; DB stores hash only.
 */
export async function issueFounderClaimCode(
  pool: Pool,
  input: {
    readonly adminUserId: string;
    readonly expiresAt?: Date | null;
    readonly issuedForReference?: string | null;
    readonly reserveFounderNumber?: boolean;
    readonly actorSource?: 'TELEGRAM' | 'API' | 'WEB';
    readonly traceId?: string | null;
  },
): Promise<FounderClaimCodeIssueResult> {
  const actorSource = input.actorSource ?? 'TELEGRAM';
  const expiresAt = input.expiresAt === undefined ? null : input.expiresAt;
  if (expiresAt !== null && expiresAt.getTime() <= Date.now()) {
    throw new AuthDomainError('VALIDATION', 'Claim code expiry must be in the future');
  }
  const issuedForReference = input.issuedForReference?.trim() || null;
  if (issuedForReference !== null && issuedForReference.length > 200) {
    throw new AuthDomainError('VALIDATION', 'issuedForReference too long');
  }

  return withTransaction(pool, async (client) => {
    const admin = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM admin_users WHERE id = $1::uuid FOR SHARE`,
      [input.adminUserId],
    );
    if (admin.rows[0]?.status !== 'ACTIVE') {
      throw new AuthDomainError('FORBIDDEN', 'Claim code could not be issued');
    }

    const plan = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM membership_plans WHERE code = 'FOUNDER_LIFETIME' FOR SHARE`,
    );
    const planRow = plan.rows[0];
    if (planRow === undefined || planRow.status !== 'ACTIVE') {
      throw new AuthDomainError('VALIDATION', 'FOUNDER_LIFETIME plan is not active');
    }

    let reserved: number | null = null;
    if (input.reserveFounderNumber === true) {
      const seq = await client.query<{ nextval: string }>(
        `SELECT nextval('founder_number_seq')::text AS nextval`,
      );
      const next = seq.rows[0]?.nextval;
      if (next === undefined) {
        throw new AuthDomainError('INTERNAL', 'Founder number reservation failed');
      }
      reserved = Number(next);
    }

    const rawCode = generateClaimCode(24);
    const codeHash = hashClaimCode(rawCode);

    const inserted = await client.query<{ id: string; expires_at: Date | null }>(
      `INSERT INTO membership_claim_codes (
         code_hash, membership_plan_id, founder_number_reserved,
         issued_for_reference, expires_at, created_by_admin_id
       ) VALUES ($1, $2::uuid, $3, $4, $5, $6::uuid)
       RETURNING id, expires_at`,
      [codeHash, planRow.id, reserved, issuedForReference, expiresAt, input.adminUserId],
    );
    const row = inserted.rows[0];
    if (row === undefined) {
      throw new AuthDomainError('INTERNAL', 'Claim code insert failed');
    }

    await client.query(
      `INSERT INTO audit_logs (
         admin_user_id, actor_type, action_type, resource_type, resource_id,
         after_snapshot, reason, source, trace_id
       ) VALUES (
         $1::uuid, 'ADMIN', 'membership.founder_claim_code_issue', 'membership_claim_code', $2::uuid,
         $3::jsonb, $4, $5::actor_source, $6
       )`,
      [
        input.adminUserId,
        row.id,
        JSON.stringify({
          planCode: 'FOUNDER_LIFETIME',
          claimCodeId: row.id,
          expiresAt: row.expires_at?.toISOString() ?? null,
          founderNumberReserved: reserved,
          // raw code intentionally omitted
        }),
        'Owner issued Founder claim code',
        actorSource,
        input.traceId ?? null,
      ],
    );

    return {
      claimCodeId: row.id,
      rawCode,
      expiresAt: row.expires_at?.toISOString() ?? null,
      planCode: 'FOUNDER_LIFETIME',
      founderNumberReserved: reserved,
    };
  });
}

export interface FounderSearchHit {
  readonly userId: string;
  readonly telegramUserId: string | null;
  readonly username: string | null;
  readonly membershipId: string | null;
  readonly planCode: string | null;
  readonly membershipStatus: string | null;
  readonly founderNumber: number | null;
  readonly source: string | null;
  readonly grantedAt: string | null;
  readonly claimedAt: string | null;
  readonly paymentReferenceRedacted: string | null;
}

/** Read-only Founder/member search. Creates no financial/domain mutation. */
export async function searchFounderMember(
  pool: Pool,
  query: {
    readonly founderNumber?: number;
    readonly userId?: string;
    readonly telegramUserId?: string;
    readonly membershipId?: string;
  },
): Promise<readonly FounderSearchHit[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const push = (sql: string, value: unknown) => {
    params.push(value);
    clauses.push(sql.replace('?', `$${params.length}`));
  };

  if (query.founderNumber !== undefined) {
    push('um.founder_number = ?', query.founderNumber);
  }
  if (query.userId !== undefined) {
    push('u.id = ?::uuid', query.userId);
  }
  if (query.telegramUserId !== undefined) {
    push('u.telegram_user_id = ?::bigint', query.telegramUserId);
  }
  if (query.membershipId !== undefined) {
    push('um.id = ?::uuid', query.membershipId);
  }
  if (clauses.length === 0) {
    throw new AuthDomainError('VALIDATION', 'At least one search key is required');
  }

  const result = await pool.query<{
    user_id: string;
    telegram_user_id: string | null;
    username: string | null;
    membership_id: string | null;
    plan_code: string | null;
    membership_status: string | null;
    founder_number: number | null;
    source: string | null;
    granted_at: Date | null;
    claimed_at: Date | null;
    payment_reference_redacted: string | null;
  }>(
    `SELECT u.id AS user_id,
            u.telegram_user_id::text AS telegram_user_id,
            u.username,
            um.id AS membership_id,
            mp.code AS plan_code,
            um.status AS membership_status,
            um.founder_number,
            um.source,
            um.granted_at,
            um.claimed_at,
            um.payment_reference_redacted
     FROM users u
     LEFT JOIN user_memberships um ON um.user_id = u.id
     LEFT JOIN membership_plans mp ON mp.id = um.membership_plan_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY um.granted_at DESC NULLS LAST
     LIMIT 25`,
    params,
  );

  return result.rows.map((row) => ({
    userId: row.user_id,
    telegramUserId: row.telegram_user_id,
    username: row.username,
    membershipId: row.membership_id,
    planCode: row.plan_code,
    membershipStatus: row.membership_status,
    founderNumber: row.founder_number,
    source: row.source,
    grantedAt: row.granted_at?.toISOString() ?? null,
    claimedAt: row.claimed_at?.toISOString() ?? null,
    paymentReferenceRedacted: row.payment_reference_redacted,
  }));
}

export interface FounderHistoryView {
  readonly membershipId: string;
  readonly userId: string;
  readonly planCode: string;
  readonly founderNumber: number | null;
  readonly status: string;
  readonly source: string;
  readonly grantedAt: string;
  readonly claimedAt: string | null;
  readonly paymentReferenceRedacted: string | null;
  readonly events: ReadonlyArray<{
    readonly eventType: string;
    readonly createdAt: string;
    readonly reason: string | null;
    readonly actorAdminId: string | null;
    readonly actorSource: string;
  }>;
}

export async function getFounderHistory(
  pool: Pool,
  query: { readonly userId?: string; readonly founderNumber?: number },
): Promise<FounderHistoryView | null> {
  if (query.userId === undefined && query.founderNumber === undefined) {
    throw new AuthDomainError('VALIDATION', 'userId or founderNumber is required');
  }
  const params: unknown[] = [];
  const where: string[] = [`mp.code = 'FOUNDER_LIFETIME'`];
  if (query.userId !== undefined) {
    params.push(query.userId);
    where.push(`um.user_id = $${params.length}::uuid`);
  }
  if (query.founderNumber !== undefined) {
    params.push(query.founderNumber);
    where.push(`um.founder_number = $${params.length}`);
  }

  const membership = await pool.query<{
    id: string;
    user_id: string;
    plan_code: string;
    founder_number: number | null;
    status: string;
    source: string;
    granted_at: Date;
    claimed_at: Date | null;
    payment_reference_redacted: string | null;
  }>(
    `SELECT um.id, um.user_id, mp.code AS plan_code, um.founder_number, um.status, um.source,
            um.granted_at, um.claimed_at, um.payment_reference_redacted
     FROM user_memberships um
     INNER JOIN membership_plans mp ON mp.id = um.membership_plan_id
     WHERE ${where.join(' AND ')}
     ORDER BY um.granted_at DESC
     LIMIT 1`,
    params,
  );
  const row = membership.rows[0];
  if (row === undefined) return null;

  const events = await pool.query<{
    event_type: string;
    created_at: Date;
    reason: string | null;
    actor_admin_id: string | null;
    actor_source: string;
  }>(
    `SELECT event_type, created_at, reason, actor_admin_id, actor_source
     FROM membership_grant_events
     WHERE user_membership_id = $1::uuid
     ORDER BY created_at ASC`,
    [row.id],
  );

  return {
    membershipId: row.id,
    userId: row.user_id,
    planCode: row.plan_code,
    founderNumber: row.founder_number,
    status: row.status,
    source: row.source,
    grantedAt: row.granted_at.toISOString(),
    claimedAt: row.claimed_at?.toISOString() ?? null,
    paymentReferenceRedacted: row.payment_reference_redacted,
    events: events.rows.map((event) => ({
      eventType: event.event_type,
      createdAt: event.created_at.toISOString(),
      reason: event.reason,
      actorAdminId: event.actor_admin_id,
      actorSource: event.actor_source,
    })),
  };
}

/**
 * Exceptional Founder reassignment mutation is unavailable until Owner
 * reauthentication is available on the Telegram action boundary.
 */
export async function reassignFounderMembership(): Promise<never> {
  throw new AuthDomainError(
    'FORBIDDEN',
    'Founder reassignment mutation unavailable without Owner reauthentication',
    { details: { reason: 'REASSIGNMENT_UNAVAILABLE' } },
  );
}
