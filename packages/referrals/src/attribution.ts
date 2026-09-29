/**
 * Authoritative one-time PENDING referral attribution.
 *
 * Creates PENDING edges only. Does not activate, reject, or issue referral money.
 */
import type { PoolClient } from 'pg';

import { ReferralDomainError } from './errors.js';

export type ReferralAttributionOutcome =
  | {
      readonly outcome: 'ATTRIBUTED';
      readonly edgeId: string;
      readonly referrerUserId: string;
      readonly codeId: string;
      readonly state: 'PENDING';
    }
  | {
      readonly outcome: 'ALREADY_ATTRIBUTED';
      readonly edgeId: string;
      readonly state: string;
    }
  | { readonly outcome: 'CODE_NOT_FOUND' }
  | { readonly outcome: 'CODE_DISABLED' }
  | { readonly outcome: 'SELF_REFERRAL' };

const UNIQUE_VIOLATION = '23505';

/**
 * Attribute an authenticated invitee to an opaque referral code inside the caller's
 * transaction. Caller supplies only referredUserId + code — never referrer authority.
 */
export async function attributeReferralCode(
  client: PoolClient,
  input: {
    readonly referredUserId: string;
    readonly code: string;
  },
): Promise<ReferralAttributionOutcome> {
  if (typeof input.referredUserId !== 'string' || input.referredUserId.trim() === '') {
    throw new ReferralDomainError('INTERNAL', 'referredUserId is required');
  }
  if (typeof input.code !== 'string' || input.code === '') {
    throw new ReferralDomainError('INTERNAL', 'referral code locator is required');
  }

  const lockedUser = await client.query<{ id: string }>(
    `SELECT id FROM users WHERE id = $1::uuid FOR UPDATE`,
    [input.referredUserId],
  );
  if (lockedUser.rows[0] === undefined) {
    throw new ReferralDomainError('INTERNAL', 'referred user does not exist', {
      referredUserId: input.referredUserId,
    });
  }

  const existing = await client.query<{ id: string; state: string }>(
    `SELECT id, state::text AS state
     FROM referral_edges
     WHERE referred_user_id = $1::uuid`,
    [input.referredUserId],
  );
  const existingEdge = existing.rows[0];
  if (existingEdge !== undefined) {
    return {
      outcome: 'ALREADY_ATTRIBUTED',
      edgeId: existingEdge.id,
      state: existingEdge.state,
    };
  }

  const codeRow = await client.query<{
    id: string;
    user_id: string;
    status: string;
  }>(
    `SELECT id, user_id, status::text AS status
     FROM referral_codes
     WHERE code = $1
     FOR SHARE`,
    [input.code],
  );
  const matched = codeRow.rows[0];
  if (matched === undefined) {
    return { outcome: 'CODE_NOT_FOUND' };
  }
  if (matched.status !== 'ACTIVE') {
    return { outcome: 'CODE_DISABLED' };
  }
  if (matched.user_id === input.referredUserId) {
    return { outcome: 'SELF_REFERRAL' };
  }

  try {
    const inserted = await client.query<{
      id: string;
      referrer_user_id: string;
      code_id: string;
      state: string;
    }>(
      `INSERT INTO referral_edges (
         referrer_user_id, referred_user_id, code_id, state
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'PENDING'::referral_edge_state
       )
       RETURNING id, referrer_user_id, code_id, state::text AS state`,
      [matched.user_id, input.referredUserId, matched.id],
    );
    const edge = inserted.rows[0];
    if (edge === undefined) {
      throw new ReferralDomainError('INTERNAL', 'referral edge insert returned no row');
    }
    return {
      outcome: 'ATTRIBUTED',
      edgeId: edge.id,
      referrerUserId: edge.referrer_user_id,
      codeId: edge.code_id,
      state: 'PENDING',
    };
  } catch (error) {
    const code =
      error !== null && typeof error === 'object' && 'code' in error
        ? String((error as { code: unknown }).code)
        : '';
    if (code === UNIQUE_VIOLATION) {
      const raced = await client.query<{ id: string; state: string }>(
        `SELECT id, state::text AS state
         FROM referral_edges
         WHERE referred_user_id = $1::uuid`,
        [input.referredUserId],
      );
      const edge = raced.rows[0];
      if (edge !== undefined) {
        return {
          outcome: 'ALREADY_ATTRIBUTED',
          edgeId: edge.id,
          state: edge.state,
        };
      }
    }
    throw error;
  }
}
