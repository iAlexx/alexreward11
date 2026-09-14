/**
 * Phase 10 Testnet-only Owner-operated Available provisioning.
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

export const PHASE10_PROVISION_BUSINESS_REF_TYPE = 'phase10-testnet-available-provision';
export const PHASE10_PROVISION_IDEMPOTENCY_SCOPE = 'phase10.testnet.available.provision';
export const PHASE10_REVERSE_BUSINESS_REF_TYPE = 'phase10-testnet-available-provision-reverse';
export const PHASE10_REVERSE_IDEMPOTENCY_SCOPE = 'phase10.testnet.available.provision.reverse';
export const PHASE10_PROVISION_AUDIT_ACTION = 'OWNER_TESTNET_AVAILABLE_PROVISION';
export const PHASE10_REVERSE_AUDIT_ACTION = 'OWNER_TESTNET_AVAILABLE_PROVISION_REVERSE';
export const PHASE10_PROVISION_TOOL_VERSION = '1.0.0-phase10';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface Phase10TestnetProvisionRuntimeConfig {
  readonly enabled: boolean;
  readonly deploymentEnv: 'local' | 'test' | 'staging' | 'production';
  readonly withdrawalNetworkCode: string;
  readonly withdrawalAssetSymbol: string;
  readonly allowedUserId: string;
  readonly maxAmountAtomic: string;
  readonly ownerAdminUserId: string;
}

export interface Phase10ProvisionIntent {
  readonly operationId: string;
  readonly targetUserId: string;
  readonly amountAtomic: string;
  readonly assetId: string;
  readonly networkId: string;
  readonly reason: string;
}

export interface Phase10ProvisionResult {
  readonly operationId: string;
  readonly ledgerTransactionId: string;
  readonly targetUserId: string;
  readonly amountAtomic: string;
  readonly assetId: string;
  readonly networkId: string;
  readonly created: boolean;
  readonly adminUserId: string;
  readonly auditLogId: string;
}

export interface Phase10ProvisionReverseResult {
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

function assertFeatureAndEnv(config: Phase10TestnetProvisionRuntimeConfig): void {
  if (!config.enabled) {
    throw new LedgerDomainError('VALIDATION', 'Phase 10 Testnet provisioning is disabled', {
      details: { reason: 'PROVISION_DISABLED' },
    });
  }
  if (config.deploymentEnv !== 'local' && config.deploymentEnv !== 'test') {
    throw new LedgerDomainError(
      'VALIDATION',
      'Phase 10 Testnet provisioning is forbidden outside local/test',
      { details: { reason: 'INVALID_DEPLOYMENT_ENV', deploymentEnv: config.deploymentEnv } },
    );
  }
  if (config.withdrawalNetworkCode !== 'TON_TESTNET') {
    throw new LedgerDomainError('VALIDATION', 'withdrawal network must be exactly TON_TESTNET', {
      details: {
        reason: 'NETWORK_CODE_MISMATCH',
        configured: config.withdrawalNetworkCode,
      },
    });
  }
  if (config.withdrawalAssetSymbol !== 'USDT') {
    throw new LedgerDomainError('VALIDATION', 'withdrawal asset must be exactly USDT', {
      details: {
        reason: 'ASSET_SYMBOL_MISMATCH',
        configured: config.withdrawalAssetSymbol,
      },
    });
  }
  if (config.withdrawalNetworkCode.toUpperCase().includes('MAINNET')) {
    throw new LedgerDomainError('VALIDATION', 'MAINNET network codes are forbidden', {
      details: { reason: 'MAINNET_FORBIDDEN' },
    });
  }
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

async function resolveTestnetUsdt(
  client: PoolClient,
  networkCode: string,
): Promise<{ networkId: string; assetId: string }> {
  const network = await client.query<{
    id: string;
    code: string;
    status: string;
    global_chain_identifier: string | null;
  }>(
    `SELECT id, code, status::text AS status,
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
  if (net.code !== 'TON_TESTNET') {
    throw new LedgerDomainError('VALIDATION', 'authoritative network must be TON_TESTNET', {
      details: { reason: 'NETWORK_NOT_TESTNET', code: net.code },
    });
  }
  if (net.status !== 'ACTIVE') {
    throw new LedgerDomainError('VALIDATION', 'network is not ACTIVE', {
      details: { reason: 'NETWORK_INACTIVE', networkId: net.id },
    });
  }
  const gci = (net.global_chain_identifier ?? '').trim();
  if (
    gci === '-239' ||
    gci.toLowerCase().includes('mainnet') ||
    net.code.toUpperCase().includes('MAINNET')
  ) {
    throw new LedgerDomainError('VALIDATION', 'Mainnet network identity is forbidden', {
      details: { reason: 'MAINNET_FORBIDDEN', globalChainIdentifier: gci, code: net.code },
    });
  }

  const asset = await client.query<{
    id: string;
    symbol: string;
    status: string;
    network_id: string;
  }>(
    `SELECT id, symbol, status::text AS status, network_id::text AS network_id
     FROM assets
     WHERE network_id = $1::uuid
       AND symbol = 'USDT'
     LIMIT 1`,
    [net.id],
  );
  const a = asset.rows[0];
  if (a === undefined) {
    throw new LedgerDomainError('VALIDATION', 'USDT asset not found on Testnet network', {
      details: { reason: 'ASSET_NOT_FOUND', networkId: net.id },
    });
  }
  if (a.status !== 'ACTIVE') {
    throw new LedgerDomainError('VALIDATION', 'USDT asset is not ACTIVE', {
      details: { reason: 'ASSET_INACTIVE', assetId: a.id },
    });
  }
  if (a.symbol !== 'USDT' || a.network_id !== net.id) {
    throw new LedgerDomainError('VALIDATION', 'asset/network mismatch', {
      details: { reason: 'ASSET_NETWORK_MISMATCH' },
    });
  }

  return { networkId: net.id, assetId: a.id };
}

async function assertTargetUserForProvision(
  client: PoolClient,
  config: Phase10TestnetProvisionRuntimeConfig,
  targetUserId: string,
): Promise<string> {
  const userId = assertUuid(targetUserId, 'userId');
  const allowed = assertUuid(config.allowedUserId, 'allowedUserId');
  if (userId !== allowed) {
    throw new LedgerDomainError(
      'VALIDATION',
      'target user is not the configured Phase 10 allowlisted user',
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

/**
 * Reverse path: prove allowlisted identity + row exists. Do NOT require ACTIVE / not-BLOCKED.
 */
async function assertTargetUserForReverse(
  client: PoolClient,
  config: Phase10TestnetProvisionRuntimeConfig,
  targetUserId: string,
): Promise<string> {
  const userId = assertUuid(targetUserId, 'userId');
  const allowed = assertUuid(config.allowedUserId, 'allowedUserId');
  if (userId !== allowed) {
    throw new LedgerDomainError(
      'VALIDATION',
      'target user is not the configured Phase 10 allowlisted user',
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

function readProvisionIntent(metadata: unknown): Phase10ProvisionIntent | null {
  if (metadata === null || typeof metadata !== 'object') return null;
  const root = metadata as Record<string, unknown>;
  const intent = root.phase10ProvisionIntent;
  if (intent === null || typeof intent !== 'object') return null;
  const o = intent as Record<string, unknown>;
  if (
    typeof o.operationId !== 'string' ||
    typeof o.targetUserId !== 'string' ||
    typeof o.amountAtomic !== 'string' ||
    typeof o.assetId !== 'string' ||
    typeof o.networkId !== 'string' ||
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
    reason: o.reason,
  };
}

function assertIntentMatch(
  expected: Phase10ProvisionIntent,
  stored: Phase10ProvisionIntent | null,
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
    stored.reason !== expected.reason
  ) {
    throw new LedgerDomainError(
      'IDEMPOTENCY_CONFLICT',
      'same operationId with different financial intent',
      { details: { reason: 'INTENT_MISMATCH' } },
    );
  }
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
 * Provision Available USDT for the allowlisted Phase 10 Testnet user.
 */
export async function provisionPhase10TestnetAvailable(
  db: LedgerDb,
  config: Phase10TestnetProvisionRuntimeConfig,
  input: {
    readonly operationId: string;
    readonly userId: string;
    readonly amountAtomic: string;
    readonly reason: string;
  },
): Promise<Phase10ProvisionResult> {
  assertFeatureAndEnv(config);
  const operationId = assertUuid(input.operationId, 'operationId');
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
    const { networkId, assetId } = await resolveTestnetUsdt(client, config.withdrawalNetworkCode);

    const intent: Phase10ProvisionIntent = {
      operationId,
      targetUserId,
      amountAtomic,
      assetId,
      networkId,
      reason,
    };

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
      businessReferenceType: PHASE10_PROVISION_BUSINESS_REF_TYPE,
      businessReferenceId: operationId,
      idempotencyScope: PHASE10_PROVISION_IDEMPOTENCY_SCOPE,
      idempotencyKey: provisionIdempotencyKey(operationId),
      assetId,
      metadata: {
        phase10ProvisionIntent: intent,
        toolVersion: PHASE10_PROVISION_TOOL_VERSION,
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
      actionType: PHASE10_PROVISION_AUDIT_ACTION,
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
        created: posted.created,
        toolVersion: PHASE10_PROVISION_TOOL_VERSION,
      },
    });

    return {
      operationId,
      ledgerTransactionId: posted.id,
      targetUserId,
      amountAtomic,
      assetId,
      networkId,
      created: posted.created,
      adminUserId,
      auditLogId,
    };
  });
}

/**
 * Reverse an exact Phase 10 provision via guarded reverseLedgerTransaction.
 */
export async function reversePhase10TestnetAvailableProvision(
  db: LedgerDb,
  config: Phase10TestnetProvisionRuntimeConfig,
  input: {
    readonly operationId: string;
    readonly originalLedgerTransactionId: string;
    readonly reason: string;
  },
): Promise<Phase10ProvisionReverseResult> {
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
    if (orig.business_reference_type !== PHASE10_PROVISION_BUSINESS_REF_TYPE) {
      throw new LedgerDomainError(
        'VALIDATION',
        'original is not a Phase 10 Testnet available provision',
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
    const { assetId, networkId } = await resolveTestnetUsdt(client, config.withdrawalNetworkCode);
    if (intent.assetId !== assetId || intent.networkId !== networkId) {
      throw new LedgerDomainError(
        'VALIDATION',
        'original provision asset/network does not match current Testnet configuration',
        { details: { reason: 'ORIGINAL_SCOPE_MISMATCH' } },
      );
    }

    const reverseIntent = {
      operationId,
      originalLedgerTransactionId: originalId,
      originalOperationId: intent.operationId,
      targetUserId: intent.targetUserId,
      amountAtomic: intent.amountAtomic,
      reason,
    };

    // Exact retry: same operationId must recover only with identical reverse reason/intent.
    const existingReverse = await client.query<{ id: string; metadata: unknown }>(
      `SELECT id, metadata FROM ledger_transactions
       WHERE business_reference_type = $1
         AND business_reference_id = $2::uuid
       LIMIT 1`,
      [PHASE10_REVERSE_BUSINESS_REF_TYPE, operationId],
    );
    if (existingReverse.rows[0] !== undefined) {
      const meta = existingReverse.rows[0].metadata;
      const stored =
        meta !== null && typeof meta === 'object'
          ? (meta as Record<string, unknown>).phase10ProvisionReverse
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
        businessReferenceType: PHASE10_REVERSE_BUSINESS_REF_TYPE,
        businessReferenceId: operationId,
        idempotencyScope: PHASE10_REVERSE_IDEMPOTENCY_SCOPE,
        idempotencyKey: reverseIdempotencyKey(operationId),
        metadata: {
          phase10ProvisionReverse: reverseIntent,
          toolVersion: PHASE10_PROVISION_TOOL_VERSION,
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
      actionType: PHASE10_REVERSE_AUDIT_ACTION,
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
        created: posted.created,
        toolVersion: PHASE10_PROVISION_TOOL_VERSION,
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
