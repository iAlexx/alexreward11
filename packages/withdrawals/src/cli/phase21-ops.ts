#!/usr/bin/env node
/**
 * Phase 21 operational tooling CLI (read-only).
 *
 * Never unlocks signer, never enables Mainnet, never funds wallets,
 * never creates/approves/broadcasts withdrawals, never mutates DB.
 *
 * Exit semantics: exit 0 with overall BLOCKED / blocked preflight verdict
 * in JSON (tooling success). Non-zero only for usage/unexpected errors.
 */
import {
  buildPhase21PayoutConfig,
  listPhase21MissingResources,
} from '../phase21-config.js';
import { runPhase21Preflight } from '../phase21-preflight.js';
import {
  buildPhase21ReadinessReport,
  defaultPhase21Step1Observations,
  type Phase21ReadinessObservations,
} from '../phase21-readiness.js';

const COMMANDS = new Set(['readiness', 'preflight']);

function usage(): never {
  console.error(
    JSON.stringify({
      ok: false,
      message: 'usage: phase21-ops <readiness|preflight>',
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
    return [
      `PHASE21_CONFIG: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function main(): void {
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

  usage();
}

try {
  main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ ok: false, message }));
  process.exit(1);
}
