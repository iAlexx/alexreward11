/**
 * Phase 21 Mainnet registry bootstrap.
 *
 * PLAN: read-only; when network does NOT exist, still plans CREATE for
 * network + USDT + GRAM + fee/limit rules + hot_wallets DOCUMENTED_ONLY.
 * APPLY: one atomic transaction; ceremony gates + DB identity; advisory lock.
 * Never accepts forceApply.
 */
import type { PoolClient } from 'pg';

import { LOCKED_INITIAL_WITHDRAWAL } from './config.js';
import {
  assertPhase21CeremonyApplyGates,
  Phase21CeremonyApplyGateError,
  type Phase21CeremonyApplyGateClient,
} from './phase21-ceremony-apply-gates.js';
import {
  assertPhase21MainnetRegistryApplyConfirmation,
  type Phase21MainnetRegistryApplyConfirmation,
} from './phase21-ceremony-confirmations.js';
import { assertOwnerTrustMatchesLiveConnection } from './phase21-ceremony-verified-pool.js';
import { resolveCanonicalPhase21OwnerSeat } from './phase21-owner-ceremony-auth.js';
import {
  assertAuthenticatedPhase21OwnerCeremonyTrust,
  type AuthenticatedPhase21OwnerCeremonyTrust,
} from './phase21-owner-ceremony-trust.js';

export type Phase21MainnetRegistryBootstrapMode = 'PLAN' | 'APPLY' | 'REFUSED';

export interface Phase21MainnetRegistryBootstrapInput {
  readonly usdtJettonMaster: string;
  readonly networkDisplayName?: string;
  readonly usdtDisplayName?: string;
  readonly gramDisplayName?: string;
  /** Required for APPLY — branded Owner ceremony trust. PLAN may omit. */
  readonly ownerTrust?: AuthenticatedPhase21OwnerCeremonyTrust;
  readonly reason?: string | null;
}

/** APPLY-only input: branded Owner trust + branded confirmation are both required. */
export interface Phase21MainnetRegistryBootstrapApplyInput
  extends Phase21MainnetRegistryBootstrapInput {
  readonly ownerTrust: AuthenticatedPhase21OwnerCeremonyTrust;
  readonly applyConfirmation: Phase21MainnetRegistryApplyConfirmation;
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
  readonly refuseCode?: string;
}

export interface Phase21MainnetRegistryBootstrapClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
}

/** Advisory lock class for Mainnet registry APPLY serialization. */
export const PHASE21_MAINNET_REGISTRY_BOOTSTRAP_LOCK_KEY1 = 21000303;

const FORBIDDEN = ['TESTNET', 'LOCAL', 'PLACEHOLDER'] as const;

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

function pushHotWalletDocumented(items: Phase21MainnetRegistryPlanItem[]): void {
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
}

function expectedFeeAtomic(): string {
  return LOCKED_INITIAL_WITHDRAWAL.fixedFeeAtomic.toString(10);
}

function expectedLimits(): {
  min: string;
  maxSingle: string;
  hourly: string;
  daily: string;
  hwHourly: string;
  hwDaily: string;
  cooldown: number;
} {
  return {
    min: LOCKED_INITIAL_WITHDRAWAL.minWithdrawalAtomic.toString(10),
    maxSingle: LOCKED_INITIAL_WITHDRAWAL.maxSingleWithdrawalAtomic.toString(10),
    hourly: LOCKED_INITIAL_WITHDRAWAL.maxUserHourlyAtomic.toString(10),
    daily: LOCKED_INITIAL_WITHDRAWAL.maxUserDailyAtomic.toString(10),
    hwHourly: LOCKED_INITIAL_WITHDRAWAL.maxHotWalletHourlyAtomic.toString(10),
    hwDaily: LOCKED_INITIAL_WITHDRAWAL.maxHotWalletDailyAtomic.toString(10),
    cooldown: LOCKED_INITIAL_WITHDRAWAL.walletChangeCooldownSeconds,
  };
}

async function planUsdtAsset(
  client: Phase21MainnetRegistryBootstrapClient,
  items: Phase21MainnetRegistryPlanItem[],
  networkId: string | null,
  master: string,
): Promise<string | null> {
  if (networkId === null) {
    items.push({
      resource: 'assets:USDT',
      action: 'CREATE',
      details: {
        symbol: 'USDT',
        decimals: 6,
        isNative: false,
        contractIdentity: master,
        dependsOn: 'networks:TON_MAINNET',
      },
      note: 'would insert Mainnet USDT jetton asset after network CREATE',
    });
    return null;
  }

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
    return null;
  }
  if (
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
    return u.id;
  }
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
  return null;
}

async function planGramAsset(
  client: Phase21MainnetRegistryBootstrapClient,
  items: Phase21MainnetRegistryPlanItem[],
  networkId: string | null,
): Promise<void> {
  if (networkId === null) {
    items.push({
      resource: 'assets:GRAM',
      action: 'CREATE',
      details: {
        symbol: 'GRAM',
        decimals: 9,
        isNative: true,
        contractIdentity: null,
        dependsOn: 'networks:TON_MAINNET',
      },
      note: 'would insert native GRAM asset after network CREATE; chain remains TON_MAINNET',
    });
    return;
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
    return;
  }
  if (g.decimals === 9 && g.is_native === true && g.contract_identity === null) {
    items.push({
      resource: 'assets:GRAM',
      action: 'ALREADY_MATCHES',
      details: { assetId: g.id, status: g.status },
      note: 'GRAM native asset already present',
    });
    return;
  }
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

async function planFeeAndLimitRules(
  client: Phase21MainnetRegistryBootstrapClient,
  items: Phase21MainnetRegistryPlanItem[],
  networkId: string | null,
  usdtId: string | null,
): Promise<void> {
  const expectedFee = expectedFeeAtomic();
  const expected = expectedLimits();

  if (networkId === null || usdtId === null) {
    items.push({
      resource: 'withdrawal_fee_rules:v1',
      action: 'CREATE',
      details: {
        fixedFeeAtomic: expectedFee,
        percentageBps: 0,
        lockedEconomics: '0.01 USDT fixed',
        dependsOn: usdtId === null ? 'assets:USDT' : 'networks:TON_MAINNET',
      },
      note: 'would insert locked Mainnet fee rule after USDT exists',
    });
    items.push({
      resource: 'withdrawal_limit_rules:v1',
      action: 'CREATE',
      details: {
        ...expected,
        lockedEconomics:
          'min 0.20 / max 5 / hourly 5 / daily 10 / HW hourly 25 / daily 100',
        dependsOn: usdtId === null ? 'assets:USDT' : 'networks:TON_MAINNET',
      },
      note: 'would insert locked Mainnet limit rule after USDT exists',
    });
    return;
  }

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
  let networkId: string | null = null;

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
    networkId = net.id;
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
    networkId = net.id;
  }

  const usdtId = await planUsdtAsset(client, items, networkId, master);
  await planGramAsset(client, items, networkId);
  await planFeeAndLimitRules(client, items, networkId, usdtId);
  pushHotWalletDocumented(items);
  return items;
}

async function applyCreatesInTxn(
  client: PoolClient,
  input: Phase21MainnetRegistryBootstrapInput,
  items: readonly Phase21MainnetRegistryPlanItem[],
): Promise<void> {
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
    throw new Error('TON_MAINNET network id unresolved during APPLY');
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
  if (usdtId === undefined) {
    throw new Error('USDT asset unresolved during APPLY');
  }

  const limits = expectedLimits();
  if (items.some((i) => i.resource === 'withdrawal_fee_rules:v1' && i.action === 'CREATE')) {
    await client.query(
      `INSERT INTO withdrawal_fee_rules (
         asset_id, network_id, rule_version, fixed_fee_atomic, percentage_bps,
         status, valid_from, reason
       ) VALUES (
         $1::uuid, $2::uuid, 1, $3, 0, 'ACTIVE', now(),
         'Phase 21 Mainnet registry bootstrap locked fee'
       )`,
      [usdtId, networkId, expectedFeeAtomic()],
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
        limits.min,
        limits.maxSingle,
        limits.hourly,
        limits.daily,
        limits.hwHourly,
        limits.hwDaily,
        limits.cooldown,
      ],
    );
  }
}

/**
 * Atomic one-pass APPLY. Zero registry ? complete in ONE transaction.
 * Second run ? all ALREADY_MATCHES (hot wallet remains DOCUMENTED_ONLY).
 */
export async function applyPhase21MainnetRegistryBootstrap(
  client: PoolClient,
  input: Phase21MainnetRegistryBootstrapApplyInput,
): Promise<Phase21MainnetRegistryBootstrapResult> {
  try {
    assertUsdtMaster(input.usdtJettonMaster);
  } catch (error: unknown) {
    return {
      mode: 'REFUSED',
      applyAuthorized: false,
      applied: false,
      items: [],
      conflicts: [],
      notes: [error instanceof Error ? error.message : String(error)],
      refuseCode: 'INVALID_USDT_MASTER',
    };
  }

  try {
    assertAuthenticatedPhase21OwnerCeremonyTrust(input.ownerTrust);
    assertPhase21MainnetRegistryApplyConfirmation(input.applyConfirmation);
    await assertOwnerTrustMatchesLiveConnection(client, input.ownerTrust);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      mode: 'REFUSED',
      applyAuthorized: false,
      applied: false,
      items: [],
      conflicts: [],
      notes: [`APPLY refused: ${message}`],
      refuseCode: 'OWNER_TRUST_OR_CONFIRMATION_REQUIRED',
    };
  }

  try {
    await assertPhase21CeremonyApplyGates(
      client as Phase21CeremonyApplyGateClient,
      'PHASE21_MAINNET_REGISTRY_BOOTSTRAP_APPLY',
    );
  } catch (error: unknown) {
    const code =
      error instanceof Phase21CeremonyApplyGateError ? error.code : 'APPLY_GATE_FAILED';
    const message = error instanceof Error ? error.message : String(error);
    return {
      mode: 'REFUSED',
      applyAuthorized: false,
      applied: false,
      items: [],
      conflicts: [],
      notes: [`APPLY refused: ${message}`],
      refuseCode: code,
    };
  }

  type TxLifecycle = 'NOT_STARTED' | 'BEGUN' | 'MUTATION_EXECUTED' | 'COMMIT_CONFIRMED';
  let lifecycle: TxLifecycle = 'NOT_STARTED';
  await client.query('BEGIN');
  lifecycle = 'BEGUN';
  try {
    await client.query(
      `SELECT pg_advisory_xact_lock($1::int, hashtext('phase21-mainnet-registry-bootstrap'))`,
      [PHASE21_MAINNET_REGISTRY_BOOTSTRAP_LOCK_KEY1],
    );

    const planned = await planPhase21MainnetRegistryBootstrap(client, input);
    const conflicts = planned.filter((i) => i.action === 'CONFLICT');
    if (conflicts.length > 0) {
      await client.query('ROLLBACK');
      return {
        mode: 'REFUSED',
        applyAuthorized: true,
        applied: false,
        items: planned,
        conflicts,
        notes: [
          'Conflicts present - refuse apply; transaction rolled back',
          'No historical migration rewrite',
        ],
        refuseCode: 'CONFLICTS_PRESENT',
      };
    }

    await applyCreatesInTxn(client, input, planned);
    lifecycle = 'MUTATION_EXECUTED';

    const seat = await resolveCanonicalPhase21OwnerSeat(client, input.ownerTrust!.adminUserId);
    if (seat.adminUserId !== input.ownerTrust!.adminUserId) {
      await client.query('ROLLBACK');
      return {
        mode: 'REFUSED',
        applyAuthorized: false,
        applied: false,
        items: planned,
        conflicts: [],
        notes: ['canonical Owner seat holder does not match Owner ceremony trust'],
        refuseCode: 'OWNER_SEAT_TRUST_MISMATCH',
      };
    }
    const owner = { adminUserId: input.ownerTrust!.adminUserId };
    const reason =
      (input.reason ?? '').trim() || 'Phase 21 Mainnet registry bootstrap ceremony';

    const verified = await planPhase21MainnetRegistryBootstrap(client, input);
    const incomplete = verified.filter(
      (i) =>
        i.action !== 'ALREADY_MATCHES' &&
        i.action !== 'DOCUMENTED_ONLY',
    );
    if (incomplete.length > 0) {
      await client.query('ROLLBACK');
      return {
        mode: 'REFUSED',
        applyAuthorized: true,
        applied: false,
        items: verified,
        conflicts: incomplete.filter((i) => i.action === 'CONFLICT'),
        notes: [
          'Post-apply re-assert failed — transaction rolled back',
          ...incomplete.map((i) => `${i.resource}:${i.action}`),
        ],
        refuseCode: 'POST_APPLY_VERIFY_FAILED',
      };
    }

    const networkRow = await client.query<{ id: string }>(
      `SELECT id FROM networks WHERE code = 'TON_MAINNET' LIMIT 1`,
    );
    const usdtRow = await client.query<{ id: string; contract_identity: string | null }>(
      `SELECT id, contract_identity FROM assets
       WHERE symbol = 'USDT' AND network_id = $1::uuid LIMIT 1`,
      [networkRow.rows[0]?.id],
    );
    const gramRow = await client.query<{ id: string }>(
      `SELECT id FROM assets WHERE symbol = 'GRAM' AND network_id = $1::uuid LIMIT 1`,
      [networkRow.rows[0]?.id],
    );
    const feeRow = await client.query<{ id: string }>(
      `SELECT id FROM withdrawal_fee_rules WHERE network_id = $1::uuid ORDER BY rule_version LIMIT 1`,
      [networkRow.rows[0]?.id],
    );
    const limitRow = await client.query<{ id: string }>(
      `SELECT id FROM withdrawal_limit_rules WHERE network_id = $1::uuid ORDER BY rule_version LIMIT 1`,
      [networkRow.rows[0]?.id],
    );

    await client.query(
      `INSERT INTO audit_logs (
         admin_user_id, actor_type, action_type, resource_type, resource_id,
         after_snapshot, reason, source
       ) VALUES (
         $1::uuid, 'ADMIN'::actor_type, 'phase21.mainnet_registry.bootstrap', 'network', $2::uuid,
         $3::jsonb, $4, 'SYSTEM'::actor_source
       )`,
      [
        owner.adminUserId,
        networkRow.rows[0]?.id,
        JSON.stringify({
          networkId: networkRow.rows[0]?.id ?? null,
          usdtAssetId: usdtRow.rows[0]?.id ?? null,
          gramAssetId: gramRow.rows[0]?.id ?? null,
          usdtJettonMaster: usdtRow.rows[0]?.contract_identity ?? input.usdtJettonMaster,
          feeRuleId: feeRow.rows[0]?.id ?? null,
          limitRuleId: limitRow.rows[0]?.id ?? null,
          adminUserId: owner.adminUserId,
          reason,
          source: 'phase21',
        }),
        reason,
      ],
    );

    try {
      await client.query('COMMIT');
      lifecycle = 'COMMIT_CONFIRMED';
    } catch (commitError: unknown) {
      const message = commitError instanceof Error ? commitError.message : String(commitError);
      return {
        mode: 'REFUSED',
        applyAuthorized: true,
        applied: false,
        items: verified,
        conflicts: [],
        notes: [
          `REGISTRATION_RECONCILIATION_REQUIRED — COMMIT failed after mutation; do not claim rollback: ${message}`,
          'DO_NOT_RETRY until reconciled',
        ],
        refuseCode: 'REGISTRATION_RECONCILIATION_REQUIRED',
      };
    }
    return {
      mode: 'APPLY',
      applyAuthorized: true,
      applied: true,
      items: verified,
      conflicts: [],
      notes: [
        'Applied CREATE resources in one atomic transaction',
        'Hot Wallet slot remains DOCUMENTED_ONLY',
        'No historical migration rewrite',
        'Idempotent second apply yields ALREADY_MATCHES',
        'audit_logs snapshot written',
      ],
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    let rollbackConfirmed = false;
    try {
      await client.query('ROLLBACK');
      rollbackConfirmed = true;
    } catch {
      rollbackConfirmed = false;
    }
    if (lifecycle === 'MUTATION_EXECUTED' && !rollbackConfirmed) {
      return {
        mode: 'REFUSED',
        applyAuthorized: true,
        applied: false,
        items: [],
        conflicts: [],
        notes: [
          `REGISTRATION_RECONCILIATION_REQUIRED — ROLLBACK failed after mutation; mutationState=UNKNOWN: ${message}`,
          'DO_NOT_RETRY until reconciled',
        ],
        refuseCode: 'REGISTRATION_RECONCILIATION_REQUIRED',
      };
    }
    if (lifecycle === 'MUTATION_EXECUTED' && rollbackConfirmed) {
      return {
        mode: 'REFUSED',
        applyAuthorized: true,
        applied: false,
        items: [],
        conflicts: [],
        notes: [`TRANSACTION_ABORTED_CONFIRMED after mutation: ${message}`],
        refuseCode: 'TRANSACTION_ABORTED_CONFIRMED',
      };
    }
    return {
      mode: 'REFUSED',
      applyAuthorized: true,
      applied: false,
      items: [],
      conflicts: [],
      notes: [
        rollbackConfirmed
          ? `PRE_MUTATION_FAILURE — APPLY aborted and rolled back: ${message}`
          : `PRE_MUTATION_FAILURE — APPLY aborted; ROLLBACK not confirmed: ${message}`,
      ],
      refuseCode: rollbackConfirmed ? 'PRE_MUTATION_FAILURE' : 'APPLY_EXCEPTION',
    };
  }
}

/**
 * Convenience PLAN wrapper (read-only). Prefer planPhase21MainnetRegistryBootstrap.
 */
export async function runPhase21MainnetRegistryBootstrap(
  client: Phase21MainnetRegistryBootstrapClient,
  input: Phase21MainnetRegistryBootstrapInput,
): Promise<Phase21MainnetRegistryBootstrapResult> {
  const items = await planPhase21MainnetRegistryBootstrap(client, input);
  const conflicts = items.filter((i) => i.action === 'CONFLICT');
  return {
    mode: 'PLAN',
    applyAuthorized: false,
    applied: false,
    items,
    conflicts,
    notes: [
      'PLAN only (read-only)',
      'APPLY requires applyPhase21MainnetRegistryBootstrap + DEPLOYMENT_ENV=production + ceremony gates + PHASE21_CEREMONY_REQUIRED_DATABASE_NAME',
      'forceApply is not supported',
      'Hot Wallet values remain OWNER_DECISION_REQUIRED',
    ],
  };
}
