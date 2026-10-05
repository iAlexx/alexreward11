/**
 * Phase 21 — Mainnet micro-launch payout configuration.
 *
 * Explicit authority layer independent of Phase 10 Testnet config.
 * Default: Mainnet disabled. Missing Owner resources fail closed.
 * Does NOT invent Mainnet USDT Jetton master.
 * Does NOT enable Mainnet from NODE_ENV / Railway env name / branch name.
 */
import { WithdrawalDomainError } from './errors.js';

export const PHASE21_NETWORK_CODE = 'TON_MAINNET' as const;
export const PHASE21_NETWORK_GLOBAL_ID = -239 as const;
export const PHASE21_TESTNET_NETWORK_GLOBAL_ID = -3 as const;
export const PHASE21_WALLET_VERSION = 'v5R1' as const;
export const PHASE21_REQUIRED_CONFIRMED_WITHDRAWALS = 50 as const;

/** Spec section 178: approximately 5-10 USDT (atomic @ 6 decimals). Not 50 USDT. */
export const PHASE21_MICRO_LAUNCH_USDT_ATOMIC_MIN = 5_000_000n;
export const PHASE21_MICRO_LAUNCH_USDT_ATOMIC_MAX = 10_000_000n;

/** Known Testnet/local placeholders that must never pass as Mainnet Jetton master. */
export const PHASE21_FORBIDDEN_JETTON_PLACEHOLDERS = [
  'LOCAL-TESTONLY-PLACEHOLDER-USDT-JETTON-MASTER',
  'EQ_owner_approved_testnet_jetton_master',
] as const;

export type Phase21ProviderKind = 'toncenter' | 'tonapi';

export interface Phase21ProviderEndpointConfig {
  readonly kind: Phase21ProviderKind | null;
  readonly url: string | null;
  readonly apiKey: string | null;
}

export interface Phase21PayoutConfig {
  readonly phase21MainnetEnabled: boolean;
  readonly realChainEnabled: boolean;
  readonly fakeChainEnabled: boolean;
  readonly signerBaseUrl: string;
  readonly signerServiceToken: string;
  readonly networkCode: typeof PHASE21_NETWORK_CODE;
  readonly networkGlobalId: typeof PHASE21_NETWORK_GLOBAL_ID;
  readonly walletVersion: typeof PHASE21_WALLET_VERSION;
  readonly signerKeyMode: 'self_hosted_encrypted';
  readonly jettonMasterIdentity: string | null;
  readonly primaryProvider: Phase21ProviderEndpointConfig;
  readonly secondaryProvider: Phase21ProviderEndpointConfig;
  readonly requireUnlock: boolean;
  readonly autoPayoutAllowed: false;
  readonly autoUnpauseAllowed: false;
  readonly autoResendAllowed: false;
  readonly manualApprovalOnly: true;
}

export interface Phase21ConfigInput {
  readonly phase21MainnetEnabled?: boolean;
  readonly realChainEnabled?: boolean;
  readonly fakeChainEnabled?: boolean;
  readonly signerBaseUrl?: string;
  readonly signerServiceToken?: string;
  readonly networkCode?: string;
  readonly networkGlobalId?: number;
  readonly walletVersion?: string;
  readonly signerKeyMode?: string;
  readonly jettonMasterIdentity?: string | null;
  readonly primaryProviderKind?: string | null;
  readonly primaryProviderUrl?: string | null;
  readonly primaryProviderApiKey?: string | null;
  readonly secondaryProviderKind?: string | null;
  readonly secondaryProviderUrl?: string | null;
  readonly secondaryProviderApiKey?: string | null;
  readonly requireUnlock?: boolean;
  readonly autoPayoutAllowed?: boolean;
  readonly autoUnpauseAllowed?: boolean;
  readonly autoResendAllowed?: boolean;
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function parseProviderKind(value: string | null | undefined): Phase21ProviderKind | null {
  const normalized = emptyToNull(value)?.toLowerCase() ?? null;
  if (normalized === null) return null;
  if (normalized === 'toncenter' || normalized === 'tonapi') {
    return normalized;
  }
  throw new WithdrawalDomainError(
    'CONFIG',
    `Unsupported TON provider kind "${value}"; expected toncenter|tonapi`,
    { details: { kind: value } },
  );
}

function buildProviderEndpoint(input: {
  readonly kind?: string | null;
  readonly url?: string | null;
  readonly apiKey?: string | null;
}): Phase21ProviderEndpointConfig {
  return {
    kind: parseProviderKind(input.kind),
    url: emptyToNull(input.url),
    apiKey: emptyToNull(input.apiKey),
  };
}

function isForbiddenJettonPlaceholder(identity: string): boolean {
  const upper = identity.trim().toUpperCase();
  return PHASE21_FORBIDDEN_JETTON_PLACEHOLDERS.some(
    (placeholder) => placeholder.toUpperCase() === upper || upper.includes('TESTNET'),
  );
}

/**
 * Build Phase 21 Mainnet payout config.
 * Refuses unless phase21MainnetEnabled === true.
 */
export function buildPhase21PayoutConfig(input: Phase21ConfigInput = {}): Phase21PayoutConfig {
  if (input.phase21MainnetEnabled !== true) {
    throw new WithdrawalDomainError(
      'CONFIG',
      'Phase 21 Mainnet payout config requires explicit phase21MainnetEnabled=true',
      { details: { phase21MainnetEnabled: input.phase21MainnetEnabled ?? false } },
    );
  }

  if (input.autoPayoutAllowed === true) {
    throw new WithdrawalDomainError(
      'CONFIG',
      'Phase 21 micro-launch forbids auto payout (manual approval only)',
    );
  }
  if (input.autoUnpauseAllowed === true) {
    throw new WithdrawalDomainError('CONFIG', 'Phase 21 forbids auto unpause');
  }
  if (input.autoResendAllowed === true) {
    throw new WithdrawalDomainError('CONFIG', 'Phase 21 forbids auto resend / blind resend');
  }
  if (input.fakeChainEnabled === true) {
    throw new WithdrawalDomainError(
      'CONFIG',
      'Phase 21 Mainnet forbids fake-chain payout adapter',
    );
  }

  const networkCode = (input.networkCode ?? PHASE21_NETWORK_CODE).trim().toUpperCase();
  const networkGlobalId = input.networkGlobalId ?? PHASE21_NETWORK_GLOBAL_ID;

  if (networkCode !== PHASE21_NETWORK_CODE) {
    throw new WithdrawalDomainError('CONFIG', 'Phase 21 requires networkCode TON_MAINNET', {
      details: { networkCode },
    });
  }
  if (networkGlobalId !== PHASE21_NETWORK_GLOBAL_ID) {
    // Includes explicit Testnet -3 rejection (PHASE21_TESTNET_NETWORK_GLOBAL_ID).
    throw new WithdrawalDomainError(
      'CONFIG',
      networkGlobalId === PHASE21_TESTNET_NETWORK_GLOBAL_ID
        ? 'Phase 21 rejects Testnet networkGlobalId -3'
        : 'Phase 21 requires networkGlobalId -239 (TON Mainnet)',
      { details: { networkGlobalId } },
    );
  }

  const walletVersion = (input.walletVersion ?? PHASE21_WALLET_VERSION).trim();
  if (walletVersion !== PHASE21_WALLET_VERSION) {
    throw new WithdrawalDomainError('CONFIG', 'Phase 21 requires walletVersion v5R1', {
      details: { walletVersion },
    });
  }

  const signerKeyMode = (input.signerKeyMode ?? 'self_hosted_encrypted').trim();
  if (signerKeyMode !== 'self_hosted_encrypted') {
    throw new WithdrawalDomainError(
      'CONFIG',
      'Phase 21 requires SIGNER_KEY_MODE=self_hosted_encrypted',
      { details: { signerKeyMode } },
    );
  }

  const jettonMasterIdentity = emptyToNull(input.jettonMasterIdentity);
  if (jettonMasterIdentity !== null && isForbiddenJettonPlaceholder(jettonMasterIdentity)) {
    throw new WithdrawalDomainError(
      'CONFIG',
      'Testnet/local Jetton identity cannot be used as Phase 21 Mainnet Jetton master',
      { details: { jettonMasterIdentity } },
    );
  }

  const signerBaseUrl = (input.signerBaseUrl ?? '').trim().replace(/\/$/, '');

  return {
    phase21MainnetEnabled: true,
    realChainEnabled: input.realChainEnabled === true,
    fakeChainEnabled: false,
    signerBaseUrl,
    signerServiceToken: input.signerServiceToken ?? '',
    networkCode: PHASE21_NETWORK_CODE,
    networkGlobalId: PHASE21_NETWORK_GLOBAL_ID,
    walletVersion: PHASE21_WALLET_VERSION,
    signerKeyMode: 'self_hosted_encrypted',
    jettonMasterIdentity,
    primaryProvider: buildProviderEndpoint({
      kind: input.primaryProviderKind ?? null,
      url: input.primaryProviderUrl ?? null,
      apiKey: input.primaryProviderApiKey ?? null,
    }),
    secondaryProvider: buildProviderEndpoint({
      kind: input.secondaryProviderKind ?? null,
      url: input.secondaryProviderUrl ?? null,
      apiKey: input.secondaryProviderApiKey ?? null,
    }),
    requireUnlock: input.requireUnlock !== false,
    autoPayoutAllowed: false,
    autoUnpauseAllowed: false,
    autoResendAllowed: false,
    manualApprovalOnly: true,
  };
}

export interface Phase21ReadyCheck {
  readonly ready: boolean;
  readonly missingResources: readonly string[];
}

export function listPhase21MissingResources(config: Phase21PayoutConfig): string[] {
  const missing: string[] = [];
  if (!config.phase21MainnetEnabled) {
    missing.push('PHASE21_MAINNET_ENABLED=true (explicit Owner Mainnet gate)');
  }
  if (!config.realChainEnabled) {
    missing.push('WITHDRAWAL_REAL_CHAIN_ENABLED=true (Owner enable real Mainnet chain)');
  }
  if (config.fakeChainEnabled) {
    missing.push('WITHDRAWAL_FAKE_CHAIN_ENABLED=false (fake chain must be disabled)');
  }
  if (config.jettonMasterIdentity === null) {
    missing.push(
      'TON_MAINNET_USDT_JETTON_MASTER (Owner-approved Mainnet USDT Jetton master; OWNER_EXTERNAL_RESOURCE_REQUIRED)',
    );
  }
  if (config.primaryProvider.kind === null) {
    missing.push('TON_PRIMARY_PROVIDER_KIND (toncenter|tonapi)');
  }
  if (config.primaryProvider.url === null) {
    missing.push('TON_PRIMARY_PROVIDER_URL (Mainnet HTTP provider base URL)');
  }
  if (config.secondaryProvider.kind === null) {
    missing.push(
      'TON_SECONDARY_PROVIDER_KIND (independent secondary toncenter|tonapi for reconciliation)',
    );
  }
  if (config.secondaryProvider.url === null) {
    missing.push('TON_SECONDARY_PROVIDER_URL (independent secondary Mainnet provider base URL)');
  }
  if (
    config.primaryProvider.kind !== null &&
    config.secondaryProvider.kind !== null &&
    config.primaryProvider.kind === config.secondaryProvider.kind &&
    config.primaryProvider.url === config.secondaryProvider.url
  ) {
    missing.push(
      'TON_SECONDARY_PROVIDER_* must be operationally independent from primary (different vendor/endpoint)',
    );
  }
  if (config.signerBaseUrl.trim() === '') {
    missing.push('SIGNER_BASE_URL (production signer HTTP base URL)');
  }
  if (config.signerServiceToken.trim().length < 32) {
    missing.push('SIGNER_SERVICE_TOKEN (32+ char shared token for signer HTTP client)');
  }
  return missing;
}

export function assertPhase21Ready(config: Phase21PayoutConfig): void {
  const missing = listPhase21MissingResources(config);
  if (missing.length > 0) {
    throw new WithdrawalDomainError(
      'EXTERNAL_RESOURCE_REQUIRED',
      `PHASE21_EXTERNAL_RESOURCE_REQUIRED: ${missing.join(', ')}`,
      { details: { missingResources: missing, code: 'PHASE21_EXTERNAL_RESOURCE_REQUIRED' } },
    );
  }
}

export function phase21ReadyCheck(config: Phase21PayoutConfig): Phase21ReadyCheck {
  const missingResources = listPhase21MissingResources(config);
  return { ready: missingResources.length === 0, missingResources };
}

export function assessPhase21InitialFundingExposure(
  observedUsdtAtomic: bigint | null,
): {
  readonly status: 'NOT_OBSERVED' | 'WITHIN_BAND' | 'BELOW_BAND' | 'EXCESSIVE';
  readonly message: string;
} {
  if (observedUsdtAtomic === null) {
    return {
      status: 'NOT_OBSERVED',
      message: 'Hot Wallet USDT balance not observed; funding ceremony not executed in Step 1',
    };
  }
  if (observedUsdtAtomic > PHASE21_MICRO_LAUNCH_USDT_ATOMIC_MAX) {
    return {
      status: 'EXCESSIVE',
      message: `Observed USDT ${observedUsdtAtomic.toString(10)} exceeds micro-launch band max ${PHASE21_MICRO_LAUNCH_USDT_ATOMIC_MAX.toString(10)} (~10 USDT)`,
    };
  }
  if (observedUsdtAtomic < PHASE21_MICRO_LAUNCH_USDT_ATOMIC_MIN) {
    return {
      status: 'BELOW_BAND',
      message: `Observed USDT ${observedUsdtAtomic.toString(10)} below micro-launch band min ${PHASE21_MICRO_LAUNCH_USDT_ATOMIC_MIN.toString(10)} (~5 USDT)`,
    };
  }
  return {
    status: 'WITHIN_BAND',
    message: 'Observed USDT within Spec section 178 approximately 5-10 USDT micro-launch band',
  };
}
