#!/usr/bin/env node
/**
 * Phase 21 operational ceremony CLI.
 *
 * PLAN / VERIFY / ESTIMATE: read-only.
 * APPLY / REGISTER: require --apply argv PLUS env gates; refuse otherwise.
 * Never unlocks signer, never funds, never broadcasts payouts.
 */
import { Pool } from 'pg';

import { ToncenterMainnetFeeProvider, tonAddressesEqual } from '@alex-rewards/ton';

import {
  buildPhase21PayoutConfig,
  listPhase21MissingResources,
} from '../phase21-config.js';
import { createPhase21MainnetExternalAdapters } from '../phase21-mainnet-adapters.js';
import {
  applyPhase21HotWalletRegistration,
  planPhase21HotWalletRegistration,
} from '../phase21-hot-wallet-registration.js';
import { openPhase21ApplyVerifiedPool } from '../phase21-ceremony-apply-cli.js';
import {
  attestPhase21HotWalletOfflineBackupsInteractive,
  confirmPhase21HotWalletRegisterInteractive,
  confirmPhase21MainnetRegistryApplyInteractive,
  confirmPhase21ProductionFlagsApplyInteractive,
} from '../phase21-ceremony-confirmations.js';
import {
  readPhase21HotWalletIdentityProofFile,
} from '../phase21-hot-wallet-identity-proof.js';
import { verifyPhase21HotWalletRegistrationReadOnly } from '../phase21-hot-wallet-post-register-verify.js';
import {
  buildPhase21HotWalletDerivationProofDocument,
  resolvePhase21HotWalletDerivationProofFromEnv,
  writePhase21HotWalletDerivationProofFile,
} from '../phase21-hot-wallet-derivation-proof.js';
import {
  applyPhase21MainnetRegistryBootstrap,
  planPhase21MainnetRegistryBootstrap,
} from '../phase21-mainnet-registry-bootstrap.js';
import { verifyPhase21MainnetRegistryBootstrapReadOnly } from '../phase21-mainnet-registry-post-apply-verify.js';
import {
  assertPhase21MainnetRegistryVerificationFresh,
  runLivePhase21MainnetRegistryVerificationAndMintTrust,
} from '../phase21-mainnet-registry-live-verify-mint.js';
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
  'production-flags:template',
  'production-flags:apply',
  'mainnet-registry:plan',
  'mainnet-registry:template',
  'mainnet-registry:apply',
  'verify-mainnet-external',
  'estimate-mainnet-fee',
  'hot-wallet:plan',
  'hot-wallet:register',
  'hot-wallet:verify-identity',
]);

function usage(): never {
  console.error(
    JSON.stringify({
      ok: false,
      message:
        'usage: phase21-ops <readiness|preflight|production-flags:plan|production-flags:template|production-flags:apply|mainnet-registry:plan|mainnet-registry:template|mainnet-registry:apply|verify-mainnet-external|estimate-mainnet-fee|hot-wallet:plan|hot-wallet:register|hot-wallet:verify-identity> [--apply]',
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


async function assertLivePlanDatabaseOrRefuse(
  command: string,
): Promise<{ pool: Pool; currentDatabase: string; requiredDatabase: string | null } | null> {
  const url = envNonEmpty('DATABASE_URL');
  if (url === null) {
    printJson({
      ok: false,
      command,
      refuseCode: 'LIVE_DATABASE_REQUIRED_FOR_PLAN',
      message: 'DATABASE_URL required for live PLAN (no silent mock empty-DB plan)',
      readyForLivePayout: false,
    });
    process.exitCode = 1;
    return null;
  }
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    const row = await client.query<{ name: string }>(`SELECT current_database() AS name`);
    const currentDatabase = row.rows[0]?.name ?? '';
    const requiredDatabase = envNonEmpty('PHASE21_CEREMONY_REQUIRED_DATABASE_NAME');
    if (requiredDatabase !== null && currentDatabase !== requiredDatabase) {
      printJson({
        ok: false,
        command,
        refuseCode: 'PLAN_DATABASE_IDENTITY_MISMATCH',
        message: 'current_database does not match PHASE21_CEREMONY_REQUIRED_DATABASE_NAME',
        current_database: currentDatabase,
        required_database: requiredDatabase,
        readyForLivePayout: false,
      });
      process.exitCode = 1;
      await pool.end();
      return null;
    }
    return { pool, currentDatabase, requiredDatabase };
  } finally {
    client.release();
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

    if (command === 'production-flags:template') {
    const mock = {
      async query() {
        return { rows: [] };
      },
    };
    const rows = await planPhase21ProductionFlagBaseline(mock);
    printJson({
      ok: true,
      command: 'production-flags:template',
      mode: 'SCHEMA_TEMPLATE_NOT_LIVE',
      applied: false,
      rows,
      notes: [
        'SCHEMA_TEMPLATE_NOT_LIVE',
        'Not a live PLAN; use production-flags:plan with DATABASE_URL',
      ],
      readyForLivePayout: false,
    });
    return;
  }

  if (command === 'production-flags:plan') {
    const live = await assertLivePlanDatabaseOrRefuse('production-flags:plan');
    if (live === null) return;
    try {
      const client = await live.pool.connect();
      try {
        const rows = await planPhase21ProductionFlagBaseline(client);
        printJson({
          ok: true,
          command: 'production-flags:plan',
          mode: 'PLAN',
          applied: false,
          rows,
          current_database: live.currentDatabase,
          required_database: live.requiredDatabase,
          notes: ['Read-only PLAN via DATABASE_URL; APPLY uses verified ceremony pool + Owner TTY auth'],
          readyForLivePayout: false,
        });
      } finally {
        client.release();
      }
    } finally {
      await live.pool.end();
    }
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
    let verifiedClose: (() => Promise<void>) | null = null;
    try {
      const { verified, trust } = await openPhase21ApplyVerifiedPool(argv);
      verifiedClose = verified.close;
      const client = await verified.pool.connect();
      try {
        const plan = await planPhase21ProductionFlagBaseline(client);
        printJson({
          ok: true,
          command: 'production-flags:apply',
          mode: 'FRESH_PLAN',
          plan,
          notes: ['Fresh PLAN before confirmation; DATABASE_URL-alone not used for APPLY'],
          readyForLivePayout: false,
        });
        const applyConfirmation = await confirmPhase21ProductionFlagsApplyInteractive();
        const result = await applyPhase21ProductionFlagBaseline(client, {
          reason:
            envNonEmpty('PHASE21_PRODUCTION_FLAG_BASELINE_REASON') ??
            'Phase 21 PRODUCTION safety flag baseline ceremony',
          ownerTrust: trust,
          applyConfirmation,
        });
        printJson({ ok: result.applied, command: 'production-flags:apply', result, readyForLivePayout: false });
        if (!result.applied) process.exitCode = 1;
      } finally {
        client.release();
      }
    } catch (error: unknown) {
      printJson({
        ok: false,
        command: 'production-flags:apply',
        message: error instanceof Error ? error.message : String(error),
        readyForLivePayout: false,
      });
      process.exitCode = 1;
    } finally {
      if (verifiedClose !== null) await verifiedClose();
    }
    return;
  }

    if (command === 'mainnet-registry:template') {
    const master = envNonEmpty('TON_MAINNET_USDT_JETTON_MASTER') ?? 'OWNER_SUPPLIED_MASTER_REQUIRED';
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
      command: 'mainnet-registry:template',
      mode: 'SCHEMA_TEMPLATE_NOT_LIVE',
      applied: false,
      items,
      notes: [
        'SCHEMA_TEMPLATE_NOT_LIVE',
        'Not a live PLAN; use mainnet-registry:plan with DATABASE_URL + TON_MAINNET_USDT_JETTON_MASTER',
      ],
      readyForLivePayout: false,
    });
    return;
  }

  if (command === 'mainnet-registry:plan') {
    const master = envNonEmpty('TON_MAINNET_USDT_JETTON_MASTER');
    if (master === null) {
      printJson({
        ok: false,
        command: 'mainnet-registry:plan',
        refuseCode: 'USDT_MASTER_REQUIRED',
        message: 'TON_MAINNET_USDT_JETTON_MASTER required for PLAN (hardcoded fallback removed)',
        readyForLivePayout: false,
      });
      process.exitCode = 1;
      return;
    }
    const live = await assertLivePlanDatabaseOrRefuse('mainnet-registry:plan');
    if (live === null) return;
    try {
      const client = await live.pool.connect();
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
          current_database: live.currentDatabase,
          required_database: live.requiredDatabase,
          notes: ['Read-only PLAN via DATABASE_URL; APPLY uses verified ceremony pool + Owner TTY auth'],
          readyForLivePayout: false,
        });
      } finally {
        client.release();
      }
    } finally {
      await live.pool.end();
    }
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
    const primaryKind = envNonEmpty('TON_PRIMARY_PROVIDER_KIND');
    const primaryUrl = envNonEmpty('TON_PRIMARY_PROVIDER_URL');
    const secondaryKind = envNonEmpty('TON_SECONDARY_PROVIDER_KIND');
    const secondaryUrl = envNonEmpty('TON_SECONDARY_PROVIDER_URL');
    if (
      master === null ||
      primaryKind === null ||
      primaryUrl === null ||
      secondaryKind === null ||
      secondaryUrl === null
    ) {
      printJson({
        ok: false,
        command: 'mainnet-registry:apply',
        refuseCode: 'PROVIDER_CONFIG_REQUIRED',
        message:
          'Requires TON_MAINNET_USDT_JETTON_MASTER and TON_PRIMARY/SECONDARY_PROVIDER_KIND/URL before Owner auth',
        readyForLivePayout: false,
      });
      process.exitCode = 1;
      return;
    }
    if (process.env.PHASE21_EXTERNAL_PROBE_LIVE !== '1') {
      printJson({
        ok: false,
        command: 'mainnet-registry:apply',
        refuseCode: 'LIVE_PROBE_REQUIRED',
        message:
          'PHASE21_EXTERNAL_PROBE_LIVE=1 required — mock/skipped/incomplete verification cannot authorize registry APPLY',
        readyForLivePayout: false,
      });
      process.exitCode = 1;
      return;
    }

    let verifiedClose: (() => Promise<void>) | null = null;
    try {
      // 1-5: in-process live verify+mint BEFORE Owner TTY confirmation / DB mutation.
      // Plain Phase21TwoProviderVerificationResult is never accepted as authority.
      const liveMint = await runLivePhase21MainnetRegistryVerificationAndMintTrust({
        jettonMaster: master,
        primary: {
          kind: primaryKind,
          url: primaryUrl,
          apiKey: envNonEmpty('TON_PRIMARY_PROVIDER_KEY'),
        },
        secondary: {
          kind: secondaryKind,
          url: secondaryUrl,
          apiKey: envNonEmpty('TON_SECONDARY_PROVIDER_KEY'),
        },
      });
      const mainnetVerification = liveMint.trust;
      assertPhase21MainnetRegistryVerificationFresh(mainnetVerification);
      printJson({
        ok: true,
        command: 'mainnet-registry:apply',
        mode: 'LIVE_TWO_PROVIDER_VERIFIED',
        networkGlobalId: mainnetVerification.networkGlobalId,
        symbol: mainnetVerification.symbol,
        decimals: mainnetVerification.decimals,
        providersIndependent: mainnetVerification.providersIndependent,
        verifiedAt: mainnetVerification.verifiedAt,
        diagnosticCode: liveMint.diagnostic.code,
        readyForLivePayout: false,
      });

      // 6-7: root-bound verify-full pool + Owner password+TOTP
      const { verified, trust } = await openPhase21ApplyVerifiedPool(argv);
      verifiedClose = verified.close;
      const client = await verified.pool.connect();
      try {
        // Freshness again immediately before PLAN / confirmation / mutation
        assertPhase21MainnetRegistryVerificationFresh(mainnetVerification);

        // 8-9: fresh PLAN; branded master must equal PLAN/apply master
        const plan = await planPhase21MainnetRegistryBootstrap(client, {
          usdtJettonMaster: master,
        });
        const planMasterOk = plan.every((item) => {
          const detailsMaster = item.details['usdtJettonMaster'] ?? item.details['contractIdentity'];
          if (typeof detailsMaster !== 'string' || detailsMaster.trim() === '') return true;
          return tonAddressesEqual(detailsMaster, master);
        });
        if (!planMasterOk || !tonAddressesEqual(mainnetVerification.jettonMaster, master)) {
          printJson({
            ok: false,
            command: 'mainnet-registry:apply',
            refuseCode: 'REGISTRY_VERIFIED_MASTER_MISMATCH',
            message: 'Branded verification master must equal registry PLAN/APPLY master',
            readyForLivePayout: false,
          });
          process.exitCode = 1;
          return;
        }
        printJson({
          ok: true,
          command: 'mainnet-registry:apply',
          mode: 'FRESH_PLAN',
          items: plan,
          notes: [
            'Fresh PLAN after live two-provider verification and Owner auth',
            'DATABASE_URL-alone not used for APPLY',
            'verify-mainnet-external JSON is NOT reusable as APPLY authority',
          ],
          readyForLivePayout: false,
        });

        // 10: exact Owner TTY final phrase
        const applyConfirmation = await confirmPhase21MainnetRegistryApplyInteractive();
        assertPhase21MainnetRegistryVerificationFresh(mainnetVerification);
        // 11: APPLY
        const result = await applyPhase21MainnetRegistryBootstrap(client, {
          usdtJettonMaster: master,
          ownerTrust: trust,
          applyConfirmation,
          mainnetVerification,
          reason:
            envNonEmpty('PHASE21_MAINNET_REGISTRY_REASON') ??
            'Phase 21 Mainnet registry bootstrap ceremony',
        });
        if (!result.applied) {
          printJson({
            ok: false,
            command: 'mainnet-registry:apply',
            result,
            readyForLivePayout: false,
          });
          process.exitCode = 1;
          return;
        }
        // 12: read-only post-apply verification
        const post = await verifyPhase21MainnetRegistryBootstrapReadOnly(client, {
          mainnetVerification,
          adminUserId: trust.adminUserId,
        });
        printJson({
          ok: true,
          command: 'mainnet-registry:apply',
          result,
          postApplyVerify: post,
          readyForLivePayout: false,
        });
      } finally {
        client.release();
      }
    } catch (error: unknown) {
      printJson({
        ok: false,
        command: 'mainnet-registry:apply',
        message: error instanceof Error ? error.message : String(error),
        readyForLivePayout: false,
      });
      process.exitCode = 1;
    } finally {
      if (verifiedClose !== null) await verifiedClose();
    }
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

    let derivationProofPath: string | null = null;
    if (
      result.ok &&
      ownerAddress !== null &&
      result.primaryJettonWalletAddress &&
      result.secondaryJettonWalletAddress &&
      result.derivedJettonWalletsAgree === true
    ) {
      const outPath = envNonEmpty('PHASE21_HOT_WALLET_DERIVATION_PROOF_OUT');
      if (outPath !== null) {
        const doc = buildPhase21HotWalletDerivationProofDocument({
          primaryJettonWalletAddress: result.primaryJettonWalletAddress,
          secondaryJettonWalletAddress: result.secondaryJettonWalletAddress,
          ownerAddress,
          jettonMaster,
          primaryProviderKind: primaryKind,
          secondaryProviderKind: secondaryKind,
        });
        writePhase21HotWalletDerivationProofFile(outPath, doc);
        derivationProofPath = outPath;
      }
    }

    printJson({
      ok: result.ok,
      command: 'verify-mainnet-external',
      result,
      ...(derivationProofPath !== null
        ? {
            derivationProofPath,
            derivationProofMethod: 'DUAL_PROVIDER_LIVE',
            notes: [
              'Sanitized derivation proof written for hot-wallet:plan / hot-wallet:register',
              'Set PHASE21_HOT_WALLET_DERIVATION_PROOF_FILE to this path',
            ],
          }
        : {}),
    });
    if (!result.ok) process.exitCode = 1;
    return;
  }

    if (command === 'estimate-mainnet-fee') {
    const jettonMaster = envNonEmpty('TON_MAINNET_USDT_JETTON_MASTER');
    const primaryUrl = envNonEmpty('TON_PRIMARY_PROVIDER_URL');
    const primaryKind = (envNonEmpty('TON_PRIMARY_PROVIDER_KIND') ?? 'toncenter').toLowerCase();
    const forwardTonAtomic = 1n;
    const amounts = [190_000n, 5_000_000n] as const; // 0.19 USDT and 5 USDT (6 decimals)
    if (jettonMaster === null || primaryUrl === null) {
      printJson({
        ok: false,
        command: 'estimate-mainnet-fee',
        message: 'Requires TON_MAINNET_USDT_JETTON_MASTER and TON_PRIMARY_PROVIDER_URL',
        readyForLivePayout: false,
      });
      process.exitCode = 1;
      return;
    }

    const live = process.env.PHASE21_FEE_ESTIMATION_LIVE === '1';
    if (!live) {
      printJson({
        ok: true,
        command: 'estimate-mainnet-fee',
        cases: amounts.map((netAmountAtomic) => ({
          netAmountAtomic: netAmountAtomic.toString(10),
          mode: 'MOCK',
          estimatedNetworkFeeAtomic: null,
          candidateAttachedGramAtomic: null,
          forwardGramAtomic: forwardTonAtomic.toString(10),
          estimatedTotalNativeExposureAtomic: null,
          attachedGramLifecycle: 'ESTIMATED',
          broadcast: false,
          jettonMaster,
        })),
        notes: [
          'MOCK mode (PHASE21_FEE_ESTIMATION_LIVE!=1)',
          'forward=1 nanogram',
          'attached remains ESTIMATED; fee distinct from attached',
          'never broadcasts',
        ],
        readyForLivePayout: false,
      });
      return;
    }

    if (primaryKind !== 'toncenter') {
      printJson({
        ok: true,
        command: 'estimate-mainnet-fee',
        cases: amounts.map((netAmountAtomic) => ({
          netAmountAtomic: netAmountAtomic.toString(10),
          mode: 'UNAVAILABLE',
          estimatedNetworkFeeAtomic: null,
          candidateAttachedGramAtomic: null,
          forwardGramAtomic: forwardTonAtomic.toString(10),
          estimatedTotalNativeExposureAtomic: null,
          attachedGramLifecycle: 'ESTIMATED',
          broadcast: false,
          providerKind: primaryKind,
          jettonMaster,
        })),
        notes: [
          'Concrete fee adapter currently implemented for toncenter only',
          'never broadcasts',
        ],
        readyForLivePayout: false,
      });
      return;
    }

    try {
      const estimateAddress =
        envNonEmpty('TON_FEE_ESTIMATE_ADDRESS') ?? envNonEmpty('PHASE21_HOT_WALLET_ADDRESS');
      const provider = new ToncenterMainnetFeeProvider({
        baseUrl: primaryUrl,
        apiKey: envNonEmpty('TON_PRIMARY_PROVIDER_KEY'),
        estimateAddress,
      });
      const cases = [];
      for (const netAmountAtomic of amounts) {
        try {
          const liveResult = await provider.estimate({
            networkCode: 'TON_MAINNET',
            networkGlobalId: -239,
            jettonMasterIdentity: jettonMaster,
            netAmountAtomic,
            forwardTonAtomic,
            ...(estimateAddress !== null
              ? {
                  destinationAddress: estimateAddress,
                  responseDestination: estimateAddress,
                }
              : {}),
          });
          cases.push({
            netAmountAtomic: netAmountAtomic.toString(10),
            mode: 'LIVE_READ_ONLY',
            estimatedNetworkFeeAtomic:
              liveResult.estimatedNetworkFeeAtomic === null
                ? null
                : liveResult.estimatedNetworkFeeAtomic.toString(10),
            candidateAttachedGramAtomic:
              liveResult.candidateAttachedGramAtomic === null
                ? null
                : liveResult.candidateAttachedGramAtomic.toString(10),
            forwardGramAtomic: liveResult.forwardGramAtomic.toString(10),
            estimatedTotalNativeExposureAtomic:
              liveResult.estimatedTotalNativeExposureAtomic === null
                ? null
                : liveResult.estimatedTotalNativeExposureAtomic.toString(10),
            attachedGramLifecycle: 'ESTIMATED',
            broadcast: false,
            providerKind: liveResult.providerKind,
            providerHost: liveResult.providerHost,
            networkIdentity: liveResult.networkIdentity,
            estimateMethod: liveResult.estimateMethod,
            emulationMethod: liveResult.emulationMethod,
            walletVersion: 'v5R1',
            jettonMaster,
          });
        } catch (error: unknown) {
          cases.push({
            netAmountAtomic: netAmountAtomic.toString(10),
            mode: 'UNAVAILABLE',
            estimatedNetworkFeeAtomic: null,
            candidateAttachedGramAtomic: null,
            forwardGramAtomic: forwardTonAtomic.toString(10),
            estimatedTotalNativeExposureAtomic: null,
            attachedGramLifecycle: 'ESTIMATED',
            broadcast: false,
            jettonMaster,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      printJson({
        ok: true,
        command: 'estimate-mainnet-fee',
        cases,
        notes: [
          'Read-only live Mainnet fee estimate; never broadcasts',
          'Cases: 0.19 USDT (190000) and 5 USDT (5000000)',
          'estimatedTotalNativeExposureAtomic = candidateAttached + forward; network fee separate',
        ],
        readyForLivePayout: false,
      });
    } catch (error: unknown) {
      printJson({
        ok: true,
        command: 'estimate-mainnet-fee',
        result: {
          mode: 'UNAVAILABLE',
          estimatedNetworkFeeAtomic: null,
          candidateAttachedGramAtomic: null,
          forwardGramAtomic: forwardTonAtomic.toString(10),
          estimatedTotalNativeExposureAtomic: null,
          attachedGramLifecycle: 'ESTIMATED',
          broadcast: false,
          jettonMaster,
          message: error instanceof Error ? error.message : String(error),
        },
        notes: ['Live fee provider failed; UNAVAILABLE', 'never broadcasts'],
        readyForLivePayout: false,
      });
    }
    return;
  }

if (command === 'hot-wallet:plan') {
    const url = envNonEmpty('DATABASE_URL');
    const derivationResolved = resolvePhase21HotWalletDerivationProofFromEnv();
    // PLAN may surface incomplete ENV provenance as blockers; hard-refuse only structural failures.
    if (
      derivationResolved.refuseCode !== undefined &&
      derivationResolved.refuseCode !== 'DERIVATION_PROOF_ENV_PROVENANCE_INCOMPLETE'
    ) {
      printJson({
        ok: false,
        command: 'hot-wallet:plan',
        refuseCode: derivationResolved.refuseCode,
        message: derivationResolved.message ?? 'derivation proof refused',
        readyForLivePayout: false,
      });
      process.exitCode = 1;
      return;
    }
    const partial: Partial<{
      address: string;
      signerReference: string;
      payoutJettonWalletAddress: string;
      friendlyAddress: string | null;
      label: string | null;
      reason: string;
      derivationProof: NonNullable<typeof derivationResolved.proof>;
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
      ...(derivationResolved.proof !== null
        ? { derivationProof: derivationResolved.proof }
        : {}),
    };
    if (url === null) {
      printJson({
        ok: false,
        command: 'hot-wallet:plan',
        refuseCode: 'LIVE_DATABASE_REQUIRED_FOR_PLAN',
        message: 'DATABASE_URL required for live PLAN (no silent mock empty-DB plan)',
        readyForLivePayout: false,
      });
      process.exitCode = 1;
      return;
    }
    await withDatabaseUrl(async (pool) => {
      const client = await pool.connect();
      try {
        const plan = await planPhase21HotWalletRegistration(client, partial);
        const dbRow = await client.query<{ name: string }>(`SELECT current_database() AS name`);
        const currentDatabase = dbRow.rows[0]?.name ?? null;
        const requiredDatabase = envNonEmpty('PHASE21_CEREMONY_REQUIRED_DATABASE_NAME');
        if (requiredDatabase !== null && currentDatabase !== requiredDatabase) {
          printJson({
            ok: false,
            command: 'hot-wallet:plan',
            refuseCode: 'PLAN_DATABASE_IDENTITY_MISMATCH',
            current_database: currentDatabase,
            required_database: requiredDatabase,
            message: 'current_database does not match PHASE21_CEREMONY_REQUIRED_DATABASE_NAME',
            readyForLivePayout: false,
          });
          process.exitCode = 1;
          return;
        }
        printJson({
          ok: true,
          command: 'hot-wallet:plan',
          mode: 'PLAN',
          plan,
          current_database: currentDatabase,
          required_database: requiredDatabase,
          derivationProofSource: derivationResolved.source,
          derivationProofMethod: derivationResolved.proof?.method ?? null,
          notes: [
            'Read-only PLAN; register requires --apply + env gates',
            'Derivation proof required for canRegister/READY (DUAL_PROVIDER_LIVE via file or env)',
          ],
          readyForLivePayout: false,
        });
      } finally {
        client.release();
      }
    });
    return;
  }

  if (command === 'hot-wallet:verify-identity') {
    // Cryptographic decrypt lives in apps/signer to avoid withdrawals↔signing cycles.
    printJson({
      ok: false,
      command: 'hot-wallet:verify-identity',
      refuseCode: 'USE_SIGNER_CLI',
      message:
        'Use: pnpm --filter @alex-rewards/signer run phase21:hot-wallet:verify-identity (PHASE21_HOT_WALLET_BUNDLE_PATH + optional PHASE21_HOT_WALLET_IDENTITY_PROOF_OUT)',
      readyForLivePayout: false,
    });
    process.exitCode = 1;
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
    const identityProofPath = envNonEmpty('PHASE21_HOT_WALLET_IDENTITY_PROOF_FILE');
    if (
      address === null ||
      signerReference === null ||
      payoutJettonWalletAddress === null ||
      reason === null ||
      identityProofPath === null
    ) {
      printJson({
        ok: false,
        command: 'hot-wallet:register',
        refuseCode: 'OWNER_INPUTS_REQUIRED',
        message:
          'Requires PHASE21_HOT_WALLET_ADDRESS, PHASE21_HOT_WALLET_SIGNER_REFERENCE, PHASE21_HOT_WALLET_PAYOUT_JETTON_WALLET, PHASE21_HOT_WALLET_REASON, PHASE21_HOT_WALLET_IDENTITY_PROOF_FILE',
      });
      process.exitCode = 1;
      return;
    }
    const derivationResolved = resolvePhase21HotWalletDerivationProofFromEnv();
    if (derivationResolved.refuseCode !== undefined || derivationResolved.proof === null) {
      printJson({
        ok: false,
        command: 'hot-wallet:register',
        refuseCode:
          derivationResolved.refuseCode ?? 'DERIVATION_PROOF_REQUIRED',
        message:
          derivationResolved.message ??
          'DUAL_PROVIDER_LIVE derivation proof required (PHASE21_HOT_WALLET_DERIVATION_PROOF_FILE or env fields)',
      });
      process.exitCode = 1;
      return;
    }
    const derivationProof = derivationResolved.proof;
    const derivationProofSource = derivationResolved.source;
    const identityProof = readPhase21HotWalletIdentityProofFile(identityProofPath);
    let verifiedClose: (() => Promise<void>) | null = null;
    try {
      const { verified, trust } = await openPhase21ApplyVerifiedPool(argv);
      verifiedClose = verified.close;
      const client = await verified.pool.connect();
      try {
        const plan = await planPhase21HotWalletRegistration(client, {
          address,
          signerReference,
          payoutJettonWalletAddress,
          reason,
          friendlyAddress: envNonEmpty('PHASE21_HOT_WALLET_FRIENDLY_ADDRESS'),
          label: envNonEmpty('PHASE21_HOT_WALLET_LABEL'),
          ownerTrust: trust,
          identityProof,
          derivationProof,
        });
        printJson({
          ok: true,
          command: 'hot-wallet:register',
          mode: 'FRESH_PLAN',
          plan,
          notes: ['Fresh PLAN before attestation/confirmation'],
          readyForLivePayout: false,
        });
        const hotWalletBackupAttestation = await attestPhase21HotWalletOfflineBackupsInteractive();
        const applyConfirmation = await confirmPhase21HotWalletRegisterInteractive();
        const result = await applyPhase21HotWalletRegistration(client, {
          address,
          signerReference,
          payoutJettonWalletAddress,
          reason,
          friendlyAddress: envNonEmpty('PHASE21_HOT_WALLET_FRIENDLY_ADDRESS'),
          label: envNonEmpty('PHASE21_HOT_WALLET_LABEL'),
          ownerTrust: trust,
          identityProof,
          hotWalletBackupAttestation,
          applyConfirmation,
          derivationProof,
        });
        let postRegister = null;
        if (result.applied && result.hotWalletId !== null) {
          postRegister = await verifyPhase21HotWalletRegistrationReadOnly(client, {
            address,
            signerReference,
            payoutJettonWalletAddress,
            friendlyAddress: envNonEmpty('PHASE21_HOT_WALLET_FRIENDLY_ADDRESS'),
            hotWalletId: result.hotWalletId,
            adminUserId: trust.adminUserId,
          });
        }
        printJson({
          ok: result.applied,
          command: 'hot-wallet:register',
          result,
          postRegister,
          derivationProofSource,
          derivationProofMethod: derivationProof.method,
          readyForLivePayout: false,
        });
        if (!result.applied) process.exitCode = 1;
      } finally {
        client.release();
      }
    } catch (error: unknown) {
      printJson({
        ok: false,
        command: 'hot-wallet:register',
        message: error instanceof Error ? error.message : String(error),
        readyForLivePayout: false,
      });
      process.exitCode = 1;
    } finally {
      if (verifiedClose !== null) await verifiedClose();
    }
    return;
  }

  usage();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ ok: false, message }));
  process.exit(1);
});
