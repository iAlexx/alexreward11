#!/usr/bin/env node
/**
 * Phase 10 operational tooling CLI (read-only / dry-run).
 *
 * Usage:
 *   node dist/cli/phase10-ops.js readiness
 *   node dist/cli/phase10-ops.js preflight
 *   node dist/cli/phase10-ops.js restore-reconcile
 *   node dist/cli/phase10-ops.js hot-wallet-monitor [--observe-provider]
 *   node dist/cli/phase10-ops.js campaign-plan [--mode dry-run|real]
 *
 * Prints JSON only. Never unlocks signer, never enables real chain, never funds users.
 */
import { createDatabasePool } from '@alex-rewards/db';
import { loadWorkerConfig } from '@alex-rewards/config';
import { createTonChainProvider, type TonChainProvider, type TonProviderKind } from '@alex-rewards/ton';

import { planPhase10Campaign } from '../phase10-campaign.js';
import { buildPhase10HotWalletMonitorReport } from '../phase10-hot-wallet-monitor.js';
import { runPhase10Preflight } from '../phase10-preflight.js';
import { runPhase10Readiness, type Phase10ReadinessConfig } from '../phase10-readiness.js';
import { runPhase10RestoreReconcileScan } from '../phase10-restore-reconcile.js';
import { buildPhase10PayoutConfig } from '../phase10-config.js';
import type { DeploymentEnvironment } from '../config.js';

function usage(): never {
  console.error(
    JSON.stringify({
      ok: false,
      message:
        'usage: phase10-ops <readiness|preflight|restore-reconcile|hot-wallet-monitor|campaign-plan> [--mode dry-run|real] [--user-id <uuid>] [--observe-provider]',
    }),
  );
  process.exit(2);
}

function readFlag(argv: ReadonlyArray<string>, name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx < 0) return undefined;
  return argv[idx + 1];
}

function hasSwitch(argv: ReadonlyArray<string>, name: string): boolean {
  return argv.includes(name);
}

function mapDeploymentEnv(value: string): DeploymentEnvironment {
  switch (value) {
    case 'local':
      return 'LOCAL';
    case 'test':
      return 'DEV';
    case 'staging':
      return 'STAGING';
    case 'production':
      return 'PRODUCTION';
    default:
      return 'LOCAL';
  }
}

function buildReadinessConfigFromEnv(
  worker: ReturnType<typeof loadWorkerConfig>,
  controlledUserId: string | null,
): Phase10ReadinessConfig {
  const phase10 = buildPhase10PayoutConfig({
    realChainEnabled: worker.WITHDRAWAL_REAL_CHAIN_ENABLED,
    signerBaseUrl: worker.SIGNER_BASE_URL,
    signerServiceToken: worker.SIGNER_SERVICE_TOKEN ?? '',
    jettonMasterIdentity: worker.TON_TESTNET_JETTON_MASTER || null,
    primaryProviderKind: worker.TON_PRIMARY_PROVIDER_KIND || null,
    primaryProviderUrl: worker.TON_PRIMARY_PROVIDER_URL || null,
    primaryProviderApiKey: worker.TON_PRIMARY_PROVIDER_API_KEY || null,
    secondaryProviderKind: worker.TON_SECONDARY_PROVIDER_KIND || null,
    secondaryProviderUrl: worker.TON_SECONDARY_PROVIDER_URL || null,
    secondaryProviderApiKey: worker.TON_SECONDARY_PROVIDER_API_KEY || null,
  });
  return {
    deploymentEnvironment: mapDeploymentEnv(worker.DEPLOYMENT_ENV),
    fakeChainEnabled: worker.WITHDRAWAL_FAKE_CHAIN_ENABLED,
    realChainEnabled: worker.WITHDRAWAL_REAL_CHAIN_ENABLED,
    acceptedNetworkCode: worker.WITHDRAWAL_NETWORK_CODE,
    usdtSymbol: worker.WITHDRAWAL_ASSET_SYMBOL,
    phase10,
    controlledUserId,
    signerBaseUrlConfigured: worker.SIGNER_BASE_URL.trim() !== '',
    signerServiceTokenConfigured: (worker.SIGNER_SERVICE_TOKEN ?? '').length >= 32,
  };
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function tryBuildObserveProvider(
  worker: ReturnType<typeof loadWorkerConfig>,
): { provider: TonChainProvider | null; note: string | null } {
  const kindRaw = (worker.TON_PRIMARY_PROVIDER_KIND || '').trim().toLowerCase();
  const url = (worker.TON_PRIMARY_PROVIDER_URL || '').trim();
  if (kindRaw !== 'toncenter' && kindRaw !== 'tonapi') {
    return {
      provider: null,
      note: '--observe-provider ignored: TON_PRIMARY_PROVIDER_KIND must be toncenter|tonapi',
    };
  }
  if (url === '') {
    return {
      provider: null,
      note: '--observe-provider ignored: TON_PRIMARY_PROVIDER_URL not set',
    };
  }
  const kind = kindRaw as TonProviderKind;
  return {
    provider: createTonChainProvider({
      kind,
      baseUrl: url,
      apiKey: worker.TON_PRIMARY_PROVIDER_API_KEY || null,
    }),
    note: null,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (
    command !== 'readiness' &&
    command !== 'preflight' &&
    command !== 'restore-reconcile' &&
    command !== 'hot-wallet-monitor' &&
    command !== 'campaign-plan'
  ) {
    usage();
  }

  if (command === 'campaign-plan') {
    const modeFlag = readFlag(argv, '--mode');
    const mode = modeFlag === 'real' ? 'real' : 'dry-run';
    printJson({
      ok: true,
      command: 'campaign-plan',
      plan: planPhase10Campaign({ mode }),
    });
    return;
  }

  const worker = loadWorkerConfig();
  const pool = createDatabasePool(worker.DATABASE_URL);
  const controlledUserId = readFlag(argv, '--user-id')?.trim() || null;

  try {
    if (command === 'readiness') {
      const report = await runPhase10Readiness(
        pool,
        buildReadinessConfigFromEnv(worker, controlledUserId),
      );
      printJson({ ok: true, command: 'readiness', report });
      return;
    }

    if (command === 'preflight') {
      const report = await runPhase10Preflight(pool, {
        readinessConfig: buildReadinessConfigFromEnv(worker, controlledUserId),
      });
      printJson({ ok: true, command: 'preflight', report });
      return;
    }

    if (command === 'restore-reconcile') {
      const report = await runPhase10RestoreReconcileScan(pool);
      printJson({ ok: true, command: 'restore-reconcile', report });
      return;
    }

    const observeProvider = hasSwitch(argv, '--observe-provider');
    let provider: TonChainProvider | null = null;
    let observeNote: string | null = null;
    if (observeProvider) {
      const built = tryBuildObserveProvider(worker);
      provider = built.provider;
      observeNote = built.note;
    }

    const report = await buildPhase10HotWalletMonitorReport(pool, {
      networkCode: worker.WITHDRAWAL_NETWORK_CODE,
      fakeChainEnabled: worker.WITHDRAWAL_FAKE_CHAIN_ENABLED,
      jettonMasterIdentity: worker.TON_TESTNET_JETTON_MASTER || null,
      ...(provider !== null
        ? { provider, observeProvider: true as const }
        : {}),
    });
    printJson({
      ok: true,
      command: 'hot-wallet-monitor',
      observeProvider,
      ...(observeNote !== null ? { observeNote } : {}),
      report,
    });
  } finally {
    await pool.end();
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const value = Reflect.get(error, 'code');
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ ok: false, code: errorCode(error), message }));
  process.exit(1);
});
