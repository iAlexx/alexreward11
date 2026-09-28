import type { PoolClient } from 'pg';

import { assertSafePersistedJsonObject } from './canonical.js';
import { FraudDomainError } from './errors.js';
import { loadTrustRuleVersionForSnapshot } from './trust-rule.js';

export type TrustState = 'NEW' | 'BASIC' | 'ESTABLISHED' | 'TRUSTED';

const TRUST_STATES = new Set<string>(['NEW', 'BASIC', 'ESTABLISHED', 'TRUSTED']);

const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export interface PersistTrustSnapshotInput {
  readonly userId: string;
  readonly trustState: TrustState;
  /** Server-produced integer score 0..100 — no semantic thresholds applied here. */
  readonly trustScore: number;
  /** Must reference an existing trust_rule_versions.rule_version. */
  readonly ruleVersion: number;
  readonly reasonCodes: readonly string[];
  /** Safe-to-store JSON only (no secrets, exact IP, tokens, private keys). */
  readonly signals: Readonly<Record<string, unknown>>;
}

export interface PersistedTrustSnapshot {
  readonly id: string;
  readonly userId: string;
  readonly trustState: TrustState;
  readonly trustScore: number;
  readonly ruleVersion: number;
  readonly reasonCodes: readonly string[];
  readonly signals: Readonly<Record<string, unknown>>;
  readonly calculatedAt: Date;
}

/**
 * Normalize reason codes: unique + stable ascending order.
 * Empty input is rejected by the caller before insert.
 */
function normalizeReasonCodes(codes: readonly string[]): readonly string[] {
  if (codes.length === 0) {
    throw new FraudDomainError('TRUST_SNAPSHOT_INVALID', 'reasonCodes must be non-empty');
  }
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const code of codes) {
    if (!REASON_CODE_PATTERN.test(code)) {
      throw new FraudDomainError('TRUST_SNAPSHOT_INVALID', `invalid reason code ${code}`, {
        code,
      });
    }
    if (!seen.has(code)) {
      seen.add(code);
      unique.push(code);
    }
  }
  unique.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return unique;
}

/**
 * Persist an already-produced Trust evaluation as an immutable snapshot.
 *
 * Does NOT calculate Trust, invent thresholds, read Membership/Founder,
 * mutate users table trust columns, clear fraud holds, or grant payout benefits.
 */
export async function persistTrustSnapshot(
  client: PoolClient,
  input: PersistTrustSnapshotInput,
): Promise<PersistedTrustSnapshot> {
  if (!TRUST_STATES.has(input.trustState)) {
    throw new FraudDomainError('TRUST_SNAPSHOT_INVALID', 'trustState is invalid', {
      trustState: input.trustState,
    });
  }
  if (!Number.isInteger(input.trustScore) || input.trustScore < 0 || input.trustScore > 100) {
    throw new FraudDomainError(
      'TRUST_SNAPSHOT_INVALID',
      'trustScore must be an integer 0..100',
      { trustScore: input.trustScore },
    );
  }

  // Rule version must exist; hold FOR SHARE through caller TX (Step 10).
  const rule = await loadTrustRuleVersionForSnapshot(client, input.ruleVersion);
  const reasonCodes = normalizeReasonCodes(input.reasonCodes);
  assertSafePersistedJsonObject('signals', input.signals);

  const result = await client.query<{
    id: string;
    calculated_at: Date;
  }>(
    `INSERT INTO trust_snapshots (
       user_id, trust_state, trust_score, rule_version, reason_codes, signals
     ) VALUES (
       $1::uuid, $2::trust_state, $3, $4, $5::text[], $6::jsonb
     )
     RETURNING id, calculated_at`,
    [
      input.userId,
      input.trustState,
      input.trustScore,
      rule.ruleVersion,
      reasonCodes,
      JSON.stringify(input.signals),
    ],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw new FraudDomainError(
      'TRUST_SNAPSHOT_PERSIST_FAILED',
      'trust snapshot insert returned no row',
    );
  }

  return {
    id: row.id,
    userId: input.userId,
    trustState: input.trustState,
    trustScore: input.trustScore,
    ruleVersion: rule.ruleVersion,
    reasonCodes,
    signals: input.signals,
    calculatedAt: row.calculated_at,
  };
}
