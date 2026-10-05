/**
 * Read-only post-apply verification of Phase 21 Mainnet registry bootstrap.
 */
import type { PoolClient } from 'pg';

import { tonAddressesEqual } from '@alex-rewards/ton';

import { LOCKED_INITIAL_WITHDRAWAL } from './config.js';
import type { AuthenticatedPhase21MainnetRegistryVerification } from './phase21-mainnet-registry-verification-trust.js';
import { assertAuthenticatedPhase21MainnetRegistryVerification } from './phase21-mainnet-registry-verification-trust.js';

export class Phase21MainnetRegistryPostApplyVerifyError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'Phase21MainnetRegistryPostApplyVerifyError';
    this.code = code;
    this.details = details;
  }
}

export type Phase21MainnetRegistryPostApplyExpected = {
  readonly mainnetVerification: AuthenticatedPhase21MainnetRegistryVerification;
  readonly adminUserId: string;
};

export type Phase21MainnetRegistryPostApplyVerifyResult = {
  readonly ok: true;
  readonly readOnly: true;
  readonly networkCode: 'TON_MAINNET';
  readonly usdt: {
    readonly symbol: 'USDT';
    readonly decimals: 6;
    readonly isNative: false;
    readonly contractIdentity: string;
    readonly status: string;
  };
  readonly gram: {
    readonly symbol: 'GRAM';
    readonly decimals: 9;
    readonly isNative: true;
    readonly contractIdentity: null;
    readonly status: string;
  };
  readonly feeRuleMatches: true;
  readonly limitRuleMatches: true;
  readonly auditPresent: true;
  readonly auditCount: number;
  readonly hotWalletRowCount: 0;
  readonly readyForLivePayout: false;
  readonly sanitized: true;
};

export async function verifyPhase21MainnetRegistryBootstrapReadOnly(
  client: PoolClient,
  expected: Phase21MainnetRegistryPostApplyExpected,
): Promise<Phase21MainnetRegistryPostApplyVerifyResult> {
  assertAuthenticatedPhase21MainnetRegistryVerification(expected.mainnetVerification);
  const adminUserId = expected.adminUserId.trim();
  if (adminUserId === '') {
    throw new Phase21MainnetRegistryPostApplyVerifyError(
      'ADMIN_USER_ID_REQUIRED',
      'adminUserId required to verify registry audit',
      {},
    );
  }
  const expectedMaster = expected.mainnetVerification.jettonMaster;

  await client.query('BEGIN READ ONLY');
  try {
    const ro = await client.query<{ transaction_read_only: string }>(
      `SHOW transaction_read_only`,
    );
    const flag = (ro.rows[0]?.transaction_read_only ?? '').toLowerCase();
    if (flag !== 'on') {
      throw new Phase21MainnetRegistryPostApplyVerifyError(
        'READ_ONLY_TRANSACTION_REQUIRED',
        'SHOW transaction_read_only must be on for post-registry verify',
        { transaction_read_only: flag },
      );
    }

    const network = await client.query<{
      id: string;
      code: string;
      chain: string | null;
      environment: string | null;
      status: string;
    }>(
      `SELECT id, code, chain::text AS chain, environment::text AS environment, status::text AS status
       FROM networks WHERE code = 'TON_MAINNET' LIMIT 1`,
    );
    const net = network.rows[0];
    if (net === undefined) {
      throw new Phase21MainnetRegistryPostApplyVerifyError(
        'NETWORK_MISSING',
        'TON_MAINNET network missing after registry APPLY',
        {},
      );
    }

    const usdt = await client.query<{
      id: string;
      symbol: string;
      decimals: number;
      is_native: boolean;
      contract_identity: string | null;
      status: string;
    }>(
      `SELECT id, symbol, decimals, is_native, contract_identity, status::text AS status
       FROM assets WHERE symbol = 'USDT' AND network_id = $1::uuid LIMIT 1`,
      [net.id],
    );
    const usdtRow = usdt.rows[0];
    if (
      usdtRow === undefined ||
      usdtRow.symbol !== 'USDT' ||
      Number(usdtRow.decimals) !== 6 ||
      usdtRow.is_native !== false ||
      usdtRow.contract_identity === null ||
      !tonAddressesEqual(usdtRow.contract_identity, expectedMaster)
    ) {
      throw new Phase21MainnetRegistryPostApplyVerifyError(
        'USDT_CANONICAL_MISMATCH',
        'USDT asset must be decimals=6 non-native with branded verified master',
        {},
      );
    }

    const gram = await client.query<{
      id: string;
      symbol: string;
      decimals: number;
      is_native: boolean;
      contract_identity: string | null;
      status: string;
    }>(
      `SELECT id, symbol, decimals, is_native, contract_identity, status::text AS status
       FROM assets WHERE symbol = 'GRAM' AND network_id = $1::uuid LIMIT 1`,
      [net.id],
    );
    const gramRow = gram.rows[0];
    if (
      gramRow === undefined ||
      gramRow.symbol !== 'GRAM' ||
      Number(gramRow.decimals) !== 9 ||
      gramRow.is_native !== true ||
      gramRow.contract_identity !== null
    ) {
      throw new Phase21MainnetRegistryPostApplyVerifyError(
        'GRAM_CANONICAL_MISMATCH',
        'GRAM asset must be decimals=9 native with null contract_identity',
        {},
      );
    }

    const fee = await client.query<{ fixed_fee_atomic: string }>(
      `SELECT fixed_fee_atomic::text AS fixed_fee_atomic
       FROM withdrawal_fee_rules WHERE network_id = $1::uuid ORDER BY rule_version LIMIT 1`,
      [net.id],
    );
    if (
      fee.rows[0] === undefined ||
      fee.rows[0].fixed_fee_atomic !== LOCKED_INITIAL_WITHDRAWAL.fixedFeeAtomic.toString(10)
    ) {
      throw new Phase21MainnetRegistryPostApplyVerifyError(
        'FEE_RULE_MISMATCH',
        'withdrawal fee rule does not match locked Phase21 values',
        {},
      );
    }

    const limits = await client.query<{
      min_withdrawal_atomic: string;
      max_single_withdrawal_atomic: string;
    }>(
      `SELECT min_withdrawal_atomic::text AS min_withdrawal_atomic,
              max_single_withdrawal_atomic::text AS max_single_withdrawal_atomic
       FROM withdrawal_limit_rules WHERE network_id = $1::uuid ORDER BY rule_version LIMIT 1`,
      [net.id],
    );
    const lim = limits.rows[0];
    if (
      lim === undefined ||
      lim.min_withdrawal_atomic !== LOCKED_INITIAL_WITHDRAWAL.minWithdrawalAtomic.toString(10) ||
      lim.max_single_withdrawal_atomic !==
        LOCKED_INITIAL_WITHDRAWAL.maxSingleWithdrawalAtomic.toString(10)
    ) {
      throw new Phase21MainnetRegistryPostApplyVerifyError(
        'LIMIT_RULE_MISMATCH',
        'withdrawal limit rule does not match locked Phase21 values',
        {},
      );
    }

    const audit = await client.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c
       FROM audit_logs
       WHERE action_type = 'phase21.mainnet_registry.bootstrap'
         AND resource_type = 'network'
         AND resource_id = $1::uuid
         AND admin_user_id = $2::uuid
         AND after_snapshot->>'usdtJettonMaster' IS NOT NULL`,
      [net.id, adminUserId],
    );
    const auditCount = audit.rows[0]?.c ?? 0;
    if (auditCount < 1) {
      throw new Phase21MainnetRegistryPostApplyVerifyError(
        'REGISTRY_AUDIT_MISSING',
        'intended phase21.mainnet_registry.bootstrap audit_logs row missing',
        { auditCount },
      );
    }

    const hot = await client.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM hot_wallets WHERE network_id = $1::uuid`,
      [net.id],
    );
    const hotWalletRowCount = hot.rows[0]?.c ?? 0;
    if (hotWalletRowCount !== 0) {
      throw new Phase21MainnetRegistryPostApplyVerifyError(
        'HOT_WALLET_UNEXPECTED',
        'registry bootstrap must not create hot_wallets rows',
        { hotWalletRowCount },
      );
    }

    return {
      ok: true,
      readOnly: true,
      networkCode: 'TON_MAINNET',
      usdt: {
        symbol: 'USDT',
        decimals: 6,
        isNative: false,
        contractIdentity: usdtRow.contract_identity,
        status: usdtRow.status,
      },
      gram: {
        symbol: 'GRAM',
        decimals: 9,
        isNative: true,
        contractIdentity: null,
        status: gramRow.status,
      },
      feeRuleMatches: true,
      limitRuleMatches: true,
      auditPresent: true,
      auditCount,
      hotWalletRowCount: 0,
      readyForLivePayout: false,
      sanitized: true,
    };
  } finally {
    await client.query('ROLLBACK');
  }
}
