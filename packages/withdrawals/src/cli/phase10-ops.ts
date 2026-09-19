#!/usr/bin/env node
/**
 * Phase 10 operational tooling CLI (read-only / coordinator).
 *
 * Never unlocks signer, never enables real chain, never funds users,
 * never creates/approves/broadcasts withdrawals.
 */
import { readFile } from 'node:fs/promises';
import { createDatabasePool } from '@alex-rewards/db';
import { loadWorkerConfig } from '@alex-rewards/config';
import {
  createTonChainProvider,
  type TonChainProvider,
  type TonProviderKind,
} from '@alex-rewards/ton';

import {
  PHASE10_REAL_CAMPAIGN_CONFIRMATION_PHRASE,
  attachWithdrawalIds,
  generateFinalCampaignEvidence,
  initializeCampaign,
  planPhase10Campaign,
  refreshEvidence,
  resumeCampaign,
  type Phase10CampaignRealExecutionGates,
  type Phase10CampaignRealModeGates,
} from '../phase10-campaign.js';
import { buildPhase10HotWalletMonitorReport } from '../phase10-hot-wallet-monitor.js';
import { loadPhase10AuthoritativeHotWalletIdentity } from '../phase10-hot-wallet-identity.js';
import {
  capturePhase10HistoricalBaseline,
  historicalBaselineInputFromArtifact,
  parsePhase10HistoricalBaseline,
  writePhase10HistoricalBaseline,
} from '../phase10-historical-baseline.js';
import { runPhase10LiveExternalProbes, signerLockedFromProbe } from '../phase10-live-probes.js';
import { writePhase10LivePreflightEvidence } from '../phase10-live-readiness-evidence.js';
import { runPhase10Preflight } from '../phase10-preflight.js';
import { runPhase10Readiness, type Phase10ReadinessConfig } from '../phase10-readiness.js';
import { runPhase10RestoreReconcileScan } from '../phase10-restore-reconcile.js';
import { buildPhase10PayoutConfig } from '../phase10-config.js';
import {
  runPhase10ChainHistoryReadonlyValidate,
  writePhase10ReadonlyValidationReport,
} from '../phase10-chain-history-readonly-validate.js';
import type { DeploymentEnvironment } from '../config.js';
import {
  readonlyValidateVerdictImpliesSuccess,
  setPhase10OpsProcessExitCode,
} from './phase10-ops-exit.js';

const COMMANDS = new Set([
  'readiness',
  'preflight',
  'baseline-capture',
  'restore-reconcile',
  'hot-wallet-monitor',
  'campaign-plan',
  'campaign-init',
  'campaign-status',
  'campaign-attach',
  'campaign-rescan',
  'campaign-finalize',
  'chain-history-readonly-validate',
]);

function usage(): never {
  console.error(
    JSON.stringify({
      ok: false,
      message:
        'usage: phase10-ops <readiness|preflight|baseline-capture|restore-reconcile|hot-wallet-monitor|campaign-plan|campaign-init|campaign-status|campaign-attach|campaign-rescan|campaign-finalize|chain-history-readonly-validate> [flags]',
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
  signerLocked: boolean | null,
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
    signerLocked,
    signerBaseUrlConfigured: worker.SIGNER_BASE_URL.trim() !== '',
    signerServiceTokenConfigured: (worker.SIGNER_SERVICE_TOKEN ?? '').length >= 32,
  };
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function tryBuildObserveProvider(worker: ReturnType<typeof loadWorkerConfig>): {
  provider: TonChainProvider | null;
  note: string | null;
} {
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

function parseGatesJson(raw: string | undefined): Phase10CampaignRealModeGates | undefined {
  if (raw === undefined) return undefined;
  const parsed = JSON.parse(raw) as Phase10CampaignRealModeGates;
  return parsed;
}

function parseRealExecutionGatesJson(
  raw: string | undefined,
): Phase10CampaignRealExecutionGates | undefined {
  if (raw === undefined) return undefined;
  return JSON.parse(raw) as Phase10CampaignRealExecutionGates;
}

async function loadCanonicalBaseline(path: string | undefined): Promise<{
  readonly input: ReturnType<typeof historicalBaselineInputFromArtifact> | null;
  readonly attemptIds: readonly string[];
  readonly capturedAt: string | null;
  readonly errors: readonly string[];
}> {
  if (path === undefined) {
    return { input: null, attemptIds: [], capturedAt: null, errors: [] };
  }
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
  const parsed = parsePhase10HistoricalBaseline(raw);
  if (parsed.parsed === null) {
    return {
      input: null,
      attemptIds: [],
      capturedAt: null,
      errors: parsed.errors.length > 0 ? parsed.errors : ['invalid historical baseline artifact'],
    };
  }
  const input = historicalBaselineInputFromArtifact(parsed.parsed);
  return {
    input,
    attemptIds: input.attemptIds,
    capturedAt: input.capturedAt,
    errors: [],
  };
}

async function runLiveProbes(
  pool: ReturnType<typeof createDatabasePool>,
  worker: ReturnType<typeof loadWorkerConfig>,
) {
  const hotIdentity = await loadPhase10AuthoritativeHotWalletIdentity(pool, {
    networkCode: worker.WITHDRAWAL_NETWORK_CODE,
  });
  return runPhase10LiveExternalProbes({
    primary: {
      kind: worker.TON_PRIMARY_PROVIDER_KIND || null,
      baseUrl: worker.TON_PRIMARY_PROVIDER_URL || null,
      apiKey: worker.TON_PRIMARY_PROVIDER_API_KEY || null,
    },
    secondary: {
      kind: worker.TON_SECONDARY_PROVIDER_KIND || null,
      baseUrl: worker.TON_SECONDARY_PROVIDER_URL || null,
      apiKey: worker.TON_SECONDARY_PROVIDER_API_KEY || null,
    },
    signerBaseUrl: worker.SIGNER_BASE_URL || null,
    signerServiceToken: worker.SIGNER_SERVICE_TOKEN || null,
    expectedCustodyMode: 'self_hosted_encrypted',
    expectedPublicKeyFingerprint: hotIdentity?.signerReference ?? null,
    expectedWalletAddressRaw: hotIdentity?.addressRaw ?? null,
    approvedSignerKeyReference: hotIdentity?.signerReference ?? null,
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (command === undefined || !COMMANDS.has(command)) {
    usage();
  }

  if (command === 'campaign-plan') {
    const modeFlag = readFlag(argv, '--mode');
    const mode = modeFlag === 'real' ? 'real' : 'dry-run';
    const gates = parseGatesJson(readFlag(argv, '--gates-json'));
    printJson({
      ok: true,
      command: 'campaign-plan',
      plan: planPhase10Campaign({
        mode,
        ...(gates !== undefined ? { gates } : {}),
      }),
    });
    return;
  }

  if (command === 'campaign-status') {
    const manifestPath = readFlag(argv, '--manifest');
    if (manifestPath === undefined) usage();
    const manifest = await resumeCampaign(manifestPath);
    printJson({
      ok: true,
      command: 'campaign-status',
      manifest: {
        campaignId: manifest.campaignId,
        status: manifest.status,
        mode: manifest.mode,
        plannedCount: manifest.plannedCount,
        attachedCount: manifest.withdrawalIds.length,
        evidenceCount: manifest.evidence.length,
        realModeCheckpoint: manifest.realModeCheckpoint,
        createsWithdrawals: false,
        flipsEnv: false,
        unlocksSigner: false,
      },
    });
    return;
  }

  if (command === 'campaign-init') {
    const manifestPath = readFlag(argv, '--manifest');
    const userId = readFlag(argv, '--user-id');
    const planned = Number(readFlag(argv, '--planned-count') ?? '0');
    const modeFlag = readFlag(argv, '--mode');
    const mode = modeFlag === 'real' ? 'real' : 'dry-run';
    if (manifestPath === undefined || userId === undefined) usage();
    const gates = parseGatesJson(readFlag(argv, '--gates-json'));
    const realExecutionGates = parseRealExecutionGatesJson(
      readFlag(argv, '--real-execution-gates-json'),
    );
    const confirmationPhrase = readFlag(argv, '--confirmation-phrase');
    const baselinePath = readFlag(argv, '--baseline-json');
    const baseline = await loadCanonicalBaseline(baselinePath);
    if (baseline.errors.length > 0) {
      printJson({
        ok: false,
        command: 'campaign-init',
        error: 'canonical historical baseline required',
        errors: baseline.errors,
      });
      return;
    }
    const campaignIdFlag = readFlag(argv, '--campaign-id');
    const result = await initializeCampaign({
      campaignDirOrManifestPath: manifestPath,
      controlledUserId: userId,
      plannedPayoutCount: planned,
      mode,
      ...(gates !== undefined ? { gates } : {}),
      ...(realExecutionGates !== undefined ? { realExecutionGates } : {}),
      ...(confirmationPhrase !== undefined ? { confirmationPhrase } : {}),
      ...(baseline.attemptIds.length > 0
        ? { baselineIsolatedHistoricalAttemptIds: baseline.attemptIds }
        : {}),
      ...(campaignIdFlag !== undefined ? { campaignId: campaignIdFlag } : {}),
    });
    printJson({
      ok: result.accepted,
      command: 'campaign-init',
      confirmationPhraseRequired: PHASE10_REAL_CAMPAIGN_CONFIRMATION_PHRASE,
      ...result,
    });
    return;
  }

  if (command === 'campaign-attach') {
    const manifestPath = readFlag(argv, '--manifest');
    const idsRaw = readFlag(argv, '--withdrawal-ids');
    if (manifestPath === undefined || idsRaw === undefined) usage();
    const ids = idsRaw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    const manifest = await attachWithdrawalIds(manifestPath, ids);
    printJson({
      ok: true,
      command: 'campaign-attach',
      attachedCount: manifest.withdrawalIds.length,
      withdrawalIds: manifest.withdrawalIds,
      createsWithdrawals: false,
    });
    return;
  }

  const worker = loadWorkerConfig();
  const pool = createDatabasePool(worker.DATABASE_URL);
  const controlledUserId = readFlag(argv, '--user-id')?.trim() || null;
  let exitCode = 0;

  try {
    if (command === 'chain-history-readonly-validate') {
      const windowStart = readFlag(argv, '--window-start');
      const windowEnd = readFlag(argv, '--window-end');
      const outPath = readFlag(argv, '--out');
      if (windowStart === undefined || windowEnd === undefined) usage();

      if (
        worker.WITHDRAWAL_REAL_CHAIN_ENABLED !== false ||
        worker.WITHDRAWAL_FAKE_CHAIN_ENABLED !== false
      ) {
        printJson({
          ok: false,
          command: 'chain-history-readonly-validate',
          validationOnly: true,
          acceptanceEnabled: false,
          error:
            'REFUSE: WITHDRAWAL_REAL_CHAIN_ENABLED and WITHDRAWAL_FAKE_CHAIN_ENABLED must both be false',
        });
        // process.exitCode survives early return after finally { pool.end() }.
        exitCode = 1;
        setPhase10OpsProcessExitCode(1);
        return;
      }

      const report = await runPhase10ChainHistoryReadonlyValidate({
        db: pool,
        windowStart,
        windowEnd,
        primary: {
          kind: worker.TON_PRIMARY_PROVIDER_KIND || '',
          baseUrl: worker.TON_PRIMARY_PROVIDER_URL || '',
          apiKey: worker.TON_PRIMARY_PROVIDER_API_KEY || null,
        },
        secondary: {
          kind: worker.TON_SECONDARY_PROVIDER_KIND || '',
          baseUrl: worker.TON_SECONDARY_PROVIDER_URL || '',
          apiKey: worker.TON_SECONDARY_PROVIDER_API_KEY || null,
        },
        jettonMaster: worker.TON_TESTNET_JETTON_MASTER || '',
        networkCode: worker.WITHDRAWAL_NETWORK_CODE,
        realChainEnabled: worker.WITHDRAWAL_REAL_CHAIN_ENABLED,
        fakeChainEnabled: worker.WITHDRAWAL_FAKE_CHAIN_ENABLED,
      });

      if (outPath !== undefined) {
        await writePhase10ReadonlyValidationReport(outPath, report);
      }

      const ok = readonlyValidateVerdictImpliesSuccess(report.verdict);
      exitCode = ok ? 0 : 1;
      // Prefer process.exitCode over process.exit so finally pool cleanup still runs.
      setPhase10OpsProcessExitCode(exitCode);
      printJson({
        ok,
        command: 'chain-history-readonly-validate',
        validationOnly: true as const,
        acceptanceEnabled: false as const,
        verdict: report.verdict,
        report: {
          schemaVersion: report.schemaVersion,
          generatedAt: report.generatedAt,
          networkCode: report.networkCode,
          networkGlobalId: report.networkGlobalId,
          hotWalletAddress: report.hotWalletAddress,
          hotWalletJettonWallet: report.hotWalletJettonWallet,
          jettonMaster: report.jettonMaster,
          observationWindow: report.observationWindow,
          primaryProviderFingerprint: report.primaryProviderFingerprint,
          secondaryProviderFingerprint: report.secondaryProviderFingerprint,
          primaryHealth: report.primaryHealth,
          secondaryHealth: report.secondaryHealth,
          primaryCoverage: report.primaryCoverage,
          secondaryCoverage: report.secondaryCoverage,
          providerAgreement: report.providerAgreement,
          agreedTransferCount: report.agreedTransferCount,
          onlyPrimaryCount: report.onlyPrimaryCount,
          onlySecondaryCount: report.onlySecondaryCount,
          agreedTransfers: report.agreedTransfers,
          verdict: report.verdict,
          notes: report.notes,
          reportDigest: report.reportDigest,
          ...(outPath !== undefined ? { path: outPath } : {}),
        },
      });
      return;
    }

    if (command === 'campaign-rescan' || command === 'campaign-finalize') {
      const manifestPath = readFlag(argv, '--manifest');
      if (manifestPath === undefined) usage();
      const manifest =
        command === 'campaign-finalize'
          ? await generateFinalCampaignEvidence(manifestPath, pool)
          : await refreshEvidence(manifestPath, pool);
      printJson({
        ok: true,
        command,
        status: manifest.status,
        evidenceCount: manifest.evidence.length,
        createsWithdrawals: false,
        mutatesFinancialDb: false,
      });
      return;
    }

    if (command === 'readiness') {
      const probes = await runLiveProbes(pool, worker);
      const report = await runPhase10Readiness(
        pool,
        buildReadinessConfigFromEnv(worker, controlledUserId, signerLockedFromProbe(probes)),
      );
      printJson({ ok: true, command: 'readiness', externalProbes: probes, report });
      return;
    }

    if (command === 'baseline-capture') {
      const outPath = readFlag(argv, '--out');
      if (outPath === undefined) usage();
      const artifact = await capturePhase10HistoricalBaseline(pool);
      await writePhase10HistoricalBaseline(outPath, artifact);
      printJson({
        ok: true,
        command: 'baseline-capture',
        path: outPath,
        capturedAt: artifact.capturedAt,
        attemptCount: artifact.attempts.length,
        evidenceDigest: artifact.evidenceDigest,
        mutatesFinancialDb: false,
      });
      return;
    }

    if (command === 'preflight') {
      const liveAuthorizationWindow = hasSwitch(argv, '--live-authorization-window');
      const evidenceOut = readFlag(argv, '--evidence-out');
      const baselinePath = readFlag(argv, '--baseline-json');
      // --baseline-captured-at alone cannot manufacture historical status.
      if (hasSwitch(argv, '--baseline-captured-at') && baselinePath === undefined) {
        printJson({
          ok: false,
          command: 'preflight',
          error:
            '--baseline-captured-at alone is refused; capture a canonical baseline via baseline-capture',
        });
        return;
      }
      const baseline = await loadCanonicalBaseline(baselinePath);
      if (baseline.errors.length > 0) {
        printJson({
          ok: false,
          command: 'preflight',
          error: 'canonical historical baseline required',
          errors: baseline.errors,
        });
        return;
      }

      const probes = await runLiveProbes(pool, worker);

      const readinessConfig = buildReadinessConfigFromEnv(
        worker,
        controlledUserId,
        signerLockedFromProbe(probes),
      );
      const report = await runPhase10Preflight(pool, {
        readinessConfig,
        externalProbes: probes,
        ...(baseline.input !== null
          ? {
              historicalBaseline: baseline.input,
              baselineIsolatedHistoricalAttemptIds: baseline.attemptIds,
              liveAuthorizationWindowStartedAt: baseline.capturedAt,
            }
          : {}),
      });

      let evidencePath: string | null = null;
      let evidence = null;
      if (evidenceOut !== undefined) {
        evidence = await writePhase10LivePreflightEvidence(evidenceOut, {
          preflight: report,
          readinessConfig,
          externalProbes: probes,
          liveAuthorizationWindow,
          historicalBaselineReference:
            baseline.input !== null
              ? { attemptIds: [...baseline.attemptIds], capturedAt: baseline.capturedAt }
              : null,
        });
        evidencePath = evidenceOut;
      }

      printJson({
        ok: report.verdict === 'READY_FOR_CONTROLLED_LIVE_TESTNET',
        command: 'preflight',
        report,
        evidencePath,
        evidence,
      });
      return;
    }

    if (command === 'restore-reconcile') {
      const baselinePath = readFlag(argv, '--baseline-json');
      if (hasSwitch(argv, '--baseline-captured-at') && baselinePath === undefined) {
        printJson({
          ok: false,
          command: 'restore-reconcile',
          error:
            '--baseline-captured-at alone is refused; capture a canonical baseline via baseline-capture',
        });
        return;
      }
      const baseline = await loadCanonicalBaseline(baselinePath);
      if (baseline.errors.length > 0) {
        printJson({
          ok: false,
          command: 'restore-reconcile',
          error: 'canonical historical baseline required',
          errors: baseline.errors,
        });
        return;
      }
      const report = await runPhase10RestoreReconcileScan(pool, {
        ...(baseline.input !== null
          ? {
              historicalBaseline: baseline.input,
              baselineIsolatedHistoricalAttemptIds: baseline.attemptIds,
              liveAuthorizationWindowStartedAt: baseline.capturedAt,
            }
          : {}),
      });
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
      ...(provider !== null ? { provider, observeProvider: true as const } : {}),
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

  if (exitCode !== 0) {
    process.exit(exitCode);
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
