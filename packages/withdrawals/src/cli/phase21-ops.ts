#!/usr/bin/env node
/**
 * Phase 21 operational ceremony CLI.
 *
 * PLAN / VERIFY / ESTIMATE: read-only.
 * APPLY / REGISTER: require --apply argv PLUS env gates; refuse otherwise.
 * Never unlocks signer, never funds, never broadcasts payouts.
 */
import { Pool } from 'pg';

import { ToncenterMainnetFeeProvider } from '@alex-rewards/ton';

import {
  buildPhase21PayoutConfig,
  listPhase21MissingResources,
} from '../phase21-config.js';
import { createPhase21MainnetExternalAdapters } from '../phase21-mainnet-adapters.js';
import {
  applyPhase21HotWalletRegistration,
  planPhase21HotWalletRegistration,
} from '../phase21-hot-wallet-registration.js';
import {
  applyPhase21MainnetRegistryBootstrap,
  planPhase21MainnetRegistryBootstrap,
} from '../phase21-mainnet-registry-bootstrap.js';
import { runPhase21Preflight } from '../phase21-preflight.js';
import {
  applyPhase21ProductionFlagBaseline,
  planPhase21ProductionFlagBaseline,
} from '../phase21-production-flag-baseline.js';
import {
  buildPhase21ReadinessReport,
  defaultPhase21Step1Observations,
  type Phase21ReadinessObservations,
} from '../phase21-readiness.js';
import { verifyMainnetUsdtWithTwoProviders } from '../phase21-external-probes.js';

const COMMANDS = new Set([
  'readiness',
  'preflight',
  'production-flags:plan',
  'production-flags:apply',
  'mainnet-registry:plan',
  'mainnet-registry:apply',
  'verify-mainnet-external',
  'estimate-mainnet-fee',
  'hot-wallet:plan',
  'hot-wallet:register',
]);

function usage(): never {
  console.error(
    JSON.stringify({
      ok: false,
      message:
        'usage: phase21-ops <readiness|preflight|production-flags:plan|production-flags:apply|mainnet-registry:plan|mainnet-registry:apply|verify-mainnet-external|estimate-mainnet-fee|hot-wallet:plan|hot-wallet:register> [--apply]',
    }),
  );
  process.exit(2);
}

function envFlagTrue(name: string): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw.trim() === '') return false;
  return raw.trim().toLowerCase() === 'true';
}

function envNonEmpty(name: string): string | null {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

function boolFromEnv(name: string, defaultValue: boolean | null): boolean | null {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw.trim() === '') return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return defaultValue;
}

function hasApplyArg(argv: string[]): boolean {
  return argv.includes('--apply');
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function observationsFromEnv(): Phase21ReadinessObservations {
  const defaults = defaultPhase21Step1Observations();
  const signerToken = envNonEmpty('SIGNER_SERVICE_TOKEN');
  const globalIdRaw = envNonEmpty('SIGNER_NETWORK_GLOBAL_ID');
  const networkGlobalId =
    globalIdRaw !== null && Number.isFinite(Number(globalIdRaw)) ? Number(globalIdRaw) : null;

  return {
    ...defaults,
    phase21MainnetEnabled: envFlagTrue('PHASE21_MAINNET_ENABLED'),
    realChainEnabled: envFlagTrue('WITHDRAWAL_REAL_CHAIN_ENABLED'),
    fakeChainEnabled: envFlagTrue('WITHDRAWAL_FAKE_CHAIN_ENABLED'),
    networkCode: envNonEmpty('WITHDRAWAL_NETWORK_CODE'),
    networkGlobalId,
    jettonMaster: envNonEmpty('TON_MAINNET_USDT_JETTON_MASTER'),
    primaryProviderKind: envNonEmpty('TON_PRIMARY_PROVIDER_KIND'),
    primaryProviderUrl: envNonEmpty('TON_PRIMARY_PROVIDER_URL'),
    secondaryProviderKind: envNonEmpty('TON_SECONDARY_PROVIDER_KIND'),
    secondaryProviderUrl: envNonEmpty('TON_SECONDARY_PROVIDER_URL'),
    signerBaseUrl: envNonEmpty('SIGNER_BASE_URL'),
    signerServiceTokenConfigured: signerToken !== null && signerToken.length >= 32,
    signerProvisioned: false,
    signerLocked: null,
    signerIdentityMatches: null,
    signerKeyMode: envNonEmpty('SIGNER_KEY_MODE'),
    hotWalletRegistered: false,
    withdrawalRequestsPaused: boolFromEnv('WITHDRAWAL_REQUESTS_PAUSED_OBSERVED', true),
    payoutDispatchPaused: boolFromEnv('PAYOUT_DISPATCH_PAUSED_OBSERVED', true),
    railwaySignerExists: envFlagTrue('PHASE21_RAILWAY_SIGNER_EXISTS'),
    balanceSource:
      defaults.balanceSource ?? 'SOURCE_IMPLEMENTED_OWNER_APPROVED_BUT_NOT_EXECUTED',
  };
}

function listMissingFromEnv(observations: Phase21ReadinessObservations): string[] {
  if (observations.phase21MainnetEnabled !== true) {
    return [
      'PHASE21_MAINNET_ENABLED=true (explicit Owner Mainnet gate)',
      'TON_MAINNET_USDT_JETTON_MASTER (Owner-approved Mainnet USDT Jetton master)',
      'TON_PRIMARY_PROVIDER_KIND (toncenter|tonapi)',
      'TON_PRIMARY_PROVIDER_URL (Mainnet HTTP provider base URL)',
      'TON_SECONDARY_PROVIDER_KIND (independent secondary toncenter|tonapi for reconciliation)',
      'TON_SECONDARY_PROVIDER_URL (independent secondary Mainnet provider base URL)',
      'SIGNER_BASE_URL (production signer HTTP base URL)',
      'SIGNER_SERVICE_TOKEN (32+ char shared token for signer HTTP client)',
      'WITHDRAWAL_REAL_CHAIN_ENABLED=true (Owner enable real Mainnet chain)',
    ];
  }

  try {
    const cfg = buildPhase21PayoutConfig({
      phase21MainnetEnabled: true,
      realChainEnabled: observations.realChainEnabled === true,
      fakeChainEnabled: observations.fakeChainEnabled === true,
      signerBaseUrl: observations.signerBaseUrl ?? '',
      signerServiceToken: process.env.SIGNER_SERVICE_TOKEN ?? '',
      jettonMasterIdentity: observations.jettonMaster ?? null,
      primaryProviderKind: observations.primaryProviderKind ?? null,
      primaryProviderUrl: observations.primaryProviderUrl ?? null,
      secondaryProviderKind: observations.secondaryProviderKind ?? null,
      secondaryProviderUrl: observations.secondaryProviderUrl ?? null,
    });
    return listPhase21MissingResources(cfg);
  } catch (error: unknown) {
    return [`PHASE21_CONFIG: ${error instanceof Error ? error.message : String(error)}`];
  }
}

async function withDatabaseUrl<T>(
  fn: (pool: Pool) => Promise<T>,
): Promise<T> {
  const url = envNonEmpty('DATABASE_URL');
  if (url === null) {
    throw new Error('DATABASE_URL is required for this command');
  }
  const pool = new Pool({ connectionString: url });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

function parseProviderKind(raw: string | null): 'toncenter' | 'tonapi' {
  const kind = (raw ?? '').trim().toLowerCase();
  if (kind === 'toncenter' || kind === 'tonapi') return kind;
  throw new Error(`Invalid provider kind: ${raw ?? '(empty)'}; expected toncenter|tonapi`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (command === undefined || !COMMANDS.has(command)) {
    usage();
  }

  const observations = observationsFromEnv();

  if (command === 'readiness') {
    const report = buildPhase21ReadinessReport(observations);
    printJson({
      ok: true,
      command: 'readiness',
      overall: report.overall,
      missingResources: listMissingFromEnv(observations),
      report,
      readyForLivePayout: false,
    });
    return;
  }

  if (command === 'preflight') {
    const report = runPhase21Preflight(observations);
    printJson({
      ok: true,
      command: 'preflight',
      verdict: report.verdict,
      readyForLivePayout: false,
      report,
    });
    return;
  }

  if (command === 'production-flags:plan') {
    const url = envNonEmpty('DATABASE_URL');
    if (url === null) {
      const mock = {
        async query() {
          return { rows: [] };
        },
      };
      const rows = await planPhase21ProductionFlagBaseline(mock);
      printJson({
        ok: true,
        command: 'production-flags:plan',
        mode: 'PLAN',
        applied: false,
        rows,
        notes: [
          'DATABASE_URL unset ? mock empty plan (readiness/preflight only)',
          'Set DATABASE_URL for live PLAN against target DB',
        ],
      });
      return;
    }
    await withDatabaseUrl(async (pool) => {
      const client = await pool.connect();
      try {
        const rows = await planPhase21ProductionFlagBaseline(client);
        printJson({
          ok: true,
          command: 'production-flags:plan',
          mode: 'PLAN',
          applied: false,
          rows,
          notes: ['Read-only PLAN; APPLY requires --apply + env gates'],
        });
      } finally {
        client.release();
      }
    });
    return;
  }

  if (command === 'production-flags:apply') {
    if (!hasApplyArg(argv)) {
      printJson({
        ok: false,
        command: 'production-flags:apply',
        refuseCode: 'APPLY_ARGV_REQUIRED',
        message: 'Refused: pass --apply explicitly in addition to env gates',
      });
      process.exitCode = 1;
      return;
    }
    await withDatabaseUrl(async (pool) => {
      const client = await pool.connect();
      try {
        const result = await applyPhase21ProductionFlagBaseline(client, {
          reason:
            envNonEmpty('PHASE21_PRODUCTION_FLAG_BASELINE_REASON') ??
            'Phase 21 PRODUCTION safety flag baseline ceremony',
          changedByAdminId: envNonEmpty('PHASE21_CEREMONY_ADMIN_USER_ID'),
        });
        printJson({ ok: result.applied, command: 'production-flags:apply', result });
        if (!result.applied) process.exitCode = 1;
      } finally {
        client.release();
      }
    });
    return;
  }

  if (command === 'mainnet-registry:plan') {
    const master =
      envNonEmpty('TON_MAINNET_USDT_JETTON_MASTER') ??
      'EQD0vdSA_NedR9uvbgN9EikRX-suesDxGeFg69XQMavfLqIw';
    const url = envNonEmpty('DATABASE_URL');
    if (url === null) {
      const mock = {
        async query() {
          return { rows: [] };
        },
      };
      const items = await planPhase21MainnetRegistryBootstrap(mock, {
        usdtJettonMaster: master,
      });
      printJson({
        ok: true,
        command: 'mainnet-registry:plan',
        mode: 'PLAN',
        applied: false,
        items,
        notes: [
          'DATABASE_URL unset ? mock empty plan',
          'Set DATABASE_URL for live PLAN against target DB',
        ],
      });
      return;
    }
    await withDatabaseUrl(async (pool) => {
      const client = await pool.connect();
      try {
        const items = await planPhase21MainnetRegistryBootstrap(client, {
          usdtJettonMaster: master,
        });
        printJson({
          ok: true,
          command: 'mainnet-registry:plan',
          mode: 'PLAN',
          applied: false,
          items,
          notes: ['Read-only PLAN; APPLY requires --apply + env gates'],
        });
      } finally {
        client.release();
      }
    });
    return;
  }

  if (command === 'mainnet-registry:apply') {
    if (!hasApplyArg(argv)) {
      printJson({
        ok: false,
        command: 'mainnet-registry:apply',
        refuseCode: 'APPLY_ARGV_REQUIRED',
        message: 'Refused: pass --apply explicitly in addition to env gates',
      });
      process.exitCode = 1;
      return;
    }
    const master = envNonEmpty('TON_MAINNET_USDT_JETTON_MASTER');
    if (master === null) {
      printJson({
        ok: false,
        command: 'mainnet-registry:apply',
        refuseCode: 'USDT_MASTER_REQUIRED',
        message: 'TON_MAINNET_USDT_JETTON_MASTER required for APPLY',
      });
      process.exitCode = 1;
      return;
    }
    await withDatabaseUrl(async (pool) => {
      const client = await pool.connect();
      try {
        const result = await applyPhase21MainnetRegistryBootstrap(client, {
          usdtJettonMaster: master,
        });
        printJson({ ok: result.applied, command: 'mainnet-registry:apply', result });
        if (!result.applied) process.exitCode = 1;
      } finally {
        client.release();
      }
    });
    return;
  }

  if (command === 'verify-mainnet-external') {
    const jettonMaster = envNonEmpty('TON_MAINNET_USDT_JETTON_MASTER');
    const primaryKind = envNonEmpty('TON_PRIMARY_PROVIDER_KIND');
    const primaryUrl = envNonEmpty('TON_PRIMARY_PROVIDER_URL');
    const secondaryKind = envNonEmpty('TON_SECONDARY_PROVIDER_KIND');
    const secondaryUrl = envNonEmpty('TON_SECONDARY_PROVIDER_URL');
    if (
      jettonMaster === null ||
      primaryKind === null ||
      primaryUrl === null ||
      secondaryKind === null ||
      secondaryUrl === null
    ) {
      printJson({
        ok: false,
        command: 'verify-mainnet-external',
        message:
          'Requires TON_MAINNET_USDT_JETTON_MASTER and TON_PRIMARY/SECONDARY_PROVIDER_KIND/URL',
      });
      process.exitCode = 1;
      return;
    }
    const adapters = createPhase21MainnetExternalAdapters({
      primary: {
        kind: parseProviderKind(primaryKind),
        url: primaryUrl,
        apiKey: envNonEmpty('TON_PRIMARY_PROVIDER_KEY'),
      },
      secondary: {
        kind: parseProviderKind(secondaryKind),
        url: secondaryUrl,
        apiKey: envNonEmpty('TON_SECONDARY_PROVIDER_KEY'),
      },
    });
    const ownerAddress = envNonEmpty('TON_MAINNET_OWNER_ADDRESS');
    const result = await verifyMainnetUsdtWithTwoProviders({
      primary: { kind: primaryKind, url: primaryUrl },
      secondary: { kind: secondaryKind, url: secondaryUrl },
      jettonMaster,
      ...(ownerAddress !== null ? { ownerAddress } : {}),
      identityAdapter: adapters.identity,
      metadataAdapter: adapters.metadata,
      walletDerivationAdapter: adapters.derivation,
    });
    printJson({ ok: result.ok, command: 'verify-mainnet-external', result });
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === 'estimate-mainnet-fee') {
    const jettonMaster = envNonEmpty('TON_MAINNET_USDT_JETTON_MASTER');
    const primaryUrl = envNonEmpty('TON_PRIMARY_PROVIDER_URL');
    const primaryKind = (envNonEmpty('TON_PRIMARY_PROVIDER_KIND') ?? 'toncenter').toLowerCase();
    const forwardTonAtomic = 1n;
    if (jettonMaster === null || primaryUrl === null) {
      printJson({
        ok: false,
        command: 'estimate-mainnet-fee',
        message: 'Requires TON_MAINNET_USDT_JETTON_MASTER and TON_PRIMARY_PROVIDER_URL',
      });
      process.exitCode = 1;
      return;
    }

    const live = process.env.PHASE21_FEE_ESTIMATION_LIVE === '1';
    if (!live) {
      printJson({
        ok: true,
        command: 'estimate-mainnet-fee',
        result: {
          mode: 'MOCK',
          forwardTonAtomic: forwardTonAtomic.toString(10),
          attachedTonAtomicEstimated: null,
          attachedGramLifecycle: 'ESTIMATED',
          estimatedTotalNativeAtomic: null,
          broadcast: false,
          jettonMaster,
        },
        notes: [
          'MOCK mode (PHASE21_FEE_ESTIMATION_LIVE!=1)',
          'forward=1 nanogram',
          'attached remains ESTIMATED',
          'never broadcasts',
        ],
      });
      return;
    }

    if (primaryKind !== 'toncenter') {
      printJson({
        ok: true,
        command: 'estimate-mainnet-fee',
        result: {
          mode: 'UNAVAILABLE',
          forwardTonAtomic: forwardTonAtomic.toString(10),
          attachedTonAtomicEstimated: null,
          attachedGramLifecycle: 'ESTIMATED',
          estimatedTotalNativeAtomic: null,
          broadcast: false,
          providerKind: primaryKind,
          jettonMaster,
        },
        notes: [
          'Concrete fee adapter currently implemented for toncenter only',
          'forward=1 nanogram',
          'attached remains ESTIMATED',
          'never broadcasts',
        ],
      });
      return;
    }

    try {
      const provider = new ToncenterMainnetFeeProvider({
        baseUrl: primaryUrl,
        apiKey: envNonEmpty('TON_PRIMARY_PROVIDER_KEY'),
        estimateAddress: envNonEmpty('TON_FEE_ESTIMATE_ADDRESS'),
      });
      const liveResult = await provider.estimate({
        networkCode: 'TON_MAINNET',
        networkGlobalId: -239,
        jettonMasterIdentity: jettonMaster,
        netAmountAtomic: BigInt(envNonEmpty('TON_FEE_ESTIMATE_AMOUNT_ATOMIC') ?? '1000000'),
        forwardTonAtomic,
      });
      const attached = liveResult.attachedTonAtomicEstimated;
      printJson({
        ok: true,
        command: 'estimate-mainnet-fee',
        result: {
          mode: 'LIVE_READ_ONLY',
          forwardTonAtomic: forwardTonAtomic.toString(10),
          attachedTonAtomicEstimated: attached === null ? null : attached.toString(10),
          attachedGramLifecycle: 'ESTIMATED',
          estimatedTotalNativeAtomic:
            attached === null ? null : (attached + forwardTonAtomic).toString(10),
          broadcast: false,
          providerKind: liveResult.providerKind,
          providerHost: liveResult.providerHost,
          networkIdentity: liveResult.networkIdentity,
          estimateMethod: liveResult.estimateMethod,
          walletVersion: 'v5R1',
          jettonMaster,
        },
        notes: [
          'Read-only live Mainnet fee estimate; never broadcasts',
          'forward=1 nanogram',
          'attached remains ESTIMATED',
        ],
      });
    } catch (error: unknown) {
      printJson({
        ok: true,
        command: 'estimate-mainnet-fee',
        result: {
          mode: 'UNAVAILABLE',
          forwardTonAtomic: forwardTonAtomic.toString(10),
          attachedTonAtomicEstimated: null,
          attachedGramLifecycle: 'ESTIMATED',
          estimatedTotalNativeAtomic: null,
          broadcast: false,
          jettonMaster,
          message: error instanceof Error ? error.message : String(error),
        },
        notes: [
          'Live fee provider failed or untrustworthy; UNAVAILABLE (not MOCK relabeled)',
          'forward=1 nanogram',
          'attached remains ESTIMATED',
          'never broadcasts',
        ],
      });
    }
    return;
  }

  if (command === 'hot-wallet:plan') {
    const url = envNonEmpty('DATABASE_URL');
    const partial: Partial<{
      address: string;
      signerReference: string;
      payoutJettonWalletAddress: string;
      friendlyAddress: string | null;
      label: string | null;
      reason: string;
      changedByAdminId: string | null;
    }> = {
      ...(envNonEmpty('PHASE21_HOT_WALLET_ADDRESS')
        ? { address: envNonEmpty('PHASE21_HOT_WALLET_ADDRESS')! }
        : {}),
      ...(envNonEmpty('PHASE21_HOT_WALLET_SIGNER_REFERENCE')
        ? { signerReference: envNonEmpty('PHASE21_HOT_WALLET_SIGNER_REFERENCE')! }
        : {}),
      ...(envNonEmpty('PHASE21_HOT_WALLET_PAYOUT_JETTON_WALLET')
        ? {
            payoutJettonWalletAddress: envNonEmpty('PHASE21_HOT_WALLET_PAYOUT_JETTON_WALLET')!,
          }
        : {}),
      friendlyAddress: envNonEmpty('PHASE21_HOT_WALLET_FRIENDLY_ADDRESS'),
      label: envNonEmpty('PHASE21_HOT_WALLET_LABEL'),
      ...(envNonEmpty('PHASE21_HOT_WALLET_REASON')
        ? { reason: envNonEmpty('PHASE21_HOT_WALLET_REASON')! }
        : {}),
      changedByAdminId: envNonEmpty('PHASE21_CEREMONY_ADMIN_USER_ID'),
    };
    if (url === null) {
      const mock = {
        async query() {
          return { rows: [] };
        },
      };
      const plan = await planPhase21HotWalletRegistration(mock, partial);
      printJson({
        ok: true,
        command: 'hot-wallet:plan',
        mode: 'PLAN',
        plan,
        notes: ['DATABASE_URL unset ? mock plan'],
      });
      return;
    }
    await withDatabaseUrl(async (pool) => {
      const client = await pool.connect();
      try {
        const plan = await planPhase21HotWalletRegistration(client, partial);
        printJson({
          ok: true,
          command: 'hot-wallet:plan',
          mode: 'PLAN',
          plan,
          notes: ['Read-only PLAN; register requires --apply + env gates'],
        });
      } finally {
        client.release();
      }
    });
    return;
  }

  if (command === 'hot-wallet:register') {
    if (!hasApplyArg(argv)) {
      printJson({
        ok: false,
        command: 'hot-wallet:register',
        refuseCode: 'APPLY_ARGV_REQUIRED',
        message: 'Refused: pass --apply explicitly in addition to env gates',
      });
      process.exitCode = 1;
      return;
    }
    const address = envNonEmpty('PHASE21_HOT_WALLET_ADDRESS');
    const signerReference = envNonEmpty('PHASE21_HOT_WALLET_SIGNER_REFERENCE');
    const payoutJettonWalletAddress = envNonEmpty('PHASE21_HOT_WALLET_PAYOUT_JETTON_WALLET');
    const reason = envNonEmpty('PHASE21_HOT_WALLET_REASON');
    if (
      address === null ||
      signerReference === null ||
      payoutJettonWalletAddress === null ||
      reason === null
    ) {
      printJson({
        ok: false,
        command: 'hot-wallet:register',
        refuseCode: 'OWNER_INPUTS_REQUIRED',
        message:
          'Requires PHASE21_HOT_WALLET_ADDRESS, PHASE21_HOT_WALLET_SIGNER_REFERENCE, PHASE21_HOT_WALLET_PAYOUT_JETTON_WALLET, PHASE21_HOT_WALLET_REASON',
      });
      process.exitCode = 1;
      return;
    }
    await withDatabaseUrl(async (pool) => {
      const client = await pool.connect();
      try {
        const result = await applyPhase21HotWalletRegistration(client, {
          address,
          signerReference,
          payoutJettonWalletAddress,
          reason,
          friendlyAddress: envNonEmpty('PHASE21_HOT_WALLET_FRIENDLY_ADDRESS'),
          label: envNonEmpty('PHASE21_HOT_WALLET_LABEL'),
          changedByAdminId: envNonEmpty('PHASE21_CEREMONY_ADMIN_USER_ID'),
        });
        printJson({ ok: result.applied, command: 'hot-wallet:register', result });
        if (!result.applied) process.exitCode = 1;
      } finally {
        client.release();
      }
    });
    return;
  }

  usage();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ ok: false, message }));
  process.exit(1);
});
