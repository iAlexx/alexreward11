/**
 * Phase 21 Mainnet registry bootstrap (DRY_RUN default).
 * Apply gated by PHASE21_MAINNET_REGISTRY_BOOTSTRAP_APPLY=1 and
 * PHASE21_OPERATIONAL_CEREMONY_ENABLED=true.
 */
import { LOCKED_INITIAL_WITHDRAWAL } from './config.js';

export type Phase21MainnetRegistryBootstrapMode = 'DRY_RUN' | 'APPLY';

export interface Phase21MainnetRegistryBootstrapInput {
  readonly usdtJettonMaster: string;
  readonly networkDisplayName?: string;
  readonly usdtDisplayName?: string;
  readonly gramDisplayName?: string;
}

export interface Phase21MainnetRegistryPlanItem {
  readonly resource: string;
  readonly action: 'CREATE' | 'ALREADY_MATCHES' | 'CONFLICT' | 'DOCUMENTED_ONLY';
  readonly details: Readonly<Record<string, unknown>>;
  readonly note: string;
}

export interface Phase21MainnetRegistryBootstrapResult {
  readonly mode: Phase21MainnetRegistryBootstrapMode;
  readonly applyAuthorized: boolean;
  readonly applied: boolean;
  readonly items: readonly Phase21MainnetRegistryPlanItem[];
  readonly conflicts: readonly Phase21MainnetRegistryPlanItem[];
  readonly notes: readonly string[];
}

export interface Phase21MainnetRegistryBootstrapClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
}

const FORBIDDEN = ['TESTNET', 'LOCAL', 'PLACEHOLDER'] as const;

function applyGatesEnabled(): boolean {
  return (
    process.env.PHASE21_MAINNET_REGISTRY_BOOTSTRAP_APPLY === '1' &&
    process.env.PHASE21_OPERATIONAL_CEREMONY_ENABLED === 'true'
  );
}

function assertUsdtMaster(master: string): string {
  const trimmed = master.trim();
  if (trimmed.length === 0) {
    throw new Error('usdtJettonMaster is required (Owner-supplied; never invent)');
  }
  const upper = trimmed.toUpperCase();
  for (const marker of FORBIDDEN) {
    if (upper.includes(marker)) {
      throw new Error('usdtJettonMaster must not contain ' + marker);
    }
  }
  return trimmed;
}

export async function planPhase21MainnetRegistryBootstrap(
  client: Phase21MainnetRegistryBootstrapClient,
  input: Phase21MainnetRegistryBootstrapInput,
): Promise<readonly Phase21MainnetRegistryPlanItem[]> {
  const master = assertUsdtMaster(input.usdtJettonMaster);
  const items: Phase21MainnetRegistryPlanItem[] = [];

  const network = await client.query<{
    id: string;
    chain: string;
    environment: string;
    global_chain_identifier: string | null;
    status: string;
  }>(
    `SELECT id, chain, environment::text AS environment,
            global_chain_identifier, status::text AS status
     FROM networks WHERE code = 'TON_MAINNET' LIMIT 1`,
  );
  const net = network.rows[0];
  if (net === undefined) {
    items.push({
      resource: 'networks:TON_MAINNET',
      action: 'CREATE',
      details: {
        code: 'TON_MAINNET',
        chain: 'TON',
        environment: 'MAINNET',
        globalChainIdentifier: 'ton:mainnet',
      },
      note: 'would insert ACTIVE TON_MAINNET network',
    });
  } else if (
    net.chain === 'TON' &&
    net.environment === 'MAINNET' &&
    (net.global_chain_identifier ?? '').trim() === 'ton:mainnet'
  ) {
    items.push({
      resource: 'networks:TON_MAINNET',
      action: 'ALREADY_MATCHES',
      details: { networkId: net.id, status: net.status },
      note: 'TON_MAINNET already present with Mainnet identity',
    });
  } else {
    items.push({
      resource: 'networks:TON_MAINNET',
      action: 'CONFLICT',
      details: {
        networkId: net.id,
        chain: net.chain,
        environment: net.environment,
        globalChainIdentifier: net.global_chain_identifier,
      },
      note: 'existing TON_MAINNET row conflicts; refuse rewrite',
    });
  }

  const networkId = net?.id ?? null;
  if (networkId !== null) {
    const usdt = await client.query<{
      id: string;
      decimals: number;
      is_native: boolean;
      contract_identity: string | null;
      status: string;
    }>(
      `SELECT id, decimals::int AS decimals, is_native, contract_identity, status::text AS status
       FROM assets WHERE network_id = $1::uuid AND symbol = 'USDT' LIMIT 1`,
      [networkId],
    );
    const u = usdt.rows[0];
    if (u === undefined) {
      items.push({
        resource: 'assets:USDT',
        action: 'CREATE',
        details: {
          symbol: 'USDT',
          decimals: 6,
          isNative: false,
          contractIdentity: master,
        },
        note: 'would insert Mainnet USDT jetton asset',
      });
    } else if (
      u.decimals === 6 &&
      u.is_native === false &&
      (u.contract_identity ?? '').trim() === master
    ) {
      items.push({
        resource: 'assets:USDT',
        action: 'ALREADY_MATCHES',
        details: { assetId: u.id, status: u.status },
        note: 'USDT asset already matches Owner-supplied master',
      });
    } else {
      items.push({
        resource: 'assets:USDT',
        action: 'CONFLICT',
        details: {
          assetId: u.id,
          decimals: u.decimals,
          isNative: u.is_native,
          contractIdentity: u.contract_identity,
        },
        note: 'existing USDT conflicts; refuse historical rewrite',
      });
    }

    const gram = await client.query<{
      id: string;
      decimals: number;
      is_native: boolean;
      contract_identity: string | null;
      status: string;
    }>(
      `SELECT id, decimals::int AS decimals, is_native, contract_identity, status::text AS status
       FROM assets WHERE network_id = $1::uuid AND symbol = 'GRAM' LIMIT 1`,
      [networkId],
    );
    const g = gram.rows[0];
    if (g === undefined) {
      items.push({
        resource: 'assets:GRAM',
        action: 'CREATE',
        details: { symbol: 'GRAM', decimals: 9, isNative: true, contractIdentity: null },
        note: 'would insert native GRAM asset; chain remains TON_MAINNET',
      });
    } else if (g.decimals === 9 && g.is_native === true && g.contract_identity === null) {
      items.push({
        resource: 'assets:GRAM',
        action: 'ALREADY_MATCHES',
        details: { assetId: g.id, status: g.status },
        note: 'GRAM native asset already present',
      });
    } else {
      items.push({
        resource: 'assets:GRAM',
        action: 'CONFLICT',
        details: {
          assetId: g.id,
          decimals: g.decimals,
          isNative: g.is_native,
          contractIdentity: g.contract_identity,
        },
        note: 'existing GRAM conflicts; refuse rewrite',
      });
    }

    const usdtMatches =
      u !== undefined &&
      u.decimals === 6 &&
      u.is_native === false &&
      (u.contract_identity ?? '').trim() === master;
    const usdtId = usdtMatches ? u.id : null;

    if (usdtId !== null) {
      const fee = await client.query<{
        id: string;
        fixed_fee_atomic: string;
        percentage_bps: number;
        status: string;
      }>(
        `SELECT id, fixed_fee_atomic::text AS fixed_fee_atomic,
                percentage_bps::int AS percentage_bps, status::text AS status
         FROM withdrawal_fee_rules
         WHERE asset_id = $1::uuid AND network_id = $2::uuid AND rule_version = 1
         LIMIT 1`,
        [usdtId, networkId],
      );
      const feeRow = fee.rows[0];
      const expectedFee = LOCKED_INITIAL_WITHDRAWAL.fixedFeeAtomic.toString(10);
      if (feeRow === undefined) {
        items.push({
          resource: 'withdrawal_fee_rules:v1',
          action: 'CREATE',
          details: {
            fixedFeeAtomic: expectedFee,
            percentageBps: 0,
            lockedEconomics: '0.01 USDT fixed',
          },
          note: 'would insert locked Mainnet fee rule (0.01)',
        });
      } else if (feeRow.fixed_fee_atomic === expectedFee && feeRow.percentage_bps === 0) {
        items.push({
          resource: 'withdrawal_fee_rules:v1',
          action: 'ALREADY_MATCHES',
          details: { feeRuleId: feeRow.id, status: feeRow.status },
          note: 'fee rule v1 already matches locked economics',
        });
      } else {
        items.push({
          resource: 'withdrawal_fee_rules:v1',
          action: 'CONFLICT',
          details: {
            feeRuleId: feeRow.id,
            fixedFeeAtomic: feeRow.fixed_fee_atomic,
            percentageBps: feeRow.percentage_bps,
          },
          note: 'existing fee rule conflicts; refuse rewrite',
        });
      }

      const limit = await client.query<{
        id: string;
        min_withdrawal_atomic: string;
        max_single_withdrawal_atomic: string;
        max_user_hourly_atomic: string;
        max_user_daily_atomic: string;
        max_hot_wallet_hourly_atomic: string;
        max_hot_wallet_daily_atomic: string;
        status: string;
      }>(
        `SELECT id,
                min_withdrawal_atomic::text AS min_withdrawal_atomic,
                max_single_withdrawal_atomic::text AS max_single_withdrawal_atomic,
                max_user_hourly_atomic::text AS max_user_hourly_atomic,
                max_user_daily_atomic::text AS max_user_daily_atomic,
                max_hot_wallet_hourly_atomic::text AS max_hot_wallet_hourly_atomic,
                max_hot_wallet_daily_atomic::text AS max_hot_wallet_daily_atomic,
                status::text AS status
         FROM withdrawal_limit_rules
         WHERE asset_id = $1::uuid AND network_id = $2::uuid
           AND rule_version = 1 AND risk_tier IS NULL
         LIMIT 1`,
        [usdtId, networkId],
      );
      const lim = limit.rows[0];
      const expected = {
        min: LOCKED_INITIAL_WITHDRAWAL.minWithdrawalAtomic.toString(10),
        maxSingle: LOCKED_INITIAL_WITHDRAWAL.maxSingleWithdrawalAtomic.toString(10),
        hourly: LOCKED_INITIAL_WITHDRAWAL.maxUserHourlyAtomic.toString(10),
        daily: LOCKED_INITIAL_WITHDRAWAL.maxUserDailyAtomic.toString(10),
        hwHourly: LOCKED_INITIAL_WITHDRAWAL.maxHotWalletHourlyAtomic.toString(10),
        hwDaily: LOCKED_INITIAL_WITHDRAWAL.maxHotWalletDailyAtomic.toString(10),
      };
      if (lim === undefined) {
        items.push({
          resource: 'withdrawal_limit_rules:v1',
          action: 'CREATE',
          details: {
            ...expected,
            lockedEconomics:
              'min 0.20 / max 5 / hourly 5 / daily 10 / HW hourly 25 / daily 100',
          },
          note: 'would insert locked Mainnet limit rule',
        });
      } else if (
        lim.min_withdrawal_atomic === expected.min &&
        lim.max_single_withdrawal_atomic === expected.maxSingle &&
        lim.max_user_hourly_atomic === expected.hourly &&
        lim.max_user_daily_atomic === expected.daily &&
        lim.max_hot_wallet_hourly_atomic === expected.hwHourly &&
        lim.max_hot_wallet_daily_atomic === expected.hwDaily
      ) {
        items.push({
          resource: 'withdrawal_limit_rules:v1',
          action: 'ALREADY_MATCHES',
          details: { limitRuleId: lim.id, status: lim.status },
          note: 'limit rule v1 already matches locked economics',
        });
      } else {
        items.push({
          resource: 'withdrawal_limit_rules:v1',
          action: 'CONFLICT',
          details: {
            limitRuleId: lim.id,
            min: lim.min_withdrawal_atomic,
            maxSingle: lim.max_single_withdrawal_atomic,
            hourly: lim.max_user_hourly_atomic,
            daily: lim.max_user_daily_atomic,
            hwHourly: lim.max_hot_wallet_hourly_atomic,
            hwDaily: lim.max_hot_wallet_daily_atomic,
          },
          note: 'existing limit rule conflicts; refuse rewrite',
        });
      }
    } else if (u === undefined) {
      items.push({
        resource: 'withdrawal_fee_rules:v1',
        action: 'CREATE',
        details: { dependsOn: 'assets:USDT' },
        note: 'fee rule deferred until USDT asset exists',
      });
      items.push({
        resource: 'withdrawal_limit_rules:v1',
        action: 'CREATE',
        details: { dependsOn: 'assets:USDT' },
        note: 'limit rule deferred until USDT asset exists',
      });
    }
  }

  items.push({
    resource: 'hot_wallets:MAINNET_SLOT',
    action: 'DOCUMENTED_ONLY',
    details: {
      networkCode: 'TON_MAINNET',
      walletVersion: 'v5R1',
      address: 'OWNER_DECISION_REQUIRED',
      signerReference: 'OWNER_DECISION_REQUIRED',
    },
    note: 'Hot Wallet slot documented; address/signer values not invented by bootstrap',
  });

  return items;
}

export async function runPhase21MainnetRegistryBootstrap(
  client: Phase21MainnetRegistryBootstrapClient,
  input: Phase21MainnetRegistryBootstrapInput,
  options?: { readonly forceApply?: boolean },
): Promise<Phase21MainnetRegistryBootstrapResult> {
  const applyAuthorized = options?.forceApply === true || applyGatesEnabled();
  const mode: Phase21MainnetRegistryBootstrapMode = applyAuthorized ? 'APPLY' : 'DRY_RUN';
  const items = await planPhase21MainnetRegistryBootstrap(client, input);
  const conflicts = items.filter((i) => i.action === 'CONFLICT');

  if (conflicts.length > 0) {
    return {
      mode,
      applyAuthorized,
      applied: false,
      items,
      conflicts,
      notes: [
        'Conflicts present - refuse apply',
        'No historical migration rewrite',
        'Step 3A must not execute against operational DB',
      ],
    };
  }

  if (mode === 'DRY_RUN') {
    return {
      mode: 'DRY_RUN',
      applyAuthorized: false,
      applied: false,
      items,
      conflicts: [],
      notes: [
        'DRY_RUN default',
        'Set PHASE21_MAINNET_REGISTRY_BOOTSTRAP_APPLY=1 and PHASE21_OPERATIONAL_CEREMONY_ENABLED=true to apply',
        'Hot Wallet values remain OWNER_DECISION_REQUIRED',
        'Step 3A implements tooling only',
      ],
    };
  }

  const master = assertUsdtMaster(input.usdtJettonMaster);
  let networkId: string | null = null;

  if (items.some((i) => i.resource === 'networks:TON_MAINNET' && i.action === 'CREATE')) {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO networks (
         code, chain, environment, display_name, global_chain_identifier, status
       ) VALUES (
         'TON_MAINNET', 'TON', 'MAINNET', $1, 'ton:mainnet', 'ACTIVE'
       )
       RETURNING id`,
      [input.networkDisplayName ?? 'TON Mainnet'],
    );
    networkId = inserted.rows[0]?.id ?? null;
  } else {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM networks WHERE code = 'TON_MAINNET' LIMIT 1`,
    );
    networkId = existing.rows[0]?.id ?? null;
  }

  if (networkId === null) {
    return {
      mode: 'APPLY',
      applyAuthorized: true,
      applied: false,
      items,
      conflicts: [],
      notes: ['APPLY aborted: TON_MAINNET network id unresolved'],
    };
  }

  if (items.some((i) => i.resource === 'assets:USDT' && i.action === 'CREATE')) {
    await client.query(
      `INSERT INTO assets (
         network_id, symbol, name, decimals, is_native, contract_identity, status
       ) VALUES (
         $1::uuid, 'USDT', $2, 6, false, $3, 'ACTIVE'
       )`,
      [networkId, input.usdtDisplayName ?? 'USDT', master],
    );
  }

  if (items.some((i) => i.resource === 'assets:GRAM' && i.action === 'CREATE')) {
    await client.query(
      `INSERT INTO assets (
         network_id, symbol, name, decimals, is_native, contract_identity, status
       ) VALUES (
         $1::uuid, 'GRAM', $2, 9, true, NULL, 'ACTIVE'
       )`,
      [networkId, input.gramDisplayName ?? 'Gram'],
    );
  }

  const usdt = await client.query<{ id: string }>(
    `SELECT id FROM assets
     WHERE network_id = $1::uuid AND symbol = 'USDT' AND contract_identity = $2
     LIMIT 1`,
    [networkId, master],
  );
  const usdtId = usdt.rows[0]?.id;
  if (usdtId !== undefined) {
    if (items.some((i) => i.resource === 'withdrawal_fee_rules:v1' && i.action === 'CREATE')) {
      await client.query(
        `INSERT INTO withdrawal_fee_rules (
           asset_id, network_id, rule_version, fixed_fee_atomic, percentage_bps,
           status, valid_from, reason
         ) VALUES (
           $1::uuid, $2::uuid, 1, $3, 0, 'ACTIVE', now(),
           'Phase 21 Mainnet registry bootstrap locked fee'
         )`,
        [usdtId, networkId, LOCKED_INITIAL_WITHDRAWAL.fixedFeeAtomic.toString(10)],
      );
    }
    if (items.some((i) => i.resource === 'withdrawal_limit_rules:v1' && i.action === 'CREATE')) {
      await client.query(
        `INSERT INTO withdrawal_limit_rules (
           asset_id, network_id, rule_version, risk_tier,
           min_withdrawal_atomic, max_single_withdrawal_atomic,
           max_user_hourly_atomic, max_user_daily_atomic,
           max_hot_wallet_hourly_atomic, max_hot_wallet_daily_atomic,
           max_auto_payout_atomic, wallet_change_cooldown_seconds,
           status, valid_from, reason
         ) VALUES (
           $1::uuid, $2::uuid, 1, NULL,
           $3, $4, $5, $6, $7, $8,
           NULL, $9,
           'ACTIVE', now(), 'Phase 21 Mainnet registry bootstrap locked limits'
         )`,
        [
          usdtId,
          networkId,
          LOCKED_INITIAL_WITHDRAWAL.minWithdrawalAtomic.toString(10),
          LOCKED_INITIAL_WITHDRAWAL.maxSingleWithdrawalAtomic.toString(10),
          LOCKED_INITIAL_WITHDRAWAL.maxUserHourlyAtomic.toString(10),
          LOCKED_INITIAL_WITHDRAWAL.maxUserDailyAtomic.toString(10),
          LOCKED_INITIAL_WITHDRAWAL.maxHotWalletHourlyAtomic.toString(10),
          LOCKED_INITIAL_WITHDRAWAL.maxHotWalletDailyAtomic.toString(10),
          LOCKED_INITIAL_WITHDRAWAL.walletChangeCooldownSeconds,
        ],
      );
    }
  }

  return {
    mode: 'APPLY',
    applyAuthorized: true,
    applied: true,
    items,
    conflicts: [],
    notes: [
      'Applied CREATE resources only',
      'Hot Wallet slot remains DOCUMENTED_ONLY',
      'No historical migration rewrite',
    ],
  };
}
