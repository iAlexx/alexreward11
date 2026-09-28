import type { PoolClient } from 'pg';

import { computeRiskInputsDigest } from './canonical.js';
import { FraudDomainError } from './errors.js';
import type { RiskTier } from './risk-rule.js';

export type RiskDecisionScope =
  | 'AD_SESSION_START'
  | 'WITHDRAWAL_REQUEST'
  | 'MISSION_CLAIM'
  | 'TASK_CLAIM'
  | 'REFERRAL_ACTIVATION'
  | 'MEMBERSHIP_CLAIM';

const DECISION_SCOPES = new Set<string>([
  'AD_SESSION_START',
  'WITHDRAWAL_REQUEST',
  'MISSION_CLAIM',
  'TASK_CLAIM',
  'REFERRAL_ACTIVATION',
  'MEMBERSHIP_CLAIM',
]);

const RISK_TIERS = new Set<string>(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export interface PersistRiskSnapshotInput {
  readonly userId: string;
  readonly decisionScope: RiskDecisionScope;
  /** Server-produced score only — never accept client-authored scores. */
  readonly score: number;
  readonly riskTier: RiskTier;
  readonly ruleVersion: number;
  readonly reasonCodes: readonly string[];
  /** Safe-to-store JSON only (no secrets, exact IP, GPS, private keys). */
  readonly safeInputs: Readonly<Record<string, unknown>>;
  readonly outputs: Readonly<Record<string, unknown>>;
  /** Optional precomputed digest; otherwise derived from ruleVersion + safeInputs. */
  readonly inputsDigest?: string;
}

export interface PersistedRiskSnapshot {
  readonly id: string;
  readonly userId: string;
  readonly decisionScope: RiskDecisionScope;
  readonly score: number;
  readonly riskTier: RiskTier;
  readonly ruleVersion: number;
  readonly reasonCodes: readonly string[];
  readonly inputsDigest: string;
  readonly safeInputs: Readonly<Record<string, unknown>>;
  readonly outputs: Readonly<Record<string, unknown>>;
  readonly calculatedAt: Date;
}

function assertSafeJsonLeaf(path: string, value: unknown): void {
  if (value === null) return;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return;
  if (t === 'number') {
    if (!Number.isFinite(value) || Number.isNaN(value)) {
      throw new FraudDomainError('RISK_SNAPSHOT_INVALID', `${path} must be a finite number`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeJsonLeaf(`${path}[${index}]`, item));
    return;
  }
  if (t === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const lower = key.toLowerCase();
      if (
        lower.includes('initdata') ||
        lower.includes('token') ||
        lower.includes('secret') ||
        lower.includes('password') ||
        lower.includes('mnemonic') ||
        lower.includes('privatekey') ||
        lower === 'ip' ||
        lower === 'exact_ip' ||
        lower === 'gps' ||
        lower === 'latitude' ||
        lower === 'longitude'
      ) {
        throw new FraudDomainError(
          'RISK_SNAPSHOT_INVALID',
          `safeInputs/outputs key ${key} is not allowed`,
          { key },
        );
      }
      assertSafeJsonLeaf(`${path}.${key}`, child);
    }
    return;
  }
  throw new FraudDomainError('RISK_SNAPSHOT_INVALID', `${path} has unsupported JSON type`);
}

function assertReasonCodes(codes: readonly string[]): readonly string[] {
  if (codes.length === 0) {
    throw new FraudDomainError('RISK_SNAPSHOT_INVALID', 'reasonCodes must be non-empty');
  }
  for (const code of codes) {
    if (!REASON_CODE_PATTERN.test(code)) {
      throw new FraudDomainError('RISK_SNAPSHOT_INVALID', `invalid reason code ${code}`, { code });
    }
  }
  return codes;
}

/**
 * Persist an already-produced deterministic risk evaluation as an immutable snapshot.
 * Does not calculate scores — callers supply the server evaluation result.
 */
export async function persistRiskSnapshot(
  client: PoolClient,
  input: PersistRiskSnapshotInput,
): Promise<PersistedRiskSnapshot> {
  if (!DECISION_SCOPES.has(input.decisionScope)) {
    throw new FraudDomainError('RISK_SNAPSHOT_INVALID', 'decisionScope is invalid');
  }
  if (!Number.isInteger(input.score) || input.score < 0 || input.score > 100) {
    throw new FraudDomainError('RISK_SNAPSHOT_INVALID', 'score must be an integer 0..100');
  }
  if (!RISK_TIERS.has(input.riskTier)) {
    throw new FraudDomainError('RISK_SNAPSHOT_INVALID', 'riskTier is invalid');
  }
  if (!Number.isInteger(input.ruleVersion) || input.ruleVersion <= 0) {
    throw new FraudDomainError('RISK_SNAPSHOT_INVALID', 'ruleVersion must be a positive integer');
  }

  const reasonCodes = assertReasonCodes(input.reasonCodes);
  assertSafeJsonLeaf('safeInputs', input.safeInputs);
  assertSafeJsonLeaf('outputs', input.outputs);

  const inputsDigest =
    input.inputsDigest ?? computeRiskInputsDigest(input.ruleVersion, input.safeInputs);
  if (!/^[0-9a-f]{64}$/.test(inputsDigest)) {
    throw new FraudDomainError('RISK_SNAPSHOT_INVALID', 'inputsDigest must be sha256 hex');
  }

  const result = await client.query<{
    id: string;
    calculated_at: Date;
  }>(
    `INSERT INTO risk_snapshots (
       user_id, decision_scope, score, risk_tier, rule_version,
       reason_codes, inputs_digest, safe_inputs, outputs
     ) VALUES (
       $1::uuid, $2::eligibility_action_type, $3, $4::risk_tier, $5,
       $6::text[], $7, $8::jsonb, $9::jsonb
     )
     RETURNING id, calculated_at`,
    [
      input.userId,
      input.decisionScope,
      input.score,
      input.riskTier,
      input.ruleVersion,
      reasonCodes,
      inputsDigest,
      JSON.stringify(input.safeInputs),
      JSON.stringify(input.outputs),
    ],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw new FraudDomainError('RISK_SNAPSHOT_PERSIST_FAILED', 'risk snapshot insert returned no row');
  }

  return {
    id: row.id,
    userId: input.userId,
    decisionScope: input.decisionScope,
    score: input.score,
    riskTier: input.riskTier,
    ruleVersion: input.ruleVersion,
    reasonCodes,
    inputsDigest,
    safeInputs: input.safeInputs,
    outputs: input.outputs,
    calculatedAt: row.calculated_at,
  };
}
