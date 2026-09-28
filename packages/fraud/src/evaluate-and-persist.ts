import type { PoolClient } from 'pg';

import { assertSafePersistedJsonObject } from './canonical.js';
import {
  evaluateRiskSignals,
  type RiskEvaluationResult,
  type RiskSignalFact,
} from './risk-evaluator.js';
import {
  upsertRiskProfileFromEvaluation,
  type PersistedRiskProfile,
} from './risk-profile.js';
import {
  resolveActiveRiskRuleVersion,
  type ResolvedRiskRuleVersion,
} from './risk-rule.js';
import {
  persistRiskSnapshot,
  type PersistedRiskSnapshot,
  type RiskDecisionScope,
} from './risk-snapshot.js';

export interface EvaluateAndPersistRiskInput {
  readonly userId: string;
  readonly decisionScope: RiskDecisionScope;
  readonly signalFacts: readonly RiskSignalFact[];
  /**
   * Optional safe audit context nested under safeInputs.context.
   * Must not overwrite system fields (ruleVersion / signalState).
   */
  readonly safeContext?: Readonly<Record<string, unknown>>;
  /**
   * Instant used for ACTIVE rule effective-window selection.
   * Defaults to now. Tests may pin this for deterministic version selection.
   */
  readonly evaluatedAt?: Date;
}

export interface EvaluateAndPersistRiskResult {
  readonly rule: ResolvedRiskRuleVersion;
  readonly evaluation: RiskEvaluationResult;
  readonly snapshot: PersistedRiskSnapshot;
  readonly profile: PersistedRiskProfile;
}

/**
 * Authoritative evaluate + persist path.
 *
 * Resolves the ACTIVE risk rule from the DB (never accepts a caller-supplied rule),
 * evaluates signals against that rule, then writes exactly one immutable snapshot and
 * one current risk_profiles upsert.
 *
 * Transaction semantics: callers MUST pass a PoolClient already bound to their
 * transaction so snapshot + profile commit/rollback together. This function does
 * not open nested transactions and does not write ledger / user status.
 *
 * Snapshots are chronological audit rows: reevaluation may create a later snapshot.
 * There is no global snapshot dedupe.
 *
 * Never mutates users.status / withdrawal_status / ledger. Actions are returned, not executed.
 */
export async function evaluateAndPersistRisk(
  client: PoolClient,
  input: EvaluateAndPersistRiskInput,
): Promise<EvaluateAndPersistRiskResult> {
  const evaluatedAt = input.evaluatedAt ?? new Date();
  const context = input.safeContext ?? {};
  assertSafePersistedJsonObject('safeContext', context);

  const rule = await resolveActiveRiskRuleVersion(client, { at: evaluatedAt });
  const evaluation = evaluateRiskSignals(rule, input.signalFacts);

  const signalState = evaluation.contributions.map((item) => ({
    code: item.code,
    active: item.active,
    configuredWeight: item.configuredWeight,
    contribution: item.contribution,
  }));

  // Nest caller context so it cannot overwrite authoritative audit fields.
  const safeInputs: Record<string, unknown> = {
    ruleVersion: evaluation.ruleVersion,
    signalState,
    context,
  };

  const outputs: Record<string, unknown> = {
    score: evaluation.score,
    riskTier: evaluation.riskTier,
    configuredAction: evaluation.action,
    contributions: signalState,
    neverAutoBan: true,
    neverAutoApprove: true,
  };

  const snapshot = await persistRiskSnapshot(client, {
    userId: input.userId,
    decisionScope: input.decisionScope,
    score: evaluation.score,
    riskTier: evaluation.riskTier,
    ruleVersion: evaluation.ruleVersion,
    reasonCodes: evaluation.reasonCodes,
    safeInputs,
    outputs,
  });

  const profile = await upsertRiskProfileFromEvaluation(client, {
    userId: input.userId,
    evaluation,
    calculatedAt: snapshot.calculatedAt,
  });

  return { rule, evaluation, snapshot, profile };
}
