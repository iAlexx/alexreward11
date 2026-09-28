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
import { collectConfiguredRiskSignals } from './risk-signal-collector.js';
import {
  persistRiskSnapshot,
  type PersistedRiskSnapshot,
  type RiskDecisionScope,
} from './risk-snapshot.js';

export interface EvaluateAndPersistRiskInput {
  readonly userId: string;
  readonly decisionScope: RiskDecisionScope;
  /**
   * Optional safe audit context nested under safeInputs.context.
   * Must not overwrite system fields (ruleVersion / signalState / signalEvidence).
   */
  readonly safeContext?: Readonly<Record<string, unknown>>;
}

export interface EvaluateAndPersistRiskResult {
  readonly rule: ResolvedRiskRuleVersion;
  readonly signalFacts: readonly RiskSignalFact[];
  readonly evaluation: RiskEvaluationResult;
  readonly snapshot: PersistedRiskSnapshot;
  readonly profile: PersistedRiskProfile;
}

/**
 * Authoritative evaluate + persist path.
 *
 * Resolves the ACTIVE risk rule from the DB using server current time only,
 * collects configured risk signals from server-authoritative DB sources,
 * evaluates those collected facts, then writes exactly one immutable snapshot
 * and one current risk_profiles upsert.
 *
 * Callers supply only userId / decisionScope / optional safeContext.
 * They must not choose signal facts, weights, score, tier, action, rule, or time.
 *
 * Historical / effective-window rule lookup remains available only via the
 * lower-level resolveActiveRiskRuleVersion(client, { at }) helper.
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
  const evaluatedAt = new Date();
  const context = input.safeContext ?? {};
  assertSafePersistedJsonObject('safeContext', context);

  const rule = await resolveActiveRiskRuleVersion(client, { at: evaluatedAt });
  const collected = await collectConfiguredRiskSignals(client, {
    userId: input.userId,
    rule,
  });
  const evaluation = evaluateRiskSignals(rule, collected.signalFacts);

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
    signalEvidence: collected.signalEvidence,
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

  return {
    rule,
    signalFacts: collected.signalFacts,
    evaluation,
    snapshot,
    profile,
  };
}
