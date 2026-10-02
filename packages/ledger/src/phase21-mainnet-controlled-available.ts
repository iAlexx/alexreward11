/**
 * Phase 21 Mainnet controlled Owner-operated Available provisioning.
 *
 * Forever separate from Phase 10 Testnet provision — do not merge paths.
 *
 * PRIMARY operator boundary: authorized host/shell access (internal CLI).
 * Not a cryptographically authenticated Control Center / Telegram Owner action.
 * Resolves a configured Owner admin + ACTIVE OWNER RBAC for audit standing only.
 *
 * Control Center remains ledger-free — do not import this from control-center/bot.
 */
import type { PoolClient } from 'pg';

import { getOrCreateLedgerAccount } from './accounts.js';
import { amountAtomicToString, parsePositiveAtomicAmount } from './amounts.js';
import { type LedgerDb, withLedgerTransaction } from './db.js';
import { LedgerDomainError } from './errors.js';
import { postLedgerTransaction } from './posting.js';
import { reverseLedgerTransaction } from './reverse.js';
import type { PostedLedgerTransaction } from './types.js';
import {
  PHASE21_CONTROLLED_AVAILABLE_CAMPAIGN_CEILING_ATOMIC,
  PHASE21_CONTROLLED_PROVISION_ASSET_SYMBOL,
  PHASE21_CONTROLLED_PROVISION_CHAIN,
  PHASE21_CONTROLLED_PROVISION_ENVIRONMENT,
  PHASE21_CONTROLLED_PROVISION_GLOBAL_CHAIN_ID,
  PHASE21_CONTROLLED_PROVISION_NETWORK_CODE,
  PHASE21_OPERATIONAL_DATABASE_NAME,
} from './phase21-mainnet-controlled-available-assets.js';

export const PHASE21_PROVISION_BUSINESS_REF_TYPE =
  'phase21-mainnet-controlled-available-provision';
export const PHASE21_PROVISION_IDEMPOTENCY_SCOPE =
  'phase21.mainnet.controlled.available.provision';
export const PHASE21_REVERSE_BUSINESS_REF_TYPE =
  'phase21-mainnet-controlled-available-provision-reverse';
export const PHASE21_REVERSE_IDEMPOTENCY_SCOPE =
  'phase21.mainnet.controlled.available.provision.reverse';
export const PHASE21_PROVISION_AUDIT_ACTION = 'OWNER_MAINNET_CONTROLLED_AVAILABLE_PROVISION';
export const PHASE21_REVERSE_AUDIT_ACTION =
  'OWNER_MAINNET_CONTROLLED_AVAILABLE_PROVISION_REVERSE';
export const PHASE21_PROVISION_TOOL_VERSION = '1.0.0-phase21';

/** Advisory lock class for campaign aggregate ceiling serialization. */
export const PHASE21_CAMPAIGN_CEILING_LOCK_KEY1 = 21000301;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const FORBIDDEN_JETTON_MARKERS = ['TESTNET', 'LOCAL', 'PLACEHOLDER'] as const;

export interface Phase21ControlledAvailableProvisionRuntimeConfig {
  readonly enabled: boolean;
  readonly deploymentEnv: 'local' | 'test' | 'staging' | 'production';
  /**
   * From PHASE21_OPERATIONAL_CEREMONY_ENABLED.
   * Required true (with enabled) for production operational ceremony mode.
   * Test/local may run with this false.
   */
  readonly operationalCeremonyEnabled: boolean;
  readonly withdrawalNetworkCode: string;
  readonly withdrawalAssetSymbol: string;
  readonly allowedUserId: string;
  readonly maxAmountAtomic: string;
  readonly ownerAdminUserId: string;
  readonly campaignId: string;
  /** Exact Mainnet USDT Jetton master; never TESTNET/LOCAL/PLACEHOLDER. */
  readonly requiredUsdtJettonMaster: string;
  /**
   * Test/local: optional; when set must match current_database().
   * Production operational ceremony: required non-empty; must match current_database().
   * May equal the operational DB name only on the production ceremony path.
   */
  readonly requiredDatabaseName: string;
}

export interface Phase21ProvisionIntent {
  readonly operationId: string;
  readonly targetUserId: string;
  readonly amountAtomic: string;
  readonly assetId: string;
  readonly networkId: string;
  readonly campaignId: string;
  readonly reason: string;
}

export interface Phase21ProvisionResult {
  readonly operationId: string;
  readonly ledgerTransactionId: string;
  readonly targetUserId: string;
  readonly amountAtomic: string;
  readonly assetId: string;
  readonly networkId: string;
  readonly campaignId: string;
  readonly created: boolean;
  readonly adminUserId: string;
  readonly auditLogId: string;
}

export interface Phase21ProvisionReverseResult {
  readonly operationId: string;
  readonly originalLedgerTransactionId: string;
  readonly reversalLedgerTransactionId: string;
  readonly targetUserId: string;
  readonly amountAtomic: string;
  readonly created: boolean;
  readonly adminUserId: string;
  readonly auditLogId: string;
}

function assertUuid(value: string, label: string): string {
  const trimmed = value.trim();
  if (!UUID_RE.test(trimmed)) {
    throw new LedgerDomainError('VALIDATION', `${label} must be a UUID`, {
      details: { reason: 'INVALID_UUID', label },
    });
  }
  return trimmed;
}

function assertNonEmptyReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length === 0 || trimmed.length > 500) {
    throw new LedgerDomainError('VALIDATION', 'reason must be non-empty and at most 500 chars', {
      details: { reason: 'INVALID_REASON' },
    });
  }
  return trimmed;
}

function provisionIdempotencyKey(operationId: string): string {
  return `provision:${operationId}`;
}

function reverseIdempotencyKey(operationId: string): string {
  return `provision-reverse:${operationId}`;
}

function assertUsdtJettonMasterNotPlaceholder(master: string): string {
  const trimmed = master.trim();
  if (trimmed.length === 0) {
    throw new LedgerDomainError('VALIDATION', 'requiredUsdtJettonMaster is required', {
      details: { reason: 'REQUIRED_JETTON_MASTER_MISSING' },
    });
  }
  const upper = trimmed.toUpperCase();
  for (const marker of FORBIDDEN_JETTON_MARKERS) {
    if (upper.includes(marker)) {
      throw new LedgerDomainError(
        'VALIDATION',
        'requiredUsdtJettonMaster must not contain TESTNET/LOCAL/PLACEHOLDER',
        { details: { reason: 'JETTON_MASTER_PLACEHOLDER_FORBIDDEN', marker } },
      );
    }
  }
  return trimmed;
}

function isTestProvisionMode(
  deploymentEnv: Phase21ControlledAvailableProvisionRuntimeConfig['deploymentEnv'],
): boolean {
  return deploymentEnv === 'local' || deploymentEnv === 'test';
}

function assertFeatureAndEnv(config: Phase21ControlledAvailableProvisionRuntimeConfig): void {
  if (!config.enabled) {
    throw new LedgerDomainError(
      'VALIDATION',
      'Phase 21 Mainnet controlled Available provisioning is disabled',
      { details: { reason: 'PROVISION_DISABLED' } },
    );
  }
  if (config.deploymentEnv === 'staging') {
    throw new LedgerDomainError(
      'VALIDATION',
      'Phase 21 controlled Available provisioning is forbidden in staging',
      {
        details: {
          reason: 'STAGING_PROVISION_FORBIDDEN',
          deploymentEnv: config.deploymentEnv,
        },
      },
    );
  }
  if (config.deploymentEnv === 'production') {
    if (config.operationalCeremonyEnabled !== true) {
      throw new LedgerDomainError(
        'VALIDATION',
        'Phase 21 production provision requires operational ceremony gate',
        {
          details: {
            reason: 'OPERATIONAL_CEREMONY_GATE_REQUIRED',
            deploymentEnv: config.deploymentEnv,
            operationalCeremonyEnabled: config.operationalCeremonyEnabled,
          },
        },
      );
    }
  } else if (!isTestProvisionMode(config.deploymentEnv)) {
    throw new LedgerDomainError(
      'VALIDATION',
      'Phase 21 controlled Available provisioning deploymentEnv is invalid',
      { details: { reason: 'INVALID_DEPLOYMENT_ENV', deploymentEnv: config.deploymentEnv } },
    );
  }
  if (config.withdrawalNetworkCode !== PHASE21_CONTROLLED_PROVISION_NETWORK_CODE) {
    throw new LedgerDomainError('VALIDATION', 'withdrawal network must be exactly TON_MAINNET', {
      details: {
        reason: 'NETWORK_CODE_MISMATCH',
        configured: config.withdrawalNetworkCode,
      },
    });
  }
  if (config.withdrawalAssetSymbol !== PHASE21_CONTROLLED_PROVISION_ASSET_SYMBOL) {
    throw new LedgerDomainError('VALIDATION', 'withdrawal asset must be exactly USDT', {
      details: {
        reason: 'ASSET_SYMBOL_NOT_ALLOWLISTED',
        configured: config.withdrawalAssetSymbol,
        allowlist: [PHASE21_CONTROLLED_PROVISION_ASSET_SYMBOL],
      },
    });
  }
  if (
    config.withdrawalAssetSymbol.toUpperCase() === 'GRAM' ||
    config.withdrawalAssetSymbol.toUpperCase() === 'TON'
  ) {
    throw new LedgerDomainError('VALIDATION', 'GRAM/TON native assets are forbidden for provision', {
      details: { reason: 'NATIVE_ASSET_FORBIDDEN', configured: config.withdrawalAssetSymbol },
    });
  }
  assertUuid(config.campaignId, 'campaignId');
  assertUuid(config.allowedUserId, 'allowedUserId');
  assertUuid(config.ownerAdminUserId, 'ownerAdminUserId');
  assertUsdtJettonMasterNotPlaceholder(config.requiredUsdtJettonMaster);
}

/**
 * Database identity gate for Phase 21 controlled provision.
 * Test/local: refuse accidental connection to operational DB name; required name optional.
 * Production operational ceremony: required name mandatory and must match; ops DB allowed.
 */
export async function assertPhase21ProvisionDatabaseIdentity(
  client: PoolClient,
  config: Pick<
    Phase21ControlledAvailableProvisionRuntimeConfig,
    'deploymentEnv' | 'operationalCeremonyEnabled' | 'requiredDatabaseName'
  >,
): Promise<void> {
  const required = config.requiredDatabaseName.trim();
  const testMode = isTestProvisionMode(config.deploymentEnv);
  const operationalCeremony =
    config.deploymentEnv === 'production' && config.operationalCeremonyEnabled === true;

  if (operationalCeremony && required.length === 0) {
    throw new LedgerDomainError(
      'VALIDATION',
      'production operational ceremony requires non-empty requiredDatabaseName',
      { details: { reason: 'REQUIRED_DATABASE_NAME_MISSING' } },
    );
  }

  const result = await client.query<{ name: string }>(`SELECT current_database() AS name`);
  const current = result.rows[0]?.name;
  if (current === undefined) {
    throw new LedgerDomainError('INTERNAL', 'current_database() returned no row');
  }

  if (testMode) {
    if (current === PHASE21_OPERATIONAL_DATABASE_NAME) {
      throw new LedgerDomainError(
        'VALIDATION',
        'connected database is the operational alex_rewards database',
        { details: { reason: 'OPERATIONAL_DATABASE_CONNECTED', database: current } },
      );
    }
    if (required.length === 0) {
      return;
    }
    if (required === PHASE21_OPERATIONAL_DATABASE_NAME) {
      throw new LedgerDomainError(
        'VALIDATION',
        'Phase 21 test/local provision cannot require the operational database name',
        { details: { reason: 'OPERATIONAL_DATABASE_FORBIDDEN', database: required } },
      );
    }
    if (current !== required) {
      throw new LedgerDomainError(
        'VALIDATION',
        'connected database does not match required database identity',
        {
          details: {
            reason: 'DATABASE_IDENTITY_MISMATCH',
            required,
            current,
          },
        },
      );
    }
    return;
  }

  if (operationalCeremony) {
    if (current !== required) {
      throw new LedgerDomainError(
        'VALIDATION',
        'connected database does not match required database identity',
        {
          details: {
            reason: 'DATABASE_IDENTITY_MISMATCH',
            required,
            current,
          },
        },
      );
    }
    return;
  }

  throw new LedgerDomainError(
    'VALIDATION',
    'Phase 21 provision database identity check refused for this mode',
    {
      details: {
        reason: 'DATABASE_IDENTITY_MODE_FORBIDDEN',
        deploymentEnv: config.deploymentEnv,
        operationalCeremonyEnabled: config.operationalCeremonyEnabled,
      },
    },
  );
}

async function resolveOwnerAdmin(
  client: PoolClient,
  ownerAdminUserId: string,
): Promise<{ adminUserId: string }> {
  const adminId = assertUuid(ownerAdminUserId, 'ownerAdminUserId');
  const admin = await client.query<{ id: string; status: string }>(
    `SELECT id, status::text AS status
     FROM admin_users
     WHERE id = $1::uuid
     LIMIT 1`,
    [adminId],
  );
  const row = admin.rows[0];
  if (row === undefined || row.status !== 'ACTIVE') {
    throw new LedgerDomainError('VALIDATION', 'configured Owner admin is missing or inactive', {
      details: { reason: 'OWNER_ADMIN_NOT_ACTIVE' },
    });
  }

  const binding = await client.query<{ c: number }>(
    `SELECT count(*)::int AS c
     FROM admin_role_bindings b
     INNER JOIN admin_roles r ON r.id = b.role_id
     WHERE b.admin_user_id = $1::uuid
       AND r.code = 'OWNER'
       AND r.status = 'ACTIVE'
       AND b.revoked_at IS NULL`,
    [adminId],
  );
  if ((binding.rows[0]?.c ?? 0) < 1) {
    throw new LedgerDomainError(
      'VALIDATION',
      'configured Owner admin lacks ACTIVE OWNER role binding',
      { details: { reason: 'OWNER_BINDING_MISSING' } },
    );
  }

  return { adminUserId: row.id };
}

async function resolveMainnetUsdtAsset(
  client: PoolClient,
  config: Phase21ControlledAvailableProvisionRuntimeConfig,
): Promise<{ networkId: string; assetId: string; symbol: string }> {
  await assertPhase21ProvisionDatabaseIdentity(client, config);

  const expectedMaster = assertUsdtJettonMasterNotPlaceholder(config.requiredUsdtJettonMaster);
  const networkCode = PHASE21_CONTROLLED_PROVISION_NETWORK_CODE;
  const symbol = PHASE21_CONTROLLED_PROVISION_ASSET_SYMBOL;

  const network = await client.query<{
    id: string;
    code: string;
    status: string;
    chain: string;
    environment: string;
    global_chain_identifier: string | null;
  }>(
    `SELECT id, code, status::text AS status, chain,
            environment::text AS environment,
            global_chain_identifier::text AS global_chain_identifier
     FROM networks
     WHERE code = $1
     LIMIT 1`,
    [networkCode],
  );
  const net = network.rows[0];
  if (net === undefined) {
    throw new LedgerDomainError('VALIDATION', 'network not found', {
      details: { reason: 'NETWORK_NOT_FOUND', code: networkCode },
    });
  }
  if (net.code !== PHASE21_CONTROLLED_PROVISION_NETWORK_CODE) {
    throw new LedgerDomainError('VALIDATION', 'authoritative network must be TON_MAINNET', {
      details: { reason: 'NETWORK_NOT_MAINNET', code: net.code },
    });
  }
  if (net.chain !== PHASE21_CONTROLLED_PROVISION_CHAIN) {
    throw new LedgerDomainError('VALIDATION', 'network chain must be TON', {
      details: { reason: 'NETWORK_CHAIN_MISMATCH', chain: net.chain },
    });
  }
  if (net.environment !== PHASE21_CONTROLLED_PROVISION_ENVIRONMENT) {
    throw new LedgerDomainError('VALIDATION', 'network environment must be MAINNET', {
      details: { reason: 'NETWORK_ENVIRONMENT_MISMATCH', environment: net.environment },
    });
  }
  if (net.status !== 'ACTIVE') {
    throw new LedgerDomainError('VALIDATION', 'network is not ACTIVE', {
      details: { reason: 'NETWORK_INACTIVE', networkId: net.id },
    });
  }
  const gci = (net.global_chain_identifier ?? '').trim();
  if (gci !== PHASE21_CONTROLLED_PROVISION_GLOBAL_CHAIN_ID) {
    throw new LedgerDomainError('VALIDATION', 'network global_chain_identifier must be ton:mainnet', {
      details: { reason: 'NETWORK_GLOBAL_ID_MISMATCH', globalChainIdentifier: gci },
    });
  }

  const asset = await client.query<{
    id: string;
    symbol: string;
    status: string;
    network_id: string;
    decimals: number;
    is_native: boolean;
    contract_identity: string | null;
  }>(
    `SELECT id, symbol, status::text AS status, network_id::text AS network_id,
            decimals::int AS decimals, is_native,
            contract_identity
     FROM assets
     WHERE network_id = $1::uuid
       AND symbol = $2
       AND contract_identity = $3
     LIMIT 1`,
    [net.id, symbol, expectedMaster],
  );
  const a = asset.rows[0];
  if (a === undefined) {
    throw new LedgerDomainError('VALIDATION', 'USDT asset not found on Mainnet network', {
      details: {
        reason: 'ASSET_NOT_FOUND',
        networkId: net.id,
        symbol,
        contractIdentity: expectedMaster,
      },
    });
  }
  if (a.status !== 'ACTIVE') {
    throw new LedgerDomainError('VALIDATION', 'USDT asset is not ACTIVE', {
      details: { reason: 'ASSET_INACTIVE', assetId: a.id, symbol },
    });
  }
  if (a.symbol !== symbol || a.network_id !== net.id) {
    throw new LedgerDomainError('VALIDATION', 'asset/network mismatch', {
      details: { reason: 'ASSET_NETWORK_MISMATCH' },
    });
  }
  if (a.is_native) {
    throw new LedgerDomainError('VALIDATION', 'USDT asset must be non-native', {
      details: { reason: 'ASSET_MUST_BE_NON_NATIVE', assetId: a.id },
    });
  }
  if (a.decimals !== 6) {
    throw new LedgerDomainError('VALIDATION', 'USDT asset decimals must be 6', {
      details: { reason: 'ASSET_DECIMALS_MISMATCH', expected: 6, actual: a.decimals },
    });
  }
  const contract = (a.contract_identity ?? '').trim();
  if (contract !== expectedMaster) {
    throw new LedgerDomainError('VALIDATION', 'USDT Jetton master mismatch', {
      details: {
        reason: 'ASSET_CONTRACT_MISMATCH',
        expected: expectedMaster,
        actual: contract,
      },
    });
  }

  return { networkId: net.id, assetId: a.id, symbol: a.symbol };
}

async function assertTargetUserForProvision(
  client: PoolClient,
  config: Phase21ControlledAvailableProvisionRuntimeConfig,
  targetUserId: string,
): Promise<string> {
  const userId = assertUuid(targetUserId, 'userId');
  const allowed = assertUuid(config.allowedUserId, 'allowedUserId');
  if (userId !== allowed) {
    throw new LedgerDomainError(
      'VALIDATION',
      'target user is not the configured Phase 21 allowlisted user',
      { details: { reason: 'USER_NOT_ALLOWLISTED' } },
    );
  }

  const user = await client.query<{
    id: string;
    status: string;
    withdrawal_status: string;
  }>(
    `SELECT id, status::text AS status, withdrawal_status::text AS withdrawal_status
     FROM users
     WHERE id = $1::uuid
     LIMIT 1`,
    [userId],
  );
  const row = user.rows[0];
  if (row === undefined) {
    throw new LedgerDomainError('VALIDATION', 'target user not found', {
      details: { reason: 'USER_NOT_FOUND' },
    });
  }
  if (row.status !== 'ACTIVE') {
    throw new LedgerDomainError('VALIDATION', 'target user is not ACTIVE', {
      details: { reason: 'USER_INACTIVE', status: row.status },
    });
  }
  if (row.withdrawal_status === 'BLOCKED') {
    throw new LedgerDomainError('VALIDATION', 'target user is withdrawal-BLOCKED', {
      details: { reason: 'USER_WITHDRAWAL_BLOCKED' },
    });
  }
  return row.id;
}

async function assertTargetUserForReverse(
  client: PoolClient,
  config: Phase21ControlledAvailableProvisionRuntimeConfig,
  targetUserId: string,
): Promise<string> {
  const userId = assertUuid(targetUserId, 'userId');
  const allowed = assertUuid(config.allowedUserId, 'allowedUserId');
  if (userId !== allowed) {
    throw new LedgerDomainError(
      'VALIDATION',
      'target user is not the configured Phase 21 allowlisted user',
      { details: { reason: 'USER_NOT_ALLOWLISTED' } },
    );
  }
  const user = await client.query<{ id: string }>(
    `SELECT id FROM users WHERE id = $1::uuid LIMIT 1`,
    [userId],
  );
  if (user.rows[0] === undefined) {
    throw new LedgerDomainError('VALIDATION', 'target user not found', {
      details: { reason: 'USER_NOT_FOUND' },
    });
  }
  return user.rows[0].id;
}

function readProvisionIntent(metadata: unknown): Phase21ProvisionIntent | null {
  if (metadata === null || typeof metadata !== 'object') return null;
  const root = metadata as Record<string, unknown>;
  const intent = root.phase21ProvisionIntent;
  if (intent === null || typeof intent !== 'object') return null;
  const o = intent as Record<string, unknown>;
  if (
    typeof o.operationId !== 'string' ||
    typeof o.targetUserId !== 'string' ||
    typeof o.amountAtomic !== 'string' ||
    typeof o.assetId !== 'string' ||
    typeof o.networkId !== 'string' ||
    typeof o.campaignId !== 'string' ||
    typeof o.reason !== 'string'
  ) {
    return null;
  }
  return {
    operationId: o.operationId,
    targetUserId: o.targetUserId,
    amountAtomic: o.amountAtomic,
    assetId: o.assetId,
    networkId: o.networkId,
    campaignId: o.campaignId,
    reason: o.reason,
  };
}

function assertIntentMatch(
  expected: Phase21ProvisionIntent,
  stored: Phase21ProvisionIntent | null,
): void {
  if (stored === null) {
    throw new LedgerDomainError(
      'IDEMPOTENCY_CONFLICT',
      'existing provision transaction missing application intent metadata',
      { details: { reason: 'INTENT_METADATA_MISSING' } },
    );
  }
  if (
    stored.operationId !== expected.operationId ||
    stored.targetUserId !== expected.targetUserId ||
    stored.amountAtomic !== expected.amountAtomic ||
    stored.assetId !== expected.assetId ||
    stored.networkId !== expected.networkId ||
    stored.campaignId !== expected.campaignId ||
    stored.reason !== expected.reason
  ) {
    throw new LedgerDomainError(
      'IDEMPOTENCY_CONFLICT',
      'same operationId with different financial intent',
      { details: { reason: 'INTENT_MISMATCH' } },
    );
  }
}

async function lockCampaignCeiling(client: PoolClient, campaignId: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock($1::int, hashtext($2::text))`, [
    PHASE21_CAMPAIGN_CEILING_LOCK_KEY1,
    campaignId,
  ]);
}

async function sumNonReversedCampaignCredits(
  client: PoolClient,
  campaignId: string,
): Promise<bigint> {
  const result = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(e.amount_atomic), 0)::text AS total
     FROM ledger_transactions t
     INNER JOIN ledger_entries e ON e.ledger_transaction_id = t.id
     INNER JOIN ledger_accounts a ON a.id = e.ledger_account_id
     WHERE t.business_reference_type = $1
       AND COALESCE(t.metadata->>'campaignId', t.metadata->'phase21ProvisionIntent'->>'campaignId') = $2
       AND e.direction = 'CREDIT'
       AND a.account_type = 'USER_AVAILABLE_LIABILITY'
       AND NOT EXISTS (
         SELECT 1 FROM ledger_transactions r
         WHERE r.reverses_transaction_id = t.id
       )`,
    [PHASE21_PROVISION_BUSINESS_REF_TYPE, campaignId],
  );
  return BigInt(result.rows[0]?.total ?? '0');
}

async function findExistingProvision(
  client: PoolClient,
  operationId: string,
): Promise<{ id: string; metadata: unknown } | null> {
  const result = await client.query<{ id: string; metadata: unknown }>(
    `SELECT id, metadata FROM ledger_transactions
     WHERE business_reference_type = $1
       AND business_reference_id = $2::uuid
     LIMIT 1`,
    [PHASE21_PROVISION_BUSINESS_REF_TYPE, operationId],
  );
  return result.rows[0] ?? null;
}

async function insertProvisionAudit(
  client: PoolClient,
  input: {
    readonly actionType: string;
    readonly adminUserId: string;
    readonly resourceId: string;
    readonly reason: string;
    readonly afterSnapshot: Readonly<Record<string, unknown>>;
  },
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO audit_logs (
       admin_user_id, actor_type, action_type, resource_type, resource_id,
       after_snapshot, reason, source
     ) VALUES (
       $1::uuid, 'ADMIN', $2, 'user', $3::uuid, $4::jsonb, $5, 'SYSTEM'
     )
     RETURNING id`,
    [
      input.adminUserId,
      input.actionType,
      input.resourceId,
      JSON.stringify(input.afterSnapshot),
      input.reason,
    ],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) {
    throw new LedgerDomainError('INTERNAL', 'audit log insert failed');
  }
  return id;
}

/**
 * Provision Available balance for an allowlisted Phase 21 Mainnet controlled user (USDT only).
 */
export async function provisionPhase21ControlledAvailable(
  db: LedgerDb,
  config: Phase21ControlledAvailableProvisionRuntimeConfig,
  input: {
    readonly operationId: string;
    readonly userId: string;
    readonly amountAtomic: string;
    readonly reason: string;
  },
): Promise<Phase21ProvisionResult> {
  assertFeatureAndEnv(config);
  const operationId = assertUuid(input.operationId, 'operationId');
  const campaignId = assertUuid(config.campaignId, 'campaignId');
  const reason = assertNonEmptyReason(input.reason);
  const amount = parsePositiveAtomicAmount(input.amountAtomic);
  const maxAmount = parsePositiveAtomicAmount(config.maxAmountAtomic);
  if (amount > maxAmount) {
    throw new LedgerDomainError('VALIDATION', 'amount exceeds configured provision cap', {
      details: {
        reason: 'AMOUNT_OVER_CAP',
        amountAtomic: amountAtomicToString(amount),
        maxAmountAtomic: amountAtomicToString(maxAmount),
      },
    });
  }
  const amountAtomic = amountAtomicToString(amount);

  return withLedgerTransaction(db, async (client) => {
    const { adminUserId } = await resolveOwnerAdmin(client, config.ownerAdminUserId);
    const targetUserId = await assertTargetUserForProvision(client, config, input.userId);
    const { networkId, assetId } = await resolveMainnetUsdtAsset(client, config);

    const intent: Phase21ProvisionIntent = {
      operationId,
      targetUserId,
      amountAtomic,
      assetId,
      networkId,
      campaignId,
      reason,
    };

    await lockCampaignCeiling(client, campaignId);

    const existing = await findExistingProvision(client, operationId);
    if (existing !== null) {
      assertIntentMatch(intent, readProvisionIntent(existing.metadata));
      const auditLogId = await insertProvisionAudit(client, {
        actionType: PHASE21_PROVISION_AUDIT_ACTION,
        adminUserId,
        resourceId: targetUserId,
        reason,
        afterSnapshot: {
          operationId,
          ledgerTransactionId: existing.id,
          targetUserId,
          amountAtomic,
          assetId,
          networkId,
          campaignId,
          created: false,
          toolVersion: PHASE21_PROVISION_TOOL_VERSION,
        },
      });
      return {
        operationId,
        ledgerTransactionId: existing.id,
        targetUserId,
        amountAtomic,
        assetId,
        networkId,
        campaignId,
        created: false,
        adminUserId,
        auditLogId,
      };
    }

    const aggregate = await sumNonReversedCampaignCredits(client, campaignId);
    if (aggregate + amount > PHASE21_CONTROLLED_AVAILABLE_CAMPAIGN_CEILING_ATOMIC) {
      throw new LedgerDomainError(
        'VALIDATION',
        'amount would exceed Phase 21 campaign aggregate ceiling',
        {
          details: {
            reason: 'CAMPAIGN_CEILING_EXCEEDED',
            aggregateAtomic: amountAtomicToString(aggregate),
            amountAtomic,
            ceilingAtomic: amountAtomicToString(
              PHASE21_CONTROLLED_AVAILABLE_CAMPAIGN_CEILING_ATOMIC,
            ),
            campaignId,
          },
        },
      );
    }

    const expense = await getOrCreateLedgerAccount(client, {
      accountType: 'SUPPORT_COMPENSATION_EXPENSE',
      assetId,
    });
    const available = await getOrCreateLedgerAccount(client, {
      accountType: 'USER_AVAILABLE_LIABILITY',
      assetId,
      ownerId: targetUserId,
    });

    const posted = await postLedgerTransaction(client, {
      transactionType: 'SUPPORT_ADJUSTMENT',
      businessReferenceType: PHASE21_PROVISION_BUSINESS_REF_TYPE,
      businessReferenceId: operationId,
      idempotencyScope: PHASE21_PROVISION_IDEMPOTENCY_SCOPE,
      idempotencyKey: provisionIdempotencyKey(operationId),
      assetId,
      metadata: {
        phase21ProvisionIntent: intent,
        campaignId,
        toolVersion: PHASE21_PROVISION_TOOL_VERSION,
      },
      createdByType: 'ADMIN',
      createdById: adminUserId,
      entries: [
        {
          ledgerAccountId: expense.id,
          direction: 'DEBIT',
          amountAtomic,
        },
        {
          ledgerAccountId: available.id,
          direction: 'CREDIT',
          amountAtomic,
        },
      ],
    });

    if (!posted.created) {
      const storedMeta = await client.query<{ metadata: unknown }>(
        `SELECT metadata FROM ledger_transactions WHERE id = $1::uuid`,
        [posted.id],
      );
      assertIntentMatch(intent, readProvisionIntent(storedMeta.rows[0]?.metadata));
    }

    const auditLogId = await insertProvisionAudit(client, {
      actionType: PHASE21_PROVISION_AUDIT_ACTION,
      adminUserId,
      resourceId: targetUserId,
      reason,
      afterSnapshot: {
        operationId,
        ledgerTransactionId: posted.id,
        targetUserId,
        amountAtomic,
        assetId,
        networkId,
        campaignId,
        created: posted.created,
        toolVersion: PHASE21_PROVISION_TOOL_VERSION,
      },
    });

    return {
      operationId,
      ledgerTransactionId: posted.id,
      targetUserId,
      amountAtomic,
      assetId,
      networkId,
      campaignId,
      created: posted.created,
      adminUserId,
      auditLogId,
    };
  });
}

/**
 * Reverse an exact Phase 21 controlled Available provision via guarded reverseLedgerTransaction.
 */
export async function reversePhase21ControlledAvailableProvision(
  db: LedgerDb,
  config: Phase21ControlledAvailableProvisionRuntimeConfig,
  input: {
    readonly operationId: string;
    readonly originalLedgerTransactionId: string;
    readonly reason: string;
  },
): Promise<Phase21ProvisionReverseResult> {
  assertFeatureAndEnv(config);
  const operationId = assertUuid(input.operationId, 'operationId');
  const originalId = assertUuid(input.originalLedgerTransactionId, 'originalLedgerTransactionId');
  const reason = assertNonEmptyReason(input.reason);

  return withLedgerTransaction(db, async (client) => {
    const { adminUserId } = await resolveOwnerAdmin(client, config.ownerAdminUserId);

    const original = await client.query<{
      id: string;
      transaction_type: string;
      business_reference_type: string;
      business_reference_id: string | null;
      metadata: unknown;
      asset_id: string;
    }>(
      `SELECT id, transaction_type::text AS transaction_type,
              business_reference_type, business_reference_id::text AS business_reference_id,
              metadata, asset_id::text AS asset_id
       FROM ledger_transactions
       WHERE id = $1::uuid
       LIMIT 1`,
      [originalId],
    );
    const orig = original.rows[0];
    if (orig === undefined) {
      throw new LedgerDomainError(
        'TRANSACTION_NOT_FOUND',
        'Original provision transaction not found',
        {
          details: { originalLedgerTransactionId: originalId },
        },
      );
    }
    if (orig.transaction_type !== 'SUPPORT_ADJUSTMENT') {
      throw new LedgerDomainError('VALIDATION', 'original is not SUPPORT_ADJUSTMENT', {
        details: { reason: 'ORIGINAL_TYPE_MISMATCH', type: orig.transaction_type },
      });
    }
    if (orig.business_reference_type !== PHASE21_PROVISION_BUSINESS_REF_TYPE) {
      throw new LedgerDomainError(
        'VALIDATION',
        'original is not a Phase 21 Mainnet controlled Available provision',
        { details: { reason: 'ORIGINAL_REF_TYPE_MISMATCH' } },
      );
    }

    const intent = readProvisionIntent(orig.metadata);
    if (intent === null) {
      throw new LedgerDomainError('VALIDATION', 'original provision intent metadata missing', {
        details: { reason: 'INTENT_METADATA_MISSING' },
      });
    }
    await assertTargetUserForReverse(client, config, intent.targetUserId);
    const { assetId, networkId } = await resolveMainnetUsdtAsset(client, config);
    if (intent.assetId !== assetId || intent.networkId !== networkId) {
      throw new LedgerDomainError(
        'VALIDATION',
        'original provision asset/network does not match current Mainnet configuration',
        { details: { reason: 'ORIGINAL_SCOPE_MISMATCH' } },
      );
    }
    if (intent.campaignId !== assertUuid(config.campaignId, 'campaignId')) {
      throw new LedgerDomainError(
        'VALIDATION',
        'original provision campaignId does not match current configuration',
        { details: { reason: 'ORIGINAL_CAMPAIGN_MISMATCH' } },
      );
    }

    const reverseIntent = {
      operationId,
      originalLedgerTransactionId: originalId,
      originalOperationId: intent.operationId,
      targetUserId: intent.targetUserId,
      amountAtomic: intent.amountAtomic,
      campaignId: intent.campaignId,
      reason,
    };

    const existingReverse = await client.query<{ id: string; metadata: unknown }>(
      `SELECT id, metadata FROM ledger_transactions
       WHERE business_reference_type = $1
         AND business_reference_id = $2::uuid
       LIMIT 1`,
      [PHASE21_REVERSE_BUSINESS_REF_TYPE, operationId],
    );
    if (existingReverse.rows[0] !== undefined) {
      const meta = existingReverse.rows[0].metadata;
      const stored =
        meta !== null && typeof meta === 'object'
          ? (meta as Record<string, unknown>).phase21ProvisionReverse
          : null;
      if (stored === null || typeof stored !== 'object') {
        throw new LedgerDomainError(
          'IDEMPOTENCY_CONFLICT',
          'existing reverse missing application intent metadata',
          { details: { reason: 'REVERSE_INTENT_METADATA_MISSING' } },
        );
      }
      const s = stored as Record<string, unknown>;
      if (
        s.operationId !== reverseIntent.operationId ||
        s.originalLedgerTransactionId !== reverseIntent.originalLedgerTransactionId ||
        s.originalOperationId !== reverseIntent.originalOperationId ||
        s.targetUserId !== reverseIntent.targetUserId ||
        s.amountAtomic !== reverseIntent.amountAtomic ||
        s.campaignId !== reverseIntent.campaignId ||
        s.reason !== reverseIntent.reason
      ) {
        throw new LedgerDomainError(
          'IDEMPOTENCY_CONFLICT',
          'same reverse operationId with different reverse intent/reason',
          { details: { reason: 'REVERSE_INTENT_MISMATCH' } },
        );
      }
    }

    let posted: PostedLedgerTransaction;
    try {
      posted = await reverseLedgerTransaction(client, {
        originalTransactionId: originalId,
        transactionType: 'SUPPORT_ADJUSTMENT',
        businessReferenceType: PHASE21_REVERSE_BUSINESS_REF_TYPE,
        businessReferenceId: operationId,
        idempotencyScope: PHASE21_REVERSE_IDEMPOTENCY_SCOPE,
        idempotencyKey: reverseIdempotencyKey(operationId),
        metadata: {
          phase21ProvisionReverse: reverseIntent,
          toolVersion: PHASE21_PROVISION_TOOL_VERSION,
        },
        createdByType: 'ADMIN',
        createdById: adminUserId,
      });
    } catch (error) {
      if (
        error instanceof LedgerDomainError &&
        error.code === 'REVERSAL_CONFLICT' &&
        typeof error.details?.existingReversalId === 'string'
      ) {
        throw error;
      }
      throw error;
    }

    const auditLogId = await insertProvisionAudit(client, {
      actionType: PHASE21_REVERSE_AUDIT_ACTION,
      adminUserId,
      resourceId: intent.targetUserId,
      reason,
      afterSnapshot: {
        operationId,
        originalLedgerTransactionId: originalId,
        reversalLedgerTransactionId: posted.id,
        targetUserId: intent.targetUserId,
        amountAtomic: intent.amountAtomic,
        assetId: intent.assetId,
        networkId: intent.networkId,
        campaignId: intent.campaignId,
        created: posted.created,
        toolVersion: PHASE21_PROVISION_TOOL_VERSION,
      },
    });

    return {
      operationId,
      originalLedgerTransactionId: originalId,
      reversalLedgerTransactionId: posted.id,
      targetUserId: intent.targetUserId,
      amountAtomic: intent.amountAtomic,
      created: posted.created,
      adminUserId,
      auditLogId,
    };
  });
}
