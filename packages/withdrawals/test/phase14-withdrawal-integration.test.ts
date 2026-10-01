import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { WithdrawalDomainError, WithdrawalEngineConfig } from '../src/index.js';
import {
  createWithdrawalFromQuote,
  createWithdrawalQuote,
  decideWithdrawal,
  localWithdrawalEngineFixtureConfig,
  WITHDRAWAL_OWNER_REVIEW_REQUIRED_OUTBOX_EVENT,
} from '../src/index.js';
import {
  bindVerifiedPrimaryWallet,
  claimFounderForUser,
  createTestUser,
  engineConfig,
  fundUserAvailable,
  insertPhase14TestEligibilityPolicy,
  insertPhase14TestRiskRule,
  phase7DatabaseUrl,
  quoteAndCreate,
  resetAndMigrate,
  seedPhase14WithdrawalPolicies,
  seedPhase7Base,
  truncateWithdrawalTables,
  userBucketBalance,
} from './harness.js';

async function ledgerTxCount(pool: Pool): Promise<number> {
  const result = await pool.query<{ c: string }>(`SELECT count(*)::text AS c FROM ledger_transactions`);
  return Number(result.rows[0]?.c ?? '0');
}

async function volumeReservationCount(pool: Pool): Promise<number> {
  const result = await pool.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM withdrawal_volume_reservations`,
  );
  return Number(result.rows[0]?.c ?? '0');
}

describe.skipIf(phase7DatabaseUrl === '')('Phase 14 withdrawal risk/eligibility integration', () => {
  let pool: Pool;
  let assetId: string;
  let networkId: string;
  let adminUserId: string;
  let riskRuleVersion: number;

  beforeAll(async () => {
    await resetAndMigrate(phase7DatabaseUrl);
    pool = new Pool({ connectionString: phase7DatabaseUrl });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await truncateWithdrawalTables(pool);
    const base = await seedPhase7Base(pool);
    assetId = base.assetId;
    networkId = base.networkId;
    adminUserId = base.adminUserId;
    riskRuleVersion = base.riskRuleVersion;
  });

  it('no ACTIVE Risk rule → typed denial + no ledger mutation', async () => {
    await pool.query(`UPDATE risk_rule_versions SET status = 'REVOKED' WHERE status = 'ACTIVE'`);
    const userId = await createTestUser(pool, '14101');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '500000',
      key: randomUUID(),
    });
    const before = await ledgerTxCount(pool);
    const quote = await createWithdrawalQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      amountAtomic: '200000',
    });
    await expect(
      createWithdrawalFromQuote(pool, engineConfig, {
        authenticatedUserId: userId,
        quoteId: quote.id,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: 'RISK_POLICY_REQUIRED',
    } satisfies Partial<WithdrawalDomainError>);
    expect(await ledgerTxCount(pool)).toBe(before);
    expect(await volumeReservationCount(pool)).toBe(0);
  });

  it('no ACTIVE Eligibility policy → typed denial + no ledger mutation', async () => {
    await pool.query(
      `UPDATE eligibility_policy_versions SET status = 'REVOKED' WHERE status = 'ACTIVE'`,
    );
    const userId = await createTestUser(pool, '14102');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '500000',
      key: randomUUID(),
    });
    const before = await ledgerTxCount(pool);
    const quote = await createWithdrawalQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      amountAtomic: '200000',
    });
    await expect(
      createWithdrawalFromQuote(pool, engineConfig, {
        authenticatedUserId: userId,
        quoteId: quote.id,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: 'OWNER_POLICY_REQUIRED',
    } satisfies Partial<WithdrawalDomainError>);
    expect(await ledgerTxCount(pool)).toBe(before);
    expect(await volumeReservationCount(pool)).toBe(0);
  });

  it('account BLOCKED → no reservation', async () => {
    const userId = await createTestUser(pool, '14103');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '500000',
      key: randomUUID(),
    });
    const quote = await createWithdrawalQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      amountAtomic: '200000',
    });
    await pool.query(`UPDATE users SET withdrawal_status = 'BLOCKED' WHERE id = $1::uuid`, [
      userId,
    ]);
    const before = await ledgerTxCount(pool);
    await expect(
      createWithdrawalFromQuote(pool, engineConfig, {
        authenticatedUserId: userId,
        quoteId: quote.id,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_BLOCKED' });
    expect(await ledgerTxCount(pool)).toBe(before);
    expect(await userBucketBalance(pool, userId, assetId, 'USER_RESERVED_LIABILITY')).toBe(0n);
  });

  it('cooldown → no reservation', async () => {
    const userId = await createTestUser(pool, '14104');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '500000',
      key: randomUUID(),
    });
    const quote = await createWithdrawalQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      amountAtomic: '200000',
    });
    await pool.query(
      `UPDATE users SET withdrawal_cooldown_until = now() + interval '1 day' WHERE id = $1::uuid`,
      [userId],
    );
    const before = await ledgerTxCount(pool);
    await expect(
      createWithdrawalFromQuote(pool, engineConfig, {
        authenticatedUserId: userId,
        quoteId: quote.id,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'COOLDOWN_ACTIVE' });
    expect(await ledgerTxCount(pool)).toBe(before);
  });

  it('paused withdrawals → no reservation', async () => {
    await pool.query(
      `UPDATE feature_flags SET enabled = true
       WHERE flag_key = 'WITHDRAWAL_REQUESTS_PAUSE' AND environment = 'LOCAL'`,
    );
    const userId = await createTestUser(pool, '14105');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '500000',
      key: randomUUID(),
    });
    // Quote itself also checks pause — expect PAUSED on quote or create.
    const before = await ledgerTxCount(pool);
    await expect(
      createWithdrawalQuote(pool, engineConfig, {
        authenticatedUserId: userId,
        amountAtomic: '200000',
      }),
    ).rejects.toMatchObject({ code: 'PAUSED' });
    expect(await ledgerTxCount(pool)).toBe(before);
  });

  it('low Risk → MANUAL_REVIEW', async () => {
    const userId = await createTestUser(pool, '14106');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '500000',
      key: randomUUID(),
    });
    const { state } = await quoteAndCreate(pool, userId, '200000', randomUUID());
    expect(state).toBe('MANUAL_REVIEW');
  });

  it('Founder low Risk → MANUAL_REVIEW (no bypass)', async () => {
    const userId = await createTestUser(pool, '14107');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await claimFounderForUser(pool, userId);
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '500000',
      key: randomUUID(),
    });
    const { state } = await quoteAndCreate(pool, userId, '200000', randomUUID());
    expect(state).toBe('MANUAL_REVIEW');
  });

  it('Trust TRUSTED + low Risk → MANUAL_REVIEW', async () => {
    const userId = await createTestUser(pool, '14108');
    await pool.query(`UPDATE users SET trust_state = 'TRUSTED' WHERE id = $1::uuid`, [userId]);
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '500000',
      key: randomUUID(),
    });
    const { state } = await quoteAndCreate(pool, userId, '200000', randomUUID());
    expect(state).toBe('MANUAL_REVIEW');
  });

  it('HELD risk action → HELD with reserved funds', async () => {
    await pool.query(`UPDATE risk_rule_versions SET status = 'SUPERSEDED' WHERE status = 'ACTIVE'`);
    await insertPhase14TestRiskRule(pool, {
      ruleVersion: 14_050,
      actions: {
        LOW: 'HELD',
        MEDIUM: 'HELD',
        HIGH: 'HELD',
        CRITICAL: 'WITHDRAWAL_BLOCKED',
      },
    });
    const userId = await createTestUser(pool, '14109');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '500000',
      key: randomUUID(),
    });
    const { state, withdrawalId } = await quoteAndCreate(pool, userId, '200000', randomUUID());
    expect(state).toBe('HELD');
    expect(await userBucketBalance(pool, userId, assetId, 'USER_RESERVED_LIABILITY')).toBe(200000n);

    const outbox = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM outbox_events
       WHERE aggregate_id = $1::uuid AND event_type = $2`,
      [withdrawalId, WITHDRAWAL_OWNER_REVIEW_REQUIRED_OUTBOX_EVENT],
    );
    expect(outbox.rows[0]?.c).toBe('0');
  });

  it('RESTRICTED → HELD even when Risk would MANUAL_REVIEW', async () => {
    const userId = await createTestUser(pool, '14110');
    await pool.query(`UPDATE users SET withdrawal_status = 'RESTRICTED' WHERE id = $1::uuid`, [
      userId,
    ]);
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '500000',
      key: randomUUID(),
    });
    const { state } = await quoteAndCreate(pool, userId, '200000', randomUUID());
    expect(state).toBe('HELD');
    expect(await userBucketBalance(pool, userId, assetId, 'USER_RESERVED_LIABILITY')).toBe(200000n);
  });

  it('critical Risk action → eligibility denial + evidence + no money; never APPROVED', async () => {
    await pool.query(`UPDATE risk_rule_versions SET status = 'SUPERSEDED' WHERE status = 'ACTIVE'`);
    await insertPhase14TestRiskRule(pool, {
      ruleVersion: 14_060,
      actions: {
        LOW: 'WITHDRAWAL_BLOCKED',
        MEDIUM: 'WITHDRAWAL_BLOCKED',
        HIGH: 'WITHDRAWAL_BLOCKED',
        CRITICAL: 'WITHDRAWAL_BLOCKED',
      },
    });
    const userId = await createTestUser(pool, '14111');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '500000',
      key: randomUUID(),
    });
    const quote = await createWithdrawalQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      amountAtomic: '200000',
    });
    const before = await ledgerTxCount(pool);
    await expect(
      createWithdrawalFromQuote(pool, engineConfig, {
        authenticatedUserId: userId,
        quoteId: quote.id,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'ELIGIBILITY_DENIED' });

    expect(await ledgerTxCount(pool)).toBe(before);
    expect(await volumeReservationCount(pool)).toBe(0);
    const withdrawals = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM withdrawals WHERE user_id = $1::uuid`,
      [userId],
    );
    expect(withdrawals.rows[0]?.c).toBe('0');

    const decisions = await pool.query<{ outcome: string }>(
      `SELECT outcome::text AS outcome FROM eligibility_decisions
       WHERE user_id = $1::uuid AND action_type = 'WITHDRAWAL_REQUEST'
       ORDER BY decided_at DESC LIMIT 1`,
      [userId],
    );
    expect(decisions.rows[0]?.outcome).toMatch(/^INELIGIBLE_/);

    const snaps = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM risk_snapshots WHERE user_id = $1::uuid`,
      [userId],
    );
    expect(Number(snaps.rows[0]?.c ?? '0')).toBeGreaterThan(0);
  });

  it('eligibility denial persists decisions (+ risk snapshots) but no money', async () => {
    // Pause via FEATURE_FLAG gate after creating quote (quote path also checks pause).
    // Use ACCOUNT_STATE non-active instead: set status SUSPENDED after quote.
    const userId = await createTestUser(pool, '14112');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '500000',
      key: randomUUID(),
    });
    const quote = await createWithdrawalQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      amountAtomic: '200000',
    });
    // Soften hard wallet-gate: keep ACTIVE status but force FEATURE_FLAG denial by
    // replacing eligibility to deny RISK while still allowing ACCOUNT_STATE — use
    // risk action not in allowed list (covered above). Here: revoke eligibility and
    // reseed with riskAllowedActions excluding MANUAL_REVIEW so LOW score denies.
    await pool.query(
      `UPDATE eligibility_policy_versions SET status = 'SUPERSEDED' WHERE status = 'ACTIVE'`,
    );
    await insertPhase14TestEligibilityPolicy(pool, {
      policyVersion: 14_070,
      policyConfig: {
        actions: {
          WITHDRAWAL_REQUEST: {
            requiredGates: ['ACCOUNT_STATE', 'RISK_POLICY', 'FEATURE_FLAG'],
            precedence: ['RISK_POLICY', 'ACCOUNT_STATE', 'FEATURE_FLAG'],
            // Empty allowed → any risk action blocks
            riskAllowedActions: ['ALLOW'],
          },
          AD_SESSION_START: {
            requiredGates: ['ACCOUNT_STATE'],
            precedence: ['ACCOUNT_STATE'],
          },
          MISSION_CLAIM: {
            requiredGates: ['ACCOUNT_STATE', 'FEATURE_FLAG'],
            precedence: ['ACCOUNT_STATE', 'FEATURE_FLAG'],
          },
          TASK_CLAIM: {
            requiredGates: ['ACCOUNT_STATE'],
            precedence: ['ACCOUNT_STATE'],
          },
        },
      },
    });

    const before = await ledgerTxCount(pool);
    await expect(
      createWithdrawalFromQuote(pool, engineConfig, {
        authenticatedUserId: userId,
        quoteId: quote.id,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'ELIGIBILITY_DENIED' });
    expect(await ledgerTxCount(pool)).toBe(before);

    const decisions = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM eligibility_decisions WHERE user_id = $1::uuid`,
      [userId],
    );
    expect(Number(decisions.rows[0]?.c ?? '0')).toBeGreaterThan(0);
    const snaps = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM risk_snapshots WHERE user_id = $1::uuid`,
      [userId],
    );
    expect(Number(snaps.rows[0]?.c ?? '0')).toBeGreaterThan(0);
  });

  it('pins risk_snapshot_id + risk_policy_version from engine; config cannot override', async () => {
    const mismatchedConfig: WithdrawalEngineConfig = {
      ...localWithdrawalEngineFixtureConfig(),
      riskPolicyVersion: 999,
    };
    const userId = await createTestUser(pool, '14113');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '500000',
      key: randomUUID(),
    });
    const quote = await createWithdrawalQuote(pool, mismatchedConfig, {
      authenticatedUserId: userId,
      amountAtomic: '200000',
    });
    const w = await createWithdrawalFromQuote(pool, mismatchedConfig, {
      authenticatedUserId: userId,
      quoteId: quote.id,
      idempotencyKey: randomUUID(),
    });
    expect(w.state).toBe('MANUAL_REVIEW');

    const row = await pool.query<{
      risk_policy_version: number;
      risk_snapshot_id: string | null;
      eligibility_decision_id: string | null;
      approval_policy_version: number;
    }>(
      `SELECT risk_policy_version, risk_snapshot_id, eligibility_decision_id, approval_policy_version
       FROM withdrawals WHERE id = $1::uuid`,
      [w.id],
    );
    expect(row.rows[0]?.risk_policy_version).toBe(riskRuleVersion);
    expect(row.rows[0]?.risk_policy_version).not.toBe(999);
    expect(row.rows[0]?.approval_policy_version).toBe(999); // compat field only
    expect(row.rows[0]?.risk_snapshot_id).toBeTruthy();
    expect(row.rows[0]?.eligibility_decision_id).toBeTruthy();

    const snap = await pool.query<{ rule_version: number }>(
      `SELECT rule_version FROM risk_snapshots WHERE id = $1::uuid`,
      [row.rows[0]!.risk_snapshot_id],
    );
    expect(snap.rows[0]?.rule_version).toBe(riskRuleVersion);

    const approval = await decideWithdrawal(pool, mismatchedConfig, {
      withdrawalId: w.id,
      expectedState: 'MANUAL_REVIEW',
      decision: 'HOLD',
      trustedOwnerActorContext: { adminUserId },
      reason: 'pin-check',
      idempotencyKey: randomUUID(),
    });
    expect(approval.state).toBe('HELD');
    const approvalRow = await pool.query<{ policy_version: number }>(
      `SELECT policy_version FROM withdrawal_approvals WHERE id = $1::uuid`,
      [approval.approvalId],
    );
    expect(approvalRow.rows[0]?.policy_version).toBe(riskRuleVersion);
    expect(approvalRow.rows[0]?.policy_version).not.toBe(999);
  });

  it('release once / no auto payout on create', async () => {
    const userId = await createTestUser(pool, '14114');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '500000',
      key: randomUUID(),
    });
    const { withdrawalId, state } = await quoteAndCreate(pool, userId, '200000', randomUUID());
    expect(state).toBe('MANUAL_REVIEW');
    expect(state).not.toBe('APPROVED');
    expect(state).not.toBe('QUEUED');
    expect(state).not.toBe('BROADCASTED');

    await decideWithdrawal(pool, engineConfig, {
      withdrawalId,
      expectedState: 'MANUAL_REVIEW',
      decision: 'REJECT',
      trustedOwnerActorContext: { adminUserId },
      reason: 'release-once',
      idempotencyKey: randomUUID(),
    });
    expect(await userBucketBalance(pool, userId, assetId, 'USER_RESERVED_LIABILITY')).toBe(0n);

    const release = await pool.query<{ release_ledger_tx_id: string | null }>(
      `SELECT release_ledger_tx_id FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    expect(release.rows[0]?.release_ledger_tx_id).not.toBeNull();
  });

  it('seedPhase14WithdrawalPolicies helper reseeds after supersede', async () => {
    await pool.query(`UPDATE risk_rule_versions SET status = 'SUPERSEDED' WHERE status = 'ACTIVE'`);
    await pool.query(
      `UPDATE eligibility_policy_versions SET status = 'SUPERSEDED' WHERE status = 'ACTIVE'`,
    );
    const again = await seedPhase14WithdrawalPolicies(pool, {
      riskRuleVersion: 14_099,
      eligibilityPolicyVersion: 14_099,
    });
    expect(again.riskRuleVersion).toBe(14_099);
    expect(again.eligibilityPolicyVersion).toBe(14_099);
  });
});
