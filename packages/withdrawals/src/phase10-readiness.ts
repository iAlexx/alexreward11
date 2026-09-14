import type { Pool, PoolClient } from 'pg';

import type { DeploymentEnvironment } from './config.js';
import { isPool } from './db.js';
import { isPayoutDispatchPaused } from './flags.js';
import {
  buildPhase10PayoutConfig,
  listPhase10MissingResources,
  type Phase10ConfigInput,
  type Phase10PayoutConfig,
} from './phase10-config.js';
import { WITHDRAWAL_APPROVED_OUTBOX_EVENT } from './outbox.js';

export type Phase10ReadinessStatus = 'PASS' | 'WARN' | 'BLOCKED';

export type Phase10ReadinessClassification =
  | 'ok'
  | 'intentionally_safe_off'
  | 'misconfigured'
  | 'operator_attention';

export interface Phase10ReadinessItem {
  readonly code: string;
  readonly status: Phase10ReadinessStatus;
  readonly message: string;
  readonly classification: Phase10ReadinessClassification;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface Phase10ReadinessConfig {
  readonly deploymentEnvironment: DeploymentEnvironment;
  readonly fakeChainEnabled: boolean;
  readonly realChainEnabled: boolean;
  readonly acceptedNetworkCode: string;
  readonly usdtSymbol: string;
  readonly phase10?: Phase10ConfigInput | Phase10PayoutConfig;
  readonly controlledUserId?: string | null;
  /** Optional observed signer lock state; null/undefined means not probed. */
  readonly signerLocked?: boolean | null;
  readonly signerBaseUrlConfigured?: boolean;
  readonly signerServiceTokenConfigured?: boolean;
}

export interface Phase10ReadinessReport {
  readonly overall: Phase10ReadinessStatus;
  readonly items: readonly Phase10ReadinessItem[];
  readonly summary: {
    readonly deploymentEnvironment: DeploymentEnvironment;
    readonly fakeChainEnabled: boolean;
    readonly realChainEnabled: boolean;
    readonly acceptedNetworkCode: string;
    readonly usdtSymbol: string;
    readonly withdrawalRequestsPaused: boolean | null;
    readonly payoutDispatchPaused: boolean | null;
    readonly networkId: string | null;
    readonly assetId: string | null;
    readonly feeRule: {
      readonly id: string;
      readonly ruleVersion: number;
      readonly fixedFeeAtomic: string;
    } | null;
    readonly limitRule: {
      readonly id: string;
      readonly ruleVersion: number;
      readonly minWithdrawalAtomic: string;
      readonly maxSingleWithdrawalAtomic: string;
      readonly walletChangeCooldownSeconds: number;
    } | null;
    readonly controlledUser: {
      readonly userId: string;
      readonly status: string;
      readonly withdrawalStatus: string;
      readonly cooldownUntil: string | null;
      readonly cooldownActive: boolean;
      readonly primaryWallet: {
        readonly id: string;
        readonly verificationMethod: string | null;
        readonly verified: boolean;
        readonly friendlyAddress: string | null;
      } | null;
      readonly balancesAtomic: {
        readonly available: string;
        readonly pending: string;
        readonly reserved: string;
      };
    } | null;
    readonly hotWallet: {
      readonly id: string;
      readonly address: string;
      readonly friendlyAddress: string | null;
      readonly signerType: string;
      readonly signerReferencePresent: boolean;
      readonly payoutJettonWalletAddress: string | null;
      readonly status: string;
      readonly walletVersion: string;
    } | null;
    readonly providerConfig: {
      readonly jettonMasterConfigured: boolean;
      readonly primary: { readonly kind: string | null; readonly urlConfigured: boolean };
      readonly secondary: { readonly kind: string | null; readonly urlConfigured: boolean };
      readonly primarySecondaryIndependent: boolean;
    };
    readonly signer: {
      readonly baseUrlConfigured: boolean;
      readonly serviceTokenConfigured: boolean;
      readonly locked: boolean | null;
    };
    readonly syntheticUnknownIsolation: {
      readonly scannedAttempts: number;
      readonly withPendingApprovedOutbox: number;
      readonly isolated: boolean;
      readonly attemptIds: readonly string[];
    };
    readonly passCount: number;
    readonly warnCount: number;
    readonly blockedCount: number;
  };
}

function asPhase10Config(
  input: Phase10ConfigInput | Phase10PayoutConfig | undefined,
  readiness: Phase10ReadinessConfig,
): Phase10PayoutConfig {
  if (input !== undefined && 'primaryProvider' in input && 'networkGlobalId' in input) {
    return input;
  }
  return buildPhase10PayoutConfig({
    ...(input ?? {}),
    realChainEnabled: readiness.realChainEnabled,
  });
}

function rollup(items: readonly Phase10ReadinessItem[]): Phase10ReadinessStatus {
  if (items.some((i) => i.status === 'BLOCKED')) return 'BLOCKED';
  if (items.some((i) => i.status === 'WARN')) return 'WARN';
  return 'PASS';
}

async function withClient<T>(db: Pool | PoolClient, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!isPool(db)) return fn(db);
  const client = await db.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

async function isWithdrawalRequestsPaused(
  client: PoolClient,
  environment: DeploymentEnvironment,
): Promise<boolean> {
  const result = await client.query<{ enabled: boolean }>(
    `SELECT enabled FROM feature_flags
     WHERE flag_key = 'WITHDRAWAL_REQUESTS_PAUSE'
       AND environment = $1::environment_name`,
    [environment],
  );
  return result.rows[0]?.enabled === true;
}

async function selectLedgerBalanceAtomic(
  client: PoolClient,
  userId: string,
  assetId: string,
  accountType: 'USER_AVAILABLE_LIABILITY' | 'USER_PENDING_LIABILITY' | 'USER_RESERVED_LIABILITY',
): Promise<string> {
  const result = await client.query<{ balance_atomic: string }>(
    `SELECT b.balance_atomic::text AS balance_atomic
     FROM ledger_accounts a
     JOIN ledger_account_balances b ON b.ledger_account_id = a.id
     WHERE a.owner_id = $1::uuid
       AND a.asset_id = $2::uuid
       AND a.account_type = $3::ledger_account_type`,
    [userId, assetId, accountType],
  );
  return result.rows[0]?.balance_atomic ?? '0';
}

/**
 * Read-only Phase 10 readiness inspector. Never mutates DB, never prints secrets.
 */
export async function runPhase10Readiness(
  db: Pool | PoolClient,
  config: Phase10ReadinessConfig,
): Promise<Phase10ReadinessReport> {
  return withClient(db, async (client) => {
    const items: Phase10ReadinessItem[] = [];
    const phase10 = asPhase10Config(config.phase10, config);
    const missingResources = listPhase10MissingResources({
      ...phase10,
      realChainEnabled: config.realChainEnabled,
    });

    items.push({
      code: 'DEPLOYMENT_ENV',
      status: 'PASS',
      message: `deploymentEnvironment=${config.deploymentEnvironment}`,
      classification: 'ok',
      details: { deploymentEnvironment: config.deploymentEnvironment },
    });

    if (config.realChainEnabled && config.fakeChainEnabled) {
      items.push({
        code: 'CHAIN_MODE',
        status: 'BLOCKED',
        message: 'real and fake chain cannot both be enabled',
        classification: 'misconfigured',
      });
    } else if (!config.realChainEnabled && !config.fakeChainEnabled) {
      items.push({
        code: 'CHAIN_MODE',
        status: 'BLOCKED',
        message: 'both real and fake chain disabled — no payout path',
        classification: 'intentionally_safe_off',
        details: { realChainEnabled: false, fakeChainEnabled: false },
      });
    } else if (config.realChainEnabled) {
      items.push({
        code: 'CHAIN_MODE',
        status: 'PASS',
        message: 'real Testnet chain enabled; fake chain off',
        classification: 'ok',
      });
    } else {
      items.push({
        code: 'CHAIN_MODE',
        status: 'WARN',
        message: 'fake chain enabled (local/deterministic only)',
        classification: 'intentionally_safe_off',
      });
    }

    for (const missing of missingResources) {
      const intentionallyOff = !config.realChainEnabled;
      items.push({
        code: 'EXTERNAL_RESOURCE',
        status: intentionallyOff ? 'WARN' : 'BLOCKED',
        message: missing,
        classification: intentionallyOff ? 'intentionally_safe_off' : 'misconfigured',
      });
    }

    let withdrawalRequestsPaused: boolean | null = null;
    let payoutDispatchPaused: boolean | null = null;
    try {
      withdrawalRequestsPaused = await isWithdrawalRequestsPaused(
        client,
        config.deploymentEnvironment,
      );
      payoutDispatchPaused = await isPayoutDispatchPaused(client, config.deploymentEnvironment);
      items.push({
        code: 'WITHDRAWAL_REQUESTS_PAUSE',
        status: withdrawalRequestsPaused ? 'WARN' : 'PASS',
        message: withdrawalRequestsPaused
          ? 'WITHDRAWAL_REQUESTS_PAUSE is enabled'
          : 'WITHDRAWAL_REQUESTS_PAUSE is off',
        classification: withdrawalRequestsPaused ? 'operator_attention' : 'ok',
      });
      items.push({
        code: 'PAYOUT_DISPATCH_PAUSE',
        status: payoutDispatchPaused ? 'WARN' : 'PASS',
        message: payoutDispatchPaused
          ? 'PAYOUT_DISPATCH_PAUSE is enabled'
          : 'PAYOUT_DISPATCH_PAUSE is off',
        classification: payoutDispatchPaused ? 'operator_attention' : 'ok',
      });
    } catch (error) {
      items.push({
        code: 'FEATURE_FLAGS',
        status: 'BLOCKED',
        message: `feature flag read failed: ${error instanceof Error ? error.message : String(error)}`,
        classification: 'misconfigured',
      });
    }

    const network = await client.query<{ id: string; code: string; status: string }>(
      `SELECT id, code, status::text AS status FROM networks WHERE code = $1`,
      [config.acceptedNetworkCode],
    );
    const networkId = network.rows[0]?.id ?? null;
    const networkStatus = network.rows[0]?.status ?? null;
    if (networkId === null) {
      items.push({
        code: 'NETWORK',
        status: 'BLOCKED',
        message: `network code ${config.acceptedNetworkCode} not found`,
        classification: 'misconfigured',
      });
    } else if (networkStatus !== 'ACTIVE') {
      items.push({
        code: 'NETWORK',
        status: config.realChainEnabled ? 'BLOCKED' : 'WARN',
        message: `network ${config.acceptedNetworkCode} is not ACTIVE (status=${networkStatus})`,
        classification: config.realChainEnabled ? 'misconfigured' : 'intentionally_safe_off',
        details: { networkId, status: networkStatus },
      });
    } else {
      items.push({
        code: 'NETWORK',
        status: 'PASS',
        message: `network ${config.acceptedNetworkCode}`,
        classification: 'ok',
        details: { networkId },
      });
    }

    let assetId: string | null = null;
    if (networkId !== null) {
      const asset = await client.query<{ id: string; symbol: string }>(
        `SELECT id, symbol FROM assets
         WHERE network_id = $1::uuid AND symbol = $2 AND status = 'ACTIVE'`,
        [networkId, config.usdtSymbol],
      );
      assetId = asset.rows[0]?.id ?? null;
      if (assetId === null) {
        items.push({
          code: 'ASSET',
          status: 'BLOCKED',
          message: `ACTIVE ${config.usdtSymbol} asset missing for ${config.acceptedNetworkCode}`,
          classification: 'misconfigured',
        });
      } else {
        items.push({
          code: 'ASSET',
          status: 'PASS',
          message: `ACTIVE ${config.usdtSymbol}`,
          classification: 'ok',
          details: { assetId },
        });
      }
    }

    let feeRule: Phase10ReadinessReport['summary']['feeRule'] = null;
    let limitRule: Phase10ReadinessReport['summary']['limitRule'] = null;
    if (networkId !== null && assetId !== null) {
      const asOf = new Date();
      const fee = await client.query<{
        id: string;
        rule_version: number;
        fixed_fee_atomic: string;
      }>(
        `SELECT id, rule_version, fixed_fee_atomic::text AS fixed_fee_atomic
         FROM withdrawal_fee_rules
         WHERE asset_id = $1::uuid
           AND network_id = $2::uuid
           AND status = 'ACTIVE'
           AND valid_from <= $3::timestamptz
           AND (valid_to IS NULL OR valid_to > $3::timestamptz)`,
        [assetId, networkId, asOf.toISOString()],
      );
      if ((fee.rowCount ?? 0) !== 1) {
        items.push({
          code: 'FEE_RULE',
          status: 'BLOCKED',
          message:
            (fee.rowCount ?? 0) === 0
              ? 'ACTIVE fee rule missing for TON_TESTNET/USDT'
              : 'Ambiguous ACTIVE fee rules for TON_TESTNET/USDT',
          classification: 'misconfigured',
          details: { count: fee.rowCount ?? 0 },
        });
      } else {
        const row = fee.rows[0]!;
        feeRule = {
          id: row.id,
          ruleVersion: row.rule_version,
          fixedFeeAtomic: row.fixed_fee_atomic,
        };
        items.push({
          code: 'FEE_RULE',
          status: 'PASS',
          message: `ACTIVE fee rule ${row.id}`,
          classification: 'ok',
          details: feeRule,
        });
      }

      const limit = await client.query<{
        id: string;
        rule_version: number;
        min_withdrawal_atomic: string;
        max_single_withdrawal_atomic: string;
        wallet_change_cooldown_seconds: number;
      }>(
        `SELECT id, rule_version,
                min_withdrawal_atomic::text AS min_withdrawal_atomic,
                max_single_withdrawal_atomic::text AS max_single_withdrawal_atomic,
                wallet_change_cooldown_seconds
         FROM withdrawal_limit_rules
         WHERE asset_id = $1::uuid
           AND network_id = $2::uuid
           AND status = 'ACTIVE'
           AND risk_tier IS NULL
           AND valid_from <= $3::timestamptz
           AND (valid_to IS NULL OR valid_to > $3::timestamptz)`,
        [assetId, networkId, asOf.toISOString()],
      );
      if ((limit.rowCount ?? 0) !== 1) {
        items.push({
          code: 'LIMIT_RULE',
          status: 'BLOCKED',
          message:
            (limit.rowCount ?? 0) === 0
              ? 'ACTIVE limit rule missing for TON_TESTNET/USDT'
              : 'Ambiguous ACTIVE limit rules for TON_TESTNET/USDT',
          classification: 'misconfigured',
          details: { count: limit.rowCount ?? 0 },
        });
      } else {
        const row = limit.rows[0]!;
        limitRule = {
          id: row.id,
          ruleVersion: row.rule_version,
          minWithdrawalAtomic: row.min_withdrawal_atomic,
          maxSingleWithdrawalAtomic: row.max_single_withdrawal_atomic,
          walletChangeCooldownSeconds: row.wallet_change_cooldown_seconds,
        };
        items.push({
          code: 'LIMIT_RULE',
          status: 'PASS',
          message: `ACTIVE limit rule ${row.id}`,
          classification: 'ok',
          details: limitRule,
        });
      }
    }

    let controlledUser: Phase10ReadinessReport['summary']['controlledUser'] = null;
    const controlledUserId = config.controlledUserId?.trim() || null;
    if (controlledUserId === null) {
      items.push({
        code: 'CONTROLLED_USER',
        status: config.realChainEnabled ? 'BLOCKED' : 'WARN',
        message: 'controlled user id not provided',
        classification: config.realChainEnabled ? 'misconfigured' : 'intentionally_safe_off',
      });
    } else {
      const user = await client.query<{
        id: string;
        status: string;
        withdrawal_status: string;
        withdrawal_cooldown_until: Date | null;
      }>(
        `SELECT id, status::text AS status,
                withdrawal_status::text AS withdrawal_status,
                withdrawal_cooldown_until
         FROM users WHERE id = $1::uuid`,
        [controlledUserId],
      );
      const u = user.rows[0];
      if (u === undefined) {
        items.push({
          code: 'CONTROLLED_USER',
          status: 'BLOCKED',
          message: 'controlled user not found',
          classification: 'misconfigured',
          details: { userId: controlledUserId },
        });
      } else {
        const cooldownActive =
          u.withdrawal_cooldown_until !== null &&
          u.withdrawal_cooldown_until.getTime() > Date.now();
        let primaryWallet: NonNullable<
          Phase10ReadinessReport['summary']['controlledUser']
        >['primaryWallet'] = null;
        if (networkId !== null) {
          const wallet = await client.query<{
            id: string;
            verification_method: string | null;
            verified: boolean;
            friendly_address: string | null;
          }>(
            `SELECT id, verification_method::text AS verification_method, verified, friendly_address
             FROM user_wallets
             WHERE user_id = $1::uuid
               AND network_id = $2::uuid
               AND is_primary = true
               AND disabled_at IS NULL`,
            [controlledUserId, networkId],
          );
          const w = wallet.rows[0];
          if (w !== undefined) {
            primaryWallet = {
              id: w.id,
              verificationMethod: w.verification_method,
              verified: w.verified,
              friendlyAddress: w.friendly_address,
            };
          }
        }
        const balancesAtomic = {
          available:
            assetId === null
              ? '0'
              : await selectLedgerBalanceAtomic(
                  client,
                  controlledUserId,
                  assetId,
                  'USER_AVAILABLE_LIABILITY',
                ),
          pending:
            assetId === null
              ? '0'
              : await selectLedgerBalanceAtomic(
                  client,
                  controlledUserId,
                  assetId,
                  'USER_PENDING_LIABILITY',
                ),
          reserved:
            assetId === null
              ? '0'
              : await selectLedgerBalanceAtomic(
                  client,
                  controlledUserId,
                  assetId,
                  'USER_RESERVED_LIABILITY',
                ),
        };
        controlledUser = {
          userId: u.id,
          status: u.status,
          withdrawalStatus: u.withdrawal_status,
          cooldownUntil: u.withdrawal_cooldown_until?.toISOString() ?? null,
          cooldownActive,
          primaryWallet,
          balancesAtomic,
        };
        const walletOk =
          primaryWallet !== null &&
          primaryWallet.verified &&
          primaryWallet.verificationMethod === 'TON_PROOF';
        const userOk =
          u.status === 'ACTIVE' &&
          u.withdrawal_status === 'ALLOWED' &&
          walletOk &&
          !cooldownActive;
        items.push({
          code: 'CONTROLLED_USER',
          status: userOk ? 'PASS' : config.realChainEnabled ? 'BLOCKED' : 'WARN',
          message: userOk
            ? 'controlled user inspected'
            : 'controlled user invalid (ACTIVE + ALLOWED + TON_PROOF primary + no cooldown required)',
          classification: userOk
            ? 'ok'
            : config.realChainEnabled
              ? 'misconfigured'
              : 'operator_attention',
          details: {
            status: u.status,
            withdrawalStatus: u.withdrawal_status,
            cooldownActive,
            primaryTonProof: walletOk,
          },
        });
      }
    }

    let hotWallet: Phase10ReadinessReport['summary']['hotWallet'] = null;
    if (networkId !== null) {
      const hotQuery = config.fakeChainEnabled
        ? await client.query<{
            id: string;
            address: string;
            friendly_address: string | null;
            signer_type: string;
            signer_reference: string;
            payout_jetton_wallet_address: string | null;
            status: string;
            wallet_version: string;
          }>(
            `SELECT id, address, friendly_address, signer_type::text AS signer_type,
                    signer_reference, payout_jetton_wallet_address,
                    status::text AS status, wallet_version
             FROM hot_wallets
             WHERE network_id = $1::uuid
               AND status = 'ACTIVE'
               AND signer_reference LIKE 'TEST_ONLY_FAKE%'`,
            [networkId],
          )
        : await client.query<{
            id: string;
            address: string;
            friendly_address: string | null;
            signer_type: string;
            signer_reference: string;
            payout_jetton_wallet_address: string | null;
            status: string;
            wallet_version: string;
          }>(
            `SELECT id, address, friendly_address, signer_type::text AS signer_type,
                    signer_reference, payout_jetton_wallet_address,
                    status::text AS status, wallet_version
             FROM hot_wallets
             WHERE network_id = $1::uuid
               AND status = 'ACTIVE'
               AND signer_type = 'FALLBACK_ENCRYPTED'`,
            [networkId],
          );

      if ((hotQuery.rowCount ?? 0) === 0) {
        items.push({
          code: 'HOT_WALLET',
          status: config.realChainEnabled ? 'BLOCKED' : 'WARN',
          message: config.fakeChainEnabled
            ? 'no ACTIVE TEST_ONLY_FAKE hot wallet'
            : 'no ACTIVE FALLBACK_ENCRYPTED hot wallet',
          classification: config.realChainEnabled ? 'misconfigured' : 'intentionally_safe_off',
        });
      } else if ((hotQuery.rowCount ?? 0) > 1) {
        items.push({
          code: 'HOT_WALLET',
          status: 'BLOCKED',
          message: 'ambiguous ACTIVE hot wallets for mode',
          classification: 'misconfigured',
          details: { count: hotQuery.rowCount },
        });
      } else {
        const row = hotQuery.rows[0]!;
        hotWallet = {
          id: row.id,
          address: row.address,
          friendlyAddress: row.friendly_address,
          signerType: row.signer_type,
          signerReferencePresent: row.signer_reference.trim() !== '',
          payoutJettonWalletAddress: row.payout_jetton_wallet_address,
          status: row.status,
          walletVersion: row.wallet_version,
        };
        const jettonOk =
          row.payout_jetton_wallet_address !== null &&
          row.payout_jetton_wallet_address.trim() !== '';
        items.push({
          code: 'HOT_WALLET',
          status: config.realChainEnabled && !jettonOk ? 'BLOCKED' : 'PASS',
          message: 'ACTIVE hot wallet selected (no secrets)',
          classification: config.realChainEnabled && !jettonOk ? 'misconfigured' : 'ok',
          details: {
            id: row.id,
            signerType: row.signer_type,
            payoutJettonWalletConfigured: jettonOk,
          },
        });
      }
    }

    const primaryUrl = phase10.primaryProvider.url;
    const secondaryUrl = phase10.secondaryProvider.url;
    const primarySecondaryIndependent =
      phase10.primaryProvider.kind !== null &&
      phase10.secondaryProvider.kind !== null &&
      primaryUrl !== null &&
      secondaryUrl !== null &&
      !(
        phase10.primaryProvider.kind === phase10.secondaryProvider.kind &&
        primaryUrl === secondaryUrl
      );

    const providerConfig = {
      jettonMasterConfigured: phase10.jettonMasterIdentity !== null,
      primary: {
        kind: phase10.primaryProvider.kind,
        urlConfigured: primaryUrl !== null,
      },
      secondary: {
        kind: phase10.secondaryProvider.kind,
        urlConfigured: secondaryUrl !== null,
      },
      primarySecondaryIndependent,
    };
    const providerStatus: Phase10ReadinessStatus =
      config.realChainEnabled && !primarySecondaryIndependent
        ? 'BLOCKED'
        : primarySecondaryIndependent
          ? 'PASS'
          : 'WARN';
    items.push({
      code: 'PROVIDER_SHAPE',
      status: providerStatus,
      message: 'provider presence/shape (URLs redacted)',
      classification:
        config.realChainEnabled && !primarySecondaryIndependent
          ? 'misconfigured'
          : primarySecondaryIndependent
            ? 'ok'
            : 'intentionally_safe_off',
      details: providerConfig,
    });

    const signerBaseUrlConfigured =
      config.signerBaseUrlConfigured ?? phase10.signerBaseUrl.trim() !== '';
    const signerServiceTokenConfigured =
      config.signerServiceTokenConfigured ?? phase10.signerServiceToken.trim().length >= 32;
    const signerLocked = config.signerLocked ?? null;
    items.push({
      code: 'SIGNER_CONFIG',
      status:
        config.realChainEnabled && (!signerBaseUrlConfigured || !signerServiceTokenConfigured)
          ? 'BLOCKED'
          : 'PASS',
      message: 'signer config readiness (token not disclosed)',
      classification:
        config.realChainEnabled && (!signerBaseUrlConfigured || !signerServiceTokenConfigured)
          ? 'misconfigured'
          : 'ok',
      details: {
        baseUrlConfigured: signerBaseUrlConfigured,
        serviceTokenConfigured: signerServiceTokenConfigured,
        locked: signerLocked,
      },
    });
    if (signerLocked === true) {
      items.push({
        code: 'SIGNER_LOCKED',
        status: config.realChainEnabled ? 'BLOCKED' : 'WARN',
        message: 'signer reported LOCKED',
        classification: config.realChainEnabled ? 'misconfigured' : 'operator_attention',
      });
    } else if (signerLocked === null) {
      items.push({
        code: 'SIGNER_LOCKED',
        status: config.realChainEnabled ? 'BLOCKED' : 'WARN',
        message: 'signer lock state unknown / not probed',
        classification: config.realChainEnabled ? 'misconfigured' : 'intentionally_safe_off',
      });
    } else {
      items.push({
        code: 'SIGNER_LOCKED',
        status: 'PASS',
        message: 'signer probed unlocked',
        classification: 'ok',
      });
    }

    const unknownScan = await client.query<{
      id: string;
      withdrawal_id: string;
      has_pending_outbox: boolean;
    }>(
      `SELECT a.id, a.withdrawal_id,
              EXISTS (
                SELECT 1 FROM outbox_events o
                WHERE o.event_type = $1
                  AND o.status = 'PENDING'
                  AND (o.aggregate_id = a.withdrawal_id
                       OR (o.payload->>'withdrawalId') = a.withdrawal_id::text)
              ) AS has_pending_outbox
       FROM withdrawal_attempts a
       WHERE a.broadcast_result_state = 'UNKNOWN'
          OR a.broadcast_ambiguity_class IS NOT NULL`,
      [WITHDRAWAL_APPROVED_OUTBOX_EVENT],
    );
    const withPending = unknownScan.rows.filter((r) => r.has_pending_outbox);
    const syntheticUnknownIsolation = {
      scannedAttempts: unknownScan.rowCount ?? 0,
      withPendingApprovedOutbox: withPending.length,
      isolated: withPending.length === 0,
      attemptIds: withPending.map((r) => r.id).slice(0, 20),
    };
    items.push({
      code: 'SYNTHETIC_UNKNOWN_ISOLATION',
      status: syntheticUnknownIsolation.isolated ? 'PASS' : 'WARN',
      message: syntheticUnknownIsolation.isolated
        ? 'no UNKNOWN/ambiguous attempts with PENDING approved outbox'
        : 'UNKNOWN/ambiguous attempts still have PENDING approved outbox (report only; not mutated)',
      classification: syntheticUnknownIsolation.isolated ? 'ok' : 'operator_attention',
      details: syntheticUnknownIsolation,
    });

    const overall = rollup(items);
    return {
      overall,
      items,
      summary: {
        deploymentEnvironment: config.deploymentEnvironment,
        fakeChainEnabled: config.fakeChainEnabled,
        realChainEnabled: config.realChainEnabled,
        acceptedNetworkCode: config.acceptedNetworkCode,
        usdtSymbol: config.usdtSymbol,
        withdrawalRequestsPaused,
        payoutDispatchPaused,
        networkId,
        assetId,
        feeRule,
        limitRule,
        controlledUser,
        hotWallet,
        providerConfig,
        signer: {
          baseUrlConfigured: signerBaseUrlConfigured,
          serviceTokenConfigured: signerServiceTokenConfigured,
          locked: signerLocked,
        },
        syntheticUnknownIsolation,
        passCount: items.filter((i) => i.status === 'PASS').length,
        warnCount: items.filter((i) => i.status === 'WARN').length,
        blockedCount: items.filter((i) => i.status === 'BLOCKED').length,
      },
    };
  });
}
