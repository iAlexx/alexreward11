import type { PoolClient } from 'pg';

import { insertWithdrawalAuditLog } from './audit.js';
import type { WithdrawalEngineConfig } from './config.js';
import { WithdrawalDomainError } from './errors.js';
import { releaseWithdrawalReservation } from './release.js';
import { transitionWithdrawal } from './transitions.js';
import type { WithdrawalState } from './state-machine.js';

export type V1RiskDecision =
  'MANUAL_REVIEW' | 'HELD' | 'REJECTED_PRE_BROADCAST' | 'WITHDRAWAL_BLOCKED';

/**
 * V1 risk policy: never auto-approves.
 * Ordinary / LOW → MANUAL_REVIEW.
 * BLOCKED account → WITHDRAWAL_BLOCKED → REJECTED (+ release).
 * RESTRICTED → HELD (manual).
 */
export async function applyV1RiskPolicy(
  client: PoolClient,
  config: WithdrawalEngineConfig,
  input: {
    readonly withdrawalId: string;
    readonly userId: string;
    readonly fromState?: WithdrawalState;
  },
): Promise<{ decision: V1RiskDecision; state: WithdrawalState }> {
  const from = input.fromState ?? 'REQUESTED';
  if (from !== 'REQUESTED') {
    throw new WithdrawalDomainError('STATE_CONFLICT', 'Risk policy expects REQUESTED');
  }

  await transitionWithdrawal(client, {
    id: input.withdrawalId,
    from: 'REQUESTED',
    to: 'RISK_CHECK',
  });

  const user = await client.query<{
    withdrawal_status: string;
    status: string;
  }>(
    `SELECT withdrawal_status::text AS withdrawal_status, status::text AS status
     FROM users WHERE id = $1::uuid FOR SHARE`,
    [input.userId],
  );
  const u = user.rows[0];
  if (u === undefined) {
    throw new WithdrawalDomainError('UNAUTHORIZED', 'Authentication required');
  }

  let decision: V1RiskDecision = 'MANUAL_REVIEW';
  let riskTier: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' = 'LOW';
  let score = 10;
  let reasonCodes: string[] = ['V1_ORDINARY_MANUAL_REVIEW'];

  if (u.withdrawal_status === 'BLOCKED' || u.status === 'SUSPENDED') {
    decision = 'WITHDRAWAL_BLOCKED';
    riskTier = 'CRITICAL';
    score = 100;
    reasonCodes = ['ACCOUNT_WITHDRAWAL_BLOCKED'];
  } else if (u.withdrawal_status === 'RESTRICTED') {
    decision = 'HELD';
    riskTier = 'HIGH';
    score = 80;
    reasonCodes = ['ACCOUNT_WITHDRAWAL_RESTRICTED'];
  }

  const snapshot = await client.query<{ id: string }>(
    `INSERT INTO risk_snapshots (
       user_id, decision_scope, score, risk_tier, rule_version,
       reason_codes, safe_inputs, outputs
     ) VALUES (
       $1::uuid, 'WITHDRAWAL_REQUEST', $2, $3::risk_tier, $4,
       $5::text[], $6::jsonb, $7::jsonb
     )
     RETURNING id`,
    [
      input.userId,
      score,
      riskTier,
      config.riskPolicyVersion,
      reasonCodes,
      JSON.stringify({ withdrawalId: input.withdrawalId }),
      JSON.stringify({ decision, neverAutoApprove: true }),
    ],
  );
  const snapshotId = snapshot.rows[0]?.id;
  if (snapshotId === undefined) {
    throw new WithdrawalDomainError('INTERNAL', 'risk snapshot insert failed');
  }

  if (decision === 'WITHDRAWAL_BLOCKED') {
    await transitionWithdrawal(client, {
      id: input.withdrawalId,
      from: 'RISK_CHECK',
      to: 'REJECTED',
      riskPolicyVersion: config.riskPolicyVersion,
      riskDecision: decision,
      riskSnapshotId: snapshotId,
    });
    await releaseWithdrawalReservation(client, { withdrawalId: input.withdrawalId });
    await insertWithdrawalAuditLog(client, {
      actionType: 'WITHDRAWAL_RISK_BLOCKED',
      resourceType: 'withdrawal',
      resourceId: input.withdrawalId,
      actorType: 'SYSTEM',
      afterSnapshot: { decision, state: 'REJECTED' },
    });
    return { decision, state: 'REJECTED' };
  }

  if (decision === 'HELD') {
    await transitionWithdrawal(client, {
      id: input.withdrawalId,
      from: 'RISK_CHECK',
      to: 'HELD',
      riskPolicyVersion: config.riskPolicyVersion,
      riskDecision: decision,
      riskSnapshotId: snapshotId,
    });
    await insertWithdrawalAuditLog(client, {
      actionType: 'WITHDRAWAL_RISK_HELD',
      resourceType: 'withdrawal',
      resourceId: input.withdrawalId,
      actorType: 'SYSTEM',
      afterSnapshot: { decision, state: 'HELD' },
    });
    return { decision, state: 'HELD' };
  }

  // Never APPROVED under V1.
  await transitionWithdrawal(client, {
    id: input.withdrawalId,
    from: 'RISK_CHECK',
    to: 'MANUAL_REVIEW',
    riskPolicyVersion: config.riskPolicyVersion,
    riskDecision: 'MANUAL_REVIEW',
    riskSnapshotId: snapshotId,
  });
  await insertWithdrawalAuditLog(client, {
    actionType: 'WITHDRAWAL_RISK_MANUAL_REVIEW',
    resourceType: 'withdrawal',
    resourceId: input.withdrawalId,
    actorType: 'SYSTEM',
    afterSnapshot: { decision: 'MANUAL_REVIEW', state: 'MANUAL_REVIEW' },
  });
  return { decision: 'MANUAL_REVIEW', state: 'MANUAL_REVIEW' };
}
