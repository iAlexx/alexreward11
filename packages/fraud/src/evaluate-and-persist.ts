import type { PoolClient } from 'pg';

import { assertSafePersistedJsonObject } from './canonical.js';
import { evaluateRiskSignals, type RiskEvaluationResult, type RiskSignalFact } from './risk-evaluator.js';
import { upsertRiskProfile, type PersistedRiskProfile } from './risk-profile.js';
import type { RiskRuleVersion } from './risk-rule.js';
import {
  persistRiskSnapshot,
  type PersistedRiskSnapshot,
  type RiskDecisionScope,
} from './risk-snapshot.js';

export interface EvaluateAndPersistRiskInput {
  readonly userId: string;
  readonly decisionScope: RiskDecisionScope;
  readonly rule: RiskRuleVersion;
  readonly signalFacts: readonly RiskSignalFact[];
  /** Additional safe audit context merged into snapshot safeInputs. */
  readonly safeContext?: Readonly<Record<string, unknown>>;
}

export interface EvaluateAndPersistRiskResult {
  readonly evaluation: RiskEvaluationResult;
  readonly snapshot: PersistedRiskSnapshot;
  readonly profile: PersistedRiskProfile;
}

/**
 * One evaluation call => exactly one immutable snapshot + one current profile upsert.
 *
 * Snapshots are chronological audit rows: reevaluation with the same inputs may create a
 * later snapshot. There is no global snapshot dedupe. Callers should pass a PoolClient
 * already bound to their transaction; this function does not open nested financial txns.
 *
 * Never mutates users.status / withdrawal_status / ledger. Actions are returned, not executed.
 */
export async function evaluateAndPersistRisk(
  client: PoolClient,
  input: EvaluateAndPersistRiskInput,
): Promise<EvaluateAndPersistRiskResult> {
  if (input.safeContext !== undefined) {
    assertSafePersistedJsonObject('safeContext', input.safeContext);
  }

  const evaluation = evaluateRiskSignals(input.rule, input.signalFacts);

  const signalState = evaluation.contributions.map((item) => ({
    code: item.code,
    active: item.active,
    configuredWeight: item.configuredWeight,
    contribution: item.contribution,
  }));

  const safeInputs: Record<string, unknown> = {
    ruleVersion: evaluation.ruleVersion,
    signalState,
    ...(input.safeContext ?? {}),
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
    reasonCodes:
      evaluation.reasonCodes.length > 0 ? evaluation.reasonCodes : ['NO_ACTIVE_SIGNALS'],
    safeInputs,
    outputs,
  });

  const profile = await upsertRiskProfile(client, {
    userId: input.userId,
    score: evaluation.score,
    riskTier: evaluation.riskTier,
    ruleVersion: evaluation.ruleVersion,
    reasonCodes: snapshot.reasonCodes,
    calculatedAt: snapshot.calculatedAt,
  });

  return { evaluation, snapshot, profile };
}
