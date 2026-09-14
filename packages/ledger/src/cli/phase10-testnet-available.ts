#!/usr/bin/env node
/**
 * Phase 10 Testnet Available provisioning CLI (Owner-operated internal tooling).
 *
 * PRIMARY operator boundary: authorized host/shell access.
 * Not a Control Center / Telegram cryptographically authenticated Owner action.
 * Resolves configured Owner admin + ACTIVE OWNER RBAC for audit standing only.
 *
 * Usage:
 *   node dist/cli/phase10-testnet-available.js provision \
 *     --operation-id <UUID> --user-id <UUID> --amount-atomic <int> --reason <text>
 *   node dist/cli/phase10-testnet-available.js reverse \
 *     --operation-id <UUID> --original-ledger-tx <UUID> --reason <text>
 */
import { createDatabasePool } from '@alex-rewards/db';
import { loadPhase10TestnetProvisionConfig } from '@alex-rewards/config';

import {
  provisionPhase10TestnetAvailable,
  reversePhase10TestnetAvailableProvision,
  type Phase10TestnetProvisionRuntimeConfig,
} from '../phase10-testnet-provision.js';

function usage(): never {
  console.error(`Phase 10 Testnet Available provisioning (LOCAL/TEST only; default OFF)

  provision --operation-id <UUID> --user-id <UUID> --amount-atomic <integer> --reason <text>
  reverse   --operation-id <UUID> --original-ledger-tx <UUID> --reason <text>

Reuse the exact same --operation-id to retry safely. Do not invent a new UUID on retry.
Host/shell access is the primary operator boundary.`);
  process.exit(2);
}

function readFlag(argv: ReadonlyArray<string>, name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx < 0) return undefined;
  return argv[idx + 1];
}

function requireFlag(argv: ReadonlyArray<string>, name: string): string {
  const value = readFlag(argv, name);
  if (value === undefined || value.trim() === '') {
    console.error(`Missing required ${name}`);
    usage();
  }
  return value.trim();
}

function toRuntimeConfig(
  config: ReturnType<typeof loadPhase10TestnetProvisionConfig>,
): Phase10TestnetProvisionRuntimeConfig {
  return {
    enabled: config.PHASE10_TESTNET_AVAILABLE_PROVISION_ENABLED,
    deploymentEnv: config.DEPLOYMENT_ENV,
    withdrawalNetworkCode: config.WITHDRAWAL_NETWORK_CODE,
    withdrawalAssetSymbol: config.WITHDRAWAL_ASSET_SYMBOL,
    allowedUserId: config.PHASE10_TESTNET_PROVISION_ALLOWED_USER_ID,
    maxAmountAtomic: config.PHASE10_TESTNET_PROVISION_MAX_ATOMIC,
    ownerAdminUserId: config.PHASE10_TESTNET_PROVISION_OWNER_ADMIN_USER_ID,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (command !== 'provision' && command !== 'reverse') {
    usage();
  }

  const envConfig = loadPhase10TestnetProvisionConfig();
  const runtime = toRuntimeConfig(envConfig);
  const pool = createDatabasePool(envConfig.DATABASE_URL);

  try {
    if (command === 'provision') {
      const result = await provisionPhase10TestnetAvailable(pool, runtime, {
        operationId: requireFlag(argv, '--operation-id'),
        userId: requireFlag(argv, '--user-id'),
        amountAtomic: requireFlag(argv, '--amount-atomic'),
        reason: requireFlag(argv, '--reason'),
      });
      console.log(
        JSON.stringify(
          {
            ok: true,
            command: 'provision',
            operationId: result.operationId,
            ledgerTransactionId: result.ledgerTransactionId,
            targetUserId: result.targetUserId,
            amountAtomic: result.amountAtomic,
            created: result.created,
          },
          null,
          2,
        ),
      );
      return;
    }

    const result = await reversePhase10TestnetAvailableProvision(pool, runtime, {
      operationId: requireFlag(argv, '--operation-id'),
      originalLedgerTransactionId: requireFlag(argv, '--original-ledger-tx'),
      reason: requireFlag(argv, '--reason'),
    });
    console.log(
      JSON.stringify(
        {
          ok: true,
          command: 'reverse',
          operationId: result.operationId,
          originalLedgerTransactionId: result.originalLedgerTransactionId,
          reversalLedgerTransactionId: result.reversalLedgerTransactionId,
          targetUserId: result.targetUserId,
          amountAtomic: result.amountAtomic,
          created: result.created,
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  let code: string | undefined;
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const raw = (error as { readonly code?: unknown }).code;
    if (typeof raw === 'string' || typeof raw === 'number') {
      code = String(raw);
    }
  }
  console.error(JSON.stringify({ ok: false, code, message }));
  process.exit(1);
});
