import type { EvaluateAndPersistRiskResult, RiskActionCode } from '@alex-rewards/fraud';
import type { PoolClient } from 'pg';

import { insertWithdrawalAuditLog, insertWithdrawalOutboxEvent } from './audit.js';
import type { WithdrawalEngineConfig } from './config.js';
import { WithdrawalDomainError } from './errors.js';
import {
  WITHDRAWAL_OWNER_REVIEW_REQUIRED_OUTBOX_EVENT,
  withdrawalOwnerReviewRequiredDedupeKey,
} from './outbox.js';
import { releaseWithdrawalReservation } from './release.js';
import { transitionWithdrawal } from './transitions.js';
import type { WithdrawalState } from './state-machine.js';

/** Stored on withdrawals.risk_decision (DB enum). Never APPROVED. */
export type V1RiskDecision =
  | 'MANUAL_REVIEW'
  | 'HELD'
  | 'REJECTED_PRE_BROADCAST'
  | 'WITHDRAWAL_BLOCKED';

type WorkflowOutcome =
  | { readonly kind: 'MANUAL_REVIEW'; riskDecision: 'MANUAL_REVIEW' }
  | { readonly kind: 'HELD'; riskDecision: V1RiskDecision; reason: string }
  | {
      readonly kind: 'REJECTED';
      riskDecision: 'REJECTED_PRE_BROADCAST';
      reason: string;
    };

/**
 * Map authoritative Risk action (+ RESTRICTED overlay) to withdrawal workflow.
 * NEVER auto-approves. ALLOW/EXTEND_PENDING/MANUAL_REVIEW → MANUAL_REVIEW.
 * Fail-safe HELD for WITHDRAWAL_BLOCKED / SUSPEND_EARNING / FREEZE_ACCOUNT
 * (does not mutate users.status / withdrawal_status).
 */
function mapRiskActionToWorkflow(
  action: RiskActionCode,
  restrictedHold: boolean,
): WorkflowOutcome {
  if (restrictedHold) {
    return {
      kind: 'HELD',
      riskDecision: 'HELD',
      reason: 'ACCOUNT_WITHDRAWAL_RESTRICTED',
    };
  }

  switch (action) {
    case 'ALLOW':
    case 'EXTEND_PENDING':
    case 'MANUAL_REVIEW':
      return { kind: 'MANUAL_REVIEW', riskDecision: 'MANUAL_REVIEW' };
    case 'HELD':
      return { kind: 'HELD', riskDecision: 'HELD', reason: 'RISK_ACTION_HELD' };
    case 'REJECTED_PRE_BROADCAST':
      return {
        kind: 'REJECTED',
        riskDecision: 'REJECTED_PRE_BROADCAST',
        reason: 'RISK_ACTION_REJECTED_PRE_BROADCAST',
      };
    case 'WITHDRAWAL_BLOCKED':
      return {
        kind: 'HELD',
        riskDecision: 'WITHDRAWAL_BLOCKED',
        reason: 'RISK_ACTION_WITHDRAWAL_BLOCKED_FAILSAFE_HOLD',
      };
    case 'SUSPEND_EARNING':
      return {
        kind: 'HELD',
        riskDecision: 'HELD',
        reason: 'RISK_ACTION_SUSPEND_EARNING_FAILSAFE_HOLD',
      };
    case 'FREEZE_ACCOUNT':
      return {
        kind: 'HELD',
        riskDecision: 'HELD',
        reason: 'RISK_ACTION_FREEZE_ACCOUNT_FAILSAFE_HOLD',
      };
    default: {
      const _exhaustive: never = action;
      return {
        kind: 'HELD',
        riskDecision: 'HELD',
        reason: `RISK_ACTION_UNKNOWN_FAILSAFE_HOLD:${String(_exhaustive)}`,
      };
    }
  }
}

/**
 * Attach preflight Risk + Eligibility evidence to a REQUESTED withdrawal.
 * Pins risk_policy_version from evaluation.ruleVersion (never config.riskPolicyVersion).
 * Does not re-evaluate Risk.
 */
export async function attachAuthoritativeRiskToWithdrawal(
  client: PoolClient,
  _config: WithdrawalEngineConfig,
  input: {
    readonly withdrawalId: string;
    readonly userId: string;
    readonly risk: EvaluateAndPersistRiskResult;
    readonly eligibilityDecisionId: string;
    readonly restrictedHold: boolean;
    readonly fromState?: WithdrawalState;
  },
): Promise<{ decision: V1RiskDecision; state: WithdrawalState }> {
  const from = input.fromState ?? 'REQUESTED';
  if (from !== 'REQUESTED') {
    throw new WithdrawalDomainError('STATE_CONFLICT', 'Risk attach expects REQUESTED');
  }

  const ruleVersion = input.risk.evaluation.ruleVersion;
  if (!Number.isInteger(ruleVersion) || ruleVersion <= 0) {
    throw new WithdrawalDomainError(
      'RISK_POLICY_REQUIRED',
      'Authoritative risk evaluation missing ruleVersion',
    );
  }
  const snapshotId = input.risk.snapshot.id;
  if (typeof snapshotId !== 'string' || snapshotId.trim() === '') {
    throw new WithdrawalDomainError(
      'RISK_POLICY_REQUIRED',
      'Authoritative risk evaluation missing snapshot id',
    );
  }
  if (input.eligibilityDecisionId.trim() === '') {
    throw new WithdrawalDomainError(
      'OWNER_POLICY_REQUIRED',
      'eligibilityDecisionId is required',
    );
  }

  await transitionWithdrawal(client, {
    id: input.withdrawalId,
    from: 'REQUESTED',
    to: 'RISK_CHECK',
  });

  const workflow = mapRiskActionToWorkflow(
    input.risk.evaluation.action,
    input.restrictedHold,
  );

  if (workflow.kind === 'REJECTED') {
    await transitionWithdrawal(client, {
      id: input.withdrawalId,
      from: 'RISK_CHECK',
      to: 'REJECTED',
      riskPolicyVersion: ruleVersion,
      riskDecision: workflow.riskDecision,
      riskSnapshotId: snapshotId,
      eligibilityDecisionId: input.eligibilityDecisionId,
    });
    await releaseWithdrawalReservation(client, { withdrawalId: input.withdrawalId });
    await insertWithdrawalAuditLog(client, {
      actionType: 'WITHDRAWAL_RISK_REJECTED_PRE_BROADCAST',
      resourceType: 'withdrawal',
      resourceId: input.withdrawalId,
      actorType: 'SYSTEM',
      afterSnapshot: {
        decision: workflow.riskDecision,
        state: 'REJECTED',
        reason: workflow.reason,
        riskAction: input.risk.evaluation.action,
        ruleVersion,
      },
    });
    return { decision: workflow.riskDecision, state: 'REJECTED' };
  }

  if (workflow.kind === 'HELD') {
    await transitionWithdrawal(client, {
      id: input.withdrawalId,
      from: 'RISK_CHECK',
      to: 'HELD',
      riskPolicyVersion: ruleVersion,
      riskDecision: workflow.riskDecision,
      riskSnapshotId: snapshotId,
      eligibilityDecisionId: input.eligibilityDecisionId,
    });
    await insertWithdrawalAuditLog(client, {
      actionType: 'WITHDRAWAL_RISK_HELD',
      resourceType: 'withdrawal',
      resourceId: input.withdrawalId,
      actorType: 'SYSTEM',
      afterSnapshot: {
        decision: workflow.riskDecision,
        state: 'HELD',
        reason: workflow.reason,
        riskAction: input.risk.evaluation.action,
        restrictedHold: input.restrictedHold,
        ruleVersion,
      },
    });
    return { decision: workflow.riskDecision, state: 'HELD' };
  }

  // MANUAL_REVIEW — never APPROVED. Owner-review Outbox only.
  await transitionWithdrawal(client, {
    id: input.withdrawalId,
    from: 'RISK_CHECK',
    to: 'MANUAL_REVIEW',
    riskPolicyVersion: ruleVersion,
    riskDecision: 'MANUAL_REVIEW',
    riskSnapshotId: snapshotId,
    eligibilityDecisionId: input.eligibilityDecisionId,
  });
  await insertWithdrawalAuditLog(client, {
    actionType: 'WITHDRAWAL_RISK_MANUAL_REVIEW',
    resourceType: 'withdrawal',
    resourceId: input.withdrawalId,
    actorType: 'SYSTEM',
    afterSnapshot: {
      decision: 'MANUAL_REVIEW',
      state: 'MANUAL_REVIEW',
      riskAction: input.risk.evaluation.action,
      ruleVersion,
    },
  });
  await insertWithdrawalOutboxEvent(client, {
    aggregateType: 'withdrawal',
    aggregateId: input.withdrawalId,
    eventType: WITHDRAWAL_OWNER_REVIEW_REQUIRED_OUTBOX_EVENT,
    dedupeKey: withdrawalOwnerReviewRequiredDedupeKey(input.withdrawalId, 'MANUAL_REVIEW'),
    payload: {
      withdrawalId: input.withdrawalId,
      expectedState: 'MANUAL_REVIEW',
    },
  });
  return { decision: 'MANUAL_REVIEW', state: 'MANUAL_REVIEW' };
}

/**
 * Legacy V1 fabricated risk scores (10/80/100) removed.
 * Callers must use Phase 14 preflight + attachAuthoritativeRiskToWithdrawal.
 */
export async function applyV1RiskPolicy(
  _client: PoolClient,
  _config: WithdrawalEngineConfig,
  _input: {
    readonly withdrawalId: string;
    readonly userId: string;
    readonly fromState?: WithdrawalState;
  },
): Promise<{ decision: V1RiskDecision; state: WithdrawalState }> {
  throw new WithdrawalDomainError(
    'CONFIG',
    'legacy V1 risk fabrication removed; use Phase 14 preflight',
  );
}
