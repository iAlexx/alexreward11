import {
  getOrCreateLedgerAccount,
  LedgerDomainError,
  postLedgerTransaction,
} from '@alex-rewards/ledger';
import type { PoolClient } from 'pg';

import { insertWithdrawalAuditLog } from './audit.js';
import { atomicToString } from './arithmetic.js';
import { assertWithdrawalEngineConfig, type WithdrawalEngineConfig } from './config.js';
import { withWithdrawalTransaction, type WithdrawalDb } from './db.js';
import { WithdrawalDomainError } from './errors.js';
import { assertWithdrawalRequestsAllowed } from './flags.js';
import { applyV1RiskPolicy } from './risk.js';
import type { LimitRuleRow } from './rules.js';
import type { WithdrawalState } from './state-machine.js';
import { requireEligiblePrimaryWallet } from './wallet-gate.js';
import { reserveWithdrawalVolume, resolveSinglePayoutHotWallet } from './volume.js';

export interface WithdrawalView {
  readonly id: string;
  readonly publicId: string;
  readonly userId: string;
  readonly quoteId: string;
  readonly state: WithdrawalState;
  readonly requestedAmountAtomic: string;
  readonly feeAmountAtomic: string;
  readonly netAmountAtomic: string;
  readonly priorityReview: boolean;
  readonly riskDecision: string | null;
  readonly workflowId: string | null;
}

function idempotencyScopeForUser(userId: string): string {
  return `user:${userId}:withdrawal`;
}

function intentsMatch(
  a: {
    readonly userId: string;
    readonly quoteId: string;
    readonly requestedAmountAtomic: string;
    readonly feeAmountAtomic: string;
    readonly netAmountAtomic: string;
  },
  b: {
    readonly userId: string;
    readonly quoteId: string;
    readonly requestedAmountAtomic: string;
    readonly feeAmountAtomic: string;
    readonly netAmountAtomic: string;
  },
): boolean {
  return (
    a.userId === b.userId &&
    a.quoteId === b.quoteId &&
    a.requestedAmountAtomic === b.requestedAmountAtomic &&
    a.feeAmountAtomic === b.feeAmountAtomic &&
    a.netAmountAtomic === b.netAmountAtomic
  );
}

async function loadLimitRuleById(client: PoolClient, limitRuleId: string): Promise<LimitRuleRow> {
  const result = await client.query<{
    id: string;
    rule_version: number;
    risk_tier: string | null;
    min_withdrawal_atomic: string;
    max_single_withdrawal_atomic: string;
    max_user_hourly_atomic: string;
    max_user_daily_atomic: string;
    max_hot_wallet_hourly_atomic: string;
    max_hot_wallet_daily_atomic: string;
    max_auto_payout_atomic: string | null;
    wallet_change_cooldown_seconds: number;
  }>(
    `SELECT id, rule_version, risk_tier::text AS risk_tier,
            min_withdrawal_atomic::text, max_single_withdrawal_atomic::text,
            max_user_hourly_atomic::text, max_user_daily_atomic::text,
            max_hot_wallet_hourly_atomic::text, max_hot_wallet_daily_atomic::text,
            max_auto_payout_atomic::text, wallet_change_cooldown_seconds
     FROM withdrawal_limit_rules
     WHERE id = $1::uuid
     FOR SHARE`,
    [limitRuleId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new WithdrawalDomainError('LIMIT_RULE_NOT_FOUND', 'Quote limit rule no longer exists');
  }
  return {
    id: row.id,
    ruleVersion: row.rule_version,
    riskTier: row.risk_tier,
    minWithdrawalAtomic: BigInt(row.min_withdrawal_atomic),
    maxSingleWithdrawalAtomic: BigInt(row.max_single_withdrawal_atomic),
    maxUserHourlyAtomic: BigInt(row.max_user_hourly_atomic),
    maxUserDailyAtomic: BigInt(row.max_user_daily_atomic),
    maxHotWalletHourlyAtomic: BigInt(row.max_hot_wallet_hourly_atomic),
    maxHotWalletDailyAtomic: BigInt(row.max_hot_wallet_daily_atomic),
    maxAutoPayoutAtomic:
      row.max_auto_payout_atomic === null ? null : BigInt(row.max_auto_payout_atomic),
    walletChangeCooldownSeconds: row.wallet_change_cooldown_seconds,
  };
}

function mapWithdrawal(row: {
  id: string;
  public_id: string;
  user_id: string;
  withdrawal_quote_id: string;
  state: WithdrawalState;
  requested_amount_atomic: string;
  fee_amount_atomic: string;
  net_amount_atomic: string;
  priority_review: boolean;
  risk_decision: string | null;
  workflow_id: string | null;
}): WithdrawalView {
  return {
    id: row.id,
    publicId: row.public_id,
    userId: row.user_id,
    quoteId: row.withdrawal_quote_id,
    state: row.state,
    requestedAmountAtomic: row.requested_amount_atomic,
    feeAmountAtomic: row.fee_amount_atomic,
    netAmountAtomic: row.net_amount_atomic,
    priorityReview: row.priority_review,
    riskDecision: row.risk_decision,
    workflowId: row.workflow_id,
  };
}

const WITHDRAWAL_SELECT = `id, public_id, user_id, withdrawal_quote_id, state,
  requested_amount_atomic::text, fee_amount_atomic::text, net_amount_atomic::text,
  priority_review, risk_decision::text AS risk_decision, workflow_id`;

export async function createWithdrawalFromQuote(
  db: WithdrawalDb,
  config: WithdrawalEngineConfig,
  input: {
    readonly authenticatedUserId: string;
    readonly quoteId: string;
    readonly idempotencyKey: string;
  },
): Promise<WithdrawalView> {
  assertWithdrawalEngineConfig(config);
  if (input.idempotencyKey.trim() === '') {
    throw new WithdrawalDomainError('VALIDATION', 'idempotencyKey is required');
  }
  const scope = idempotencyScopeForUser(input.authenticatedUserId);

  return withWithdrawalTransaction(db, async (client) => {
    const existing = await client.query<{
      id: string;
      public_id: string;
      user_id: string;
      withdrawal_quote_id: string;
      state: WithdrawalState;
      requested_amount_atomic: string;
      fee_amount_atomic: string;
      net_amount_atomic: string;
      priority_review: boolean;
      risk_decision: string | null;
      workflow_id: string | null;
    }>(
      `SELECT ${WITHDRAWAL_SELECT}
       FROM withdrawals
       WHERE idempotency_scope = $1 AND idempotency_key = $2
       FOR SHARE`,
      [scope, input.idempotencyKey],
    );
    if (existing.rows[0] !== undefined) {
      const row = existing.rows[0];
      // Intent: same quoteId + userId + amounts (amounts frozen on the withdrawal from quote).
      if (
        !intentsMatch(
          {
            userId: input.authenticatedUserId,
            quoteId: input.quoteId,
            requestedAmountAtomic: row.requested_amount_atomic,
            feeAmountAtomic: row.fee_amount_atomic,
            netAmountAtomic: row.net_amount_atomic,
          },
          {
            userId: row.user_id,
            quoteId: row.withdrawal_quote_id,
            requestedAmountAtomic: row.requested_amount_atomic,
            feeAmountAtomic: row.fee_amount_atomic,
            netAmountAtomic: row.net_amount_atomic,
          },
        ) ||
        row.withdrawal_quote_id !== input.quoteId ||
        row.user_id !== input.authenticatedUserId
      ) {
        throw new WithdrawalDomainError(
          'IDEMPOTENCY_CONFLICT',
          'Idempotency key reused with different intent',
        );
      }
      return mapWithdrawal(row);
    }

    const quote = await client.query<{
      id: string;
      user_id: string;
      asset_id: string;
      network_id: string;
      primary_wallet_id: string;
      requested_amount_atomic: string;
      fee_amount_atomic: string;
      net_amount_atomic: string;
      fee_rule_id: string;
      fee_rule_version: number;
      limit_rule_id: string | null;
      limit_rule_version: number | null;
      base_platform_fee_atomic: string | null;
      membership_fee_discount_bps: number;
      user_membership_id: string | null;
      fee_entitlement_rule_version_id: string | null;
      priority_entitlement_rule_version_id: string | null;
      priority_review: boolean;
      status: string;
      expires_at: Date;
    }>(
      `SELECT id, user_id, asset_id, network_id, primary_wallet_id,
              requested_amount_atomic::text, fee_amount_atomic::text, net_amount_atomic::text,
              fee_rule_id, fee_rule_version, limit_rule_id, limit_rule_version,
              base_platform_fee_atomic::text, membership_fee_discount_bps,
              user_membership_id, fee_entitlement_rule_version_id,
              priority_entitlement_rule_version_id, priority_review,
              status::text AS status, expires_at
       FROM withdrawal_quotes
       WHERE id = $1::uuid
       FOR UPDATE`,
      [input.quoteId],
    );
    const q = quote.rows[0];
    if (q === undefined) {
      throw new WithdrawalDomainError('QUOTE_NOT_FOUND', 'Quote not found');
    }
    if (q.user_id !== input.authenticatedUserId) {
      throw new WithdrawalDomainError('UNAUTHORIZED', 'Authentication required');
    }
    if (q.status === 'CONSUMED') {
      throw new WithdrawalDomainError('QUOTE_CONSUMED', 'Quote already consumed');
    }
    if (q.status === 'CANCELLED' || q.status === 'EXPIRED') {
      throw new WithdrawalDomainError('QUOTE_NOT_OPEN', 'Quote is not open');
    }
    if (q.status !== 'OPEN') {
      throw new WithdrawalDomainError('QUOTE_NOT_OPEN', 'Quote is not open');
    }
    if (q.expires_at.getTime() <= Date.now()) {
      await client.query(
        `UPDATE withdrawal_quotes SET status = 'EXPIRED', updated_at = now()
         WHERE id = $1::uuid AND status = 'OPEN'`,
        [q.id],
      );
      throw new WithdrawalDomainError('QUOTE_EXPIRED', 'Quote expired');
    }
    if (q.limit_rule_id === null || q.limit_rule_version === null) {
      throw new WithdrawalDomainError('CONFIG', 'Quote missing limit rule provenance');
    }

    await requireEligiblePrimaryWallet(client, {
      userId: input.authenticatedUserId,
      networkId: q.network_id,
      expectedWalletId: q.primary_wallet_id,
    });

    await assertWithdrawalRequestsAllowed(client, config.deploymentEnvironment);

    const limits = await loadLimitRuleById(client, q.limit_rule_id);
    const gross = BigInt(q.requested_amount_atomic);
    if (gross < limits.minWithdrawalAtomic || gross > limits.maxSingleWithdrawalAtomic) {
      throw new WithdrawalDomainError(
        'LIMIT_EXCEEDED',
        'Gross amount outside single-withdrawal limits',
      );
    }

    const hotWallet = await resolveSinglePayoutHotWallet(client, q.network_id, {
      fakeChainEnabled: config.fakeChainEnabled,
    });
    const asOf = new Date();

    let w: {
      id: string;
      public_id: string;
      user_id: string;
      withdrawal_quote_id: string;
      state: WithdrawalState;
      requested_amount_atomic: string;
      fee_amount_atomic: string;
      net_amount_atomic: string;
      priority_review: boolean;
      risk_decision: string | null;
      workflow_id: string | null;
    };

    try {
      const inserted = await client.query<{
        id: string;
        public_id: string;
        user_id: string;
        withdrawal_quote_id: string;
        state: WithdrawalState;
        requested_amount_atomic: string;
        fee_amount_atomic: string;
        net_amount_atomic: string;
        priority_review: boolean;
        risk_decision: string | null;
        workflow_id: string | null;
      }>(
        `INSERT INTO withdrawals (
           user_id, withdrawal_quote_id, asset_id, network_id, wallet_id,
           requested_amount_atomic, fee_amount_atomic, net_amount_atomic,
           state, approval_policy_version, priority_review,
           idempotency_scope, idempotency_key,
           limit_rule_id, fee_rule_id, fee_rule_version, limit_rule_version,
           base_platform_fee_atomic, membership_fee_discount_bps,
           user_membership_id, fee_entitlement_rule_version_id,
           priority_entitlement_rule_version_id, hot_wallet_id
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
           $6::bigint, $7::bigint, $8::bigint,
           'REQUESTED', $9, $10,
           $11, $12,
           $13::uuid, $14::uuid, $15, $16,
           $17::bigint, $18,
           $19::uuid, $20::uuid,
           $21::uuid, $22::uuid
         )
         RETURNING ${WITHDRAWAL_SELECT}`,
        [
          input.authenticatedUserId,
          q.id,
          q.asset_id,
          q.network_id,
          q.primary_wallet_id,
          q.requested_amount_atomic,
          q.fee_amount_atomic,
          q.net_amount_atomic,
          config.riskPolicyVersion,
          q.priority_review,
          scope,
          input.idempotencyKey,
          q.limit_rule_id,
          q.fee_rule_id,
          q.fee_rule_version,
          q.limit_rule_version,
          q.base_platform_fee_atomic ?? q.fee_amount_atomic,
          q.membership_fee_discount_bps,
          q.user_membership_id,
          q.fee_entitlement_rule_version_id,
          q.priority_entitlement_rule_version_id,
          hotWallet.id,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) {
        throw new WithdrawalDomainError('INTERNAL', 'withdrawal insert failed');
      }
      w = row;
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: string }).code === '23505'
      ) {
        // Unique quote conflict — recover original if same idempotency, else fail.
        const byQuote = await client.query<{
          id: string;
          public_id: string;
          user_id: string;
          withdrawal_quote_id: string;
          state: WithdrawalState;
          requested_amount_atomic: string;
          fee_amount_atomic: string;
          net_amount_atomic: string;
          priority_review: boolean;
          risk_decision: string | null;
          workflow_id: string | null;
          idempotency_scope: string;
          idempotency_key: string;
        }>(
          `SELECT ${WITHDRAWAL_SELECT}, idempotency_scope, idempotency_key
           FROM withdrawals
           WHERE withdrawal_quote_id = $1::uuid
           FOR SHARE`,
          [q.id],
        );
        const recovered = byQuote.rows[0];
        if (
          recovered !== undefined &&
          recovered.idempotency_scope === scope &&
          recovered.idempotency_key === input.idempotencyKey
        ) {
          return mapWithdrawal(recovered);
        }
        const byKey = await client.query<{
          id: string;
          public_id: string;
          user_id: string;
          withdrawal_quote_id: string;
          state: WithdrawalState;
          requested_amount_atomic: string;
          fee_amount_atomic: string;
          net_amount_atomic: string;
          priority_review: boolean;
          risk_decision: string | null;
          workflow_id: string | null;
        }>(
          `SELECT ${WITHDRAWAL_SELECT}
           FROM withdrawals
           WHERE idempotency_scope = $1 AND idempotency_key = $2
           FOR SHARE`,
          [scope, input.idempotencyKey],
        );
        if (byKey.rows[0] !== undefined && byKey.rows[0].withdrawal_quote_id === q.id) {
          return mapWithdrawal(byKey.rows[0]);
        }
        throw new WithdrawalDomainError(
          'IDEMPOTENCY_CONFLICT',
          'Quote already consumed by a different withdrawal',
          { cause: error },
        );
      }
      throw error;
    }

    await reserveWithdrawalVolume(client, {
      withdrawalId: w.id,
      userId: input.authenticatedUserId,
      hotWalletId: hotWallet.id,
      assetId: q.asset_id,
      networkId: q.network_id,
      grossAtomic: gross,
      limits,
      asOf,
    });

    const available = await getOrCreateLedgerAccount(client, {
      accountType: 'USER_AVAILABLE_LIABILITY',
      assetId: q.asset_id,
      ownerId: input.authenticatedUserId,
    });
    const reserved = await getOrCreateLedgerAccount(client, {
      accountType: 'USER_RESERVED_LIABILITY',
      assetId: q.asset_id,
      ownerId: input.authenticatedUserId,
    });

    let reservationTxId: string;
    try {
      const reservationTx = await postLedgerTransaction(client, {
        transactionType: 'WITHDRAWAL_RESERVATION',
        businessReferenceType: 'withdrawal',
        businessReferenceId: w.id,
        idempotencyScope: `withdrawal-reservation:${w.id}`,
        idempotencyKey: 'reservation',
        assetId: q.asset_id,
        entries: [
          {
            ledgerAccountId: available.id,
            direction: 'DEBIT',
            amountAtomic: q.requested_amount_atomic,
          },
          {
            ledgerAccountId: reserved.id,
            direction: 'CREDIT',
            amountAtomic: q.requested_amount_atomic,
          },
        ],
      });
      reservationTxId = reservationTx.id;
    } catch (error) {
      if (error instanceof LedgerDomainError && error.code === 'NEGATIVE_PROTECTED_BALANCE') {
        throw new WithdrawalDomainError(
          'INSUFFICIENT_AVAILABLE',
          'Insufficient available balance',
          {
            cause: error,
          },
        );
      }
      throw error;
    }

    // Set-once reservation_ledger_tx_id
    await client.query(
      `UPDATE withdrawals
       SET reservation_ledger_tx_id = $2::uuid, updated_at = now()
       WHERE id = $1::uuid AND reservation_ledger_tx_id IS NULL`,
      [w.id, reservationTxId],
    );

    await client.query(
      `UPDATE withdrawal_quotes
       SET status = 'CONSUMED', consumed_at = now(), updated_at = now()
       WHERE id = $1::uuid AND status = 'OPEN'`,
      [q.id],
    );

    const risk = await applyV1RiskPolicy(client, config, {
      withdrawalId: w.id,
      userId: input.authenticatedUserId,
      fromState: 'REQUESTED',
    });

    await insertWithdrawalAuditLog(client, {
      actionType: 'WITHDRAWAL_CREATED',
      resourceType: 'withdrawal',
      resourceId: w.id,
      actorType: 'USER',
      afterSnapshot: {
        state: risk.state,
        gross: atomicToString(gross),
        quoteId: q.id,
        riskDecision: risk.decision,
      },
    });

    const refreshed = await client.query<{
      id: string;
      public_id: string;
      user_id: string;
      withdrawal_quote_id: string;
      state: WithdrawalState;
      requested_amount_atomic: string;
      fee_amount_atomic: string;
      net_amount_atomic: string;
      priority_review: boolean;
      risk_decision: string | null;
      workflow_id: string | null;
    }>(`SELECT ${WITHDRAWAL_SELECT} FROM withdrawals WHERE id = $1::uuid`, [w.id]);
    const final = refreshed.rows[0];
    if (final === undefined) {
      throw new WithdrawalDomainError('INTERNAL', 'withdrawal missing after create');
    }
    return mapWithdrawal(final);
  });
}
