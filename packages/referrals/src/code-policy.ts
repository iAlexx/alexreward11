/**
 * Versioned referral code format policy + server-side code generation.
 * No production alphabet/length defaults. No Math.random.
 */
import { randomInt } from 'node:crypto';

import type { PoolClient } from 'pg';

import { ReferralDomainError } from './errors.js';

const FORBIDDEN_ALPHABET_CHARS = new Set([' ', '\t', '\n', '\r', '&', '=', '?', '#', '/']);

export interface ReferralCodePolicyVersion {
  readonly id: string;
  readonly policyVersion: number;
  readonly codeLength: number;
  readonly alphabet: string;
  readonly status: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

/** Bits of entropy = log2(alphabetSize) * length. Require >= 96. */
export function referralCodeEntropyBits(alphabetSize: number, codeLength: number): number {
  if (alphabetSize < 2 || codeLength < 1) return 0;
  return Math.log2(alphabetSize) * codeLength;
}

export function assertReferralCodePolicyShape(input: {
  readonly alphabet: string;
  readonly codeLength: number;
}): void {
  const alphabet = input.alphabet;
  if (typeof alphabet !== 'string' || alphabet.length < 2) {
    throw new ReferralDomainError(
      'REFERRAL_CODE_POLICY_INVALID',
      'alphabet must contain at least 2 characters',
    );
  }
  const seen = new Set<string>();
  for (const ch of alphabet) {
    if (FORBIDDEN_ALPHABET_CHARS.has(ch)) {
      throw new ReferralDomainError(
        'REFERRAL_CODE_POLICY_INVALID',
        'alphabet contains deep-link-unsafe characters',
      );
    }
    if (seen.has(ch)) {
      throw new ReferralDomainError(
        'REFERRAL_CODE_POLICY_INVALID',
        'alphabet characters must be unique',
      );
    }
    seen.add(ch);
  }
  if (!Number.isInteger(input.codeLength) || input.codeLength < 8 || input.codeLength > 64) {
    throw new ReferralDomainError(
      'REFERRAL_CODE_POLICY_INVALID',
      'codeLength must be an integer between 8 and 64',
    );
  }
  const bits = referralCodeEntropyBits(alphabet.length, input.codeLength);
  if (bits < 96) {
    throw new ReferralDomainError(
      'REFERRAL_CODE_POLICY_INVALID',
      'code policy entropy must be at least 96 bits',
      { bits, alphabetSize: alphabet.length, codeLength: input.codeLength },
    );
  }
}

export async function resolveActiveReferralCodePolicy(
  client: PoolClient,
): Promise<ReferralCodePolicyVersion> {
  const nowResult = await client.query<{ now: Date }>(`SELECT now() AS now`);
  const at = nowResult.rows[0]?.now;
  if (at === undefined) {
    throw new ReferralDomainError('INTERNAL', 'failed to read server now()');
  }

  const result = await client.query<{
    id: string;
    policy_version: number;
    code_length: number;
    alphabet: string;
    status: string;
    effective_from: Date;
    effective_to: Date | null;
  }>(
    `SELECT id, policy_version, code_length, alphabet, status::text AS status,
            effective_from, effective_to
     FROM referral_code_policy_versions
     WHERE status = 'ACTIVE'
       AND effective_from <= $1::timestamptz
       AND (effective_to IS NULL OR effective_to > $1::timestamptz)
     ORDER BY policy_version ASC
     FOR SHARE`,
    [at.toISOString()],
  );

  if (result.rows.length === 0) {
    throw new ReferralDomainError(
      'REFERRAL_CODE_POLICY_NOT_CONFIGURED',
      'No ACTIVE referral code policy is configured',
    );
  }
  if (result.rows.length > 1) {
    throw new ReferralDomainError(
      'REFERRAL_CODE_POLICY_AMBIGUOUS',
      'Ambiguous ACTIVE referral code policies',
      { count: result.rows.length },
    );
  }

  const row = result.rows[0]!;
  assertReferralCodePolicyShape({ alphabet: row.alphabet, codeLength: row.code_length });
  return {
    id: row.id,
    policyVersion: row.policy_version,
    codeLength: row.code_length,
    alphabet: row.alphabet,
    status: row.status,
    effectiveFrom: row.effective_from.toISOString(),
    effectiveTo: row.effective_to?.toISOString() ?? null,
  };
}

function generateCodeFromPolicy(policy: ReferralCodePolicyVersion): string {
  const chars: string[] = [];
  for (let i = 0; i < policy.codeLength; i += 1) {
    const idx = randomInt(0, policy.alphabet.length);
    chars.push(policy.alphabet[idx]!);
  }
  return chars.join('');
}

export interface EnsureReferralCodeResult {
  readonly code: string;
  readonly codeId: string;
  readonly created: boolean;
  readonly policyVersion: number | null;
}

const MAX_COLLISION_ATTEMPTS = 16;

/**
 * Ensure the user has exactly one referral code.
 * Server-only; client never chooses the code. Fail-closed without ACTIVE policy when creating.
 */
export async function ensureReferralCode(
  client: PoolClient,
  input: { readonly userId: string },
): Promise<EnsureReferralCodeResult> {
  if (typeof input.userId !== 'string' || input.userId.trim() === '') {
    throw new ReferralDomainError('INTERNAL', 'userId is required');
  }

  await client.query(`SELECT id FROM users WHERE id = $1::uuid FOR UPDATE`, [input.userId]);

  const existing = await client.query<{
    id: string;
    code: string;
    generation_policy_version: number | null;
  }>(
    `SELECT id, code, generation_policy_version
     FROM referral_codes
     WHERE user_id = $1::uuid
     FOR UPDATE`,
    [input.userId],
  );
  const row = existing.rows[0];
  if (row !== undefined) {
    return {
      code: row.code,
      codeId: row.id,
      created: false,
      policyVersion: row.generation_policy_version,
    };
  }

  const policy = await resolveActiveReferralCodePolicy(client);

  for (let attempt = 0; attempt < MAX_COLLISION_ATTEMPTS; attempt += 1) {
    const code = generateCodeFromPolicy(policy);
    try {
      const inserted = await client.query<{ id: string; code: string }>(
        `INSERT INTO referral_codes (user_id, code, status, generation_policy_version)
         VALUES ($1::uuid, $2, 'ACTIVE', $3)
         RETURNING id, code`,
        [input.userId, code, policy.policyVersion],
      );
      const created = inserted.rows[0];
      if (created === undefined) {
        throw new ReferralDomainError('INTERNAL', 'referral code insert failed');
      }
      return {
        code: created.code,
        codeId: created.id,
        created: true,
        policyVersion: policy.policyVersion,
      };
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: string }).code === '23505'
      ) {
        continue;
      }
      throw error;
    }
  }

  throw new ReferralDomainError(
    'INTERNAL',
    'referral code generation exhausted collision retries',
    { attempts: MAX_COLLISION_ATTEMPTS },
  );
}

export async function readReferralSummary(
  client: PoolClient,
  input: { readonly userId: string },
): Promise<{
  readonly referralCode: string | null;
  readonly invitedCount: number;
  readonly activatedCount: number;
}> {
  const code = await client.query<{ code: string }>(
    `SELECT code FROM referral_codes WHERE user_id = $1::uuid`,
    [input.userId],
  );
  const counts = await client.query<{ invited: string; activated: string }>(
    `SELECT
       count(*)::text AS invited,
       count(*) FILTER (WHERE state = 'ACTIVE')::text AS activated
     FROM referral_edges
     WHERE referrer_user_id = $1::uuid`,
    [input.userId],
  );
  return {
    referralCode: code.rows[0]?.code ?? null,
    invitedCount: Number(counts.rows[0]?.invited ?? '0'),
    activatedCount: Number(counts.rows[0]?.activated ?? '0'),
  };
}
