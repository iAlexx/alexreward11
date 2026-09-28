import type { PoolClient } from 'pg';

import { assertSafePersistedJsonObject } from './canonical.js';
import {
  evaluateTrustSignals,
  type TrustEvaluationResult,
  type TrustSignalFact,
} from './trust-evaluator.js';
import {
  resolveActiveTrustRuleVersionForEvaluation,
  type ResolvedTrustRuleVersion,
} from './trust-rule.js';
import { collectConfiguredTrustSignals } from './trust-signal-collector.js';
import {
  persistTrustSnapshot,
  type PersistedTrustSnapshot,
} from './trust-snapshot.js';

export interface EvaluateAndPersistTrustInput {
  readonly userId: string;
  /**
   * Optional safe audit context nested under signals.context.
   * Must not overwrite system fields (ruleVersion / signalState / signalEvidence).
   */
  readonly safeContext?: Readonly<Record<string, unknown>>;
}

export interface EvaluateAndPersistTrustResult {
  readonly rule: ResolvedTrustRuleVersion;
  readonly signalFacts: readonly TrustSignalFact[];
  readonly evaluation: TrustEvaluationResult;
  readonly snapshot: PersistedTrustSnapshot;
}

/**
 * Authoritative Trust evaluate + persist path.
 *
 * Resolves the ACTIVE trust rule from the DB using server current time only,
 * holding FOR SHARE on that rule row through the caller transaction, then
 * collects configured trust signals from server-authoritative DB sources,
 * evaluates those collected facts, writes exactly one immutable snapshot,
 * and projects trust_state onto users.
 *
 * Callers supply only userId / optional safeContext.
 * They must not choose signal facts, weights, score, state, rule, or time.
 *
 * Same caller TX. No ledger. No risk mutation. No withdrawal mutation.
 * Trust stays separate from Risk and never grants payout benefits.
 */
export async function evaluateAndPersistTrust(
  client: PoolClient,
  input: EvaluateAndPersistTrustInput,
): Promise<EvaluateAndPersistTrustResult> {
  const context = input.safeContext ?? {};
  assertSafePersistedJsonObject('safeContext', context);

  const rule = await resolveActiveTrustRuleVersionForEvaluation(client);
  const collected = await collectConfiguredTrustSignals(client, {
    userId: input.userId,
    rule,
  });
  const evaluation = evaluateTrustSignals(rule.policyConfig, collected.signalFacts);

  const signalState = evaluation.contributions.map((item) => ({
    code: item.code,
    satisfied: item.satisfied,
    configuredWeight: item.configuredWeight,
    contribution: item.contribution,
  }));

  const signals: Record<string, unknown> = {
    ruleVersion: rule.ruleVersion,
    signalState,
    signalEvidence: collected.signalEvidence,
    context,
  };

  const snapshot = await persistTrustSnapshot(client, {
    userId: input.userId,
    trustState: evaluation.trustState,
    trustScore: evaluation.score,
    ruleVersion: rule.ruleVersion,
    reasonCodes: evaluation.reasonCodes,
    signals,
  });

  await client.query(
    `UPDATE users SET trust_state = $2::trust_state WHERE id = $1::uuid`,
    [input.userId, evaluation.trustState],
  );

  return {
    rule,
    signalFacts: collected.signalFacts,
    evaluation,
    snapshot,
  };
}
