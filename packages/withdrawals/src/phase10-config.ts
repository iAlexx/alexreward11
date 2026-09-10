import { WithdrawalDomainError } from './errors.js';

export const PHASE10_NETWORK_CODE = 'TON_TESTNET' as const;
export const PHASE10_NETWORK_GLOBAL_ID = -3 as const;
export const PHASE10_MAINNET_GLOBAL_ID = -239 as const;

export type Phase10ProviderKind = 'toncenter' | 'tonapi';

export interface Phase10ProviderEndpointConfig {
  readonly kind: Phase10ProviderKind | null;
  readonly url: string | null;
  readonly apiKey: string | null;
}

export interface Phase10PayoutConfig {
  readonly realChainEnabled: boolean;
  readonly signerBaseUrl: string;
  readonly signerServiceToken: string;
  readonly networkCode: typeof PHASE10_NETWORK_CODE;
  readonly networkGlobalId: typeof PHASE10_NETWORK_GLOBAL_ID;
  /** Owner-approved Testnet Jetton master. Null until Owner supplies it. */
  readonly jettonMasterIdentity: string | null;
  readonly primaryProvider: Phase10ProviderEndpointConfig;
  readonly secondaryProvider: Phase10ProviderEndpointConfig;
  /** When true, encrypted signer must be unlocked before sign. */
  readonly requireUnlock: boolean;
}

export interface Phase10ConfigInput {
  readonly realChainEnabled?: boolean;
  readonly signerBaseUrl?: string;
  readonly signerServiceToken?: string;
  readonly networkCode?: string;
  readonly networkGlobalId?: number;
  readonly jettonMasterIdentity?: string | null;
  readonly primaryProviderKind?: string | null;
  readonly primaryProviderUrl?: string | null;
  readonly primaryProviderApiKey?: string | null;
  readonly secondaryProviderKind?: string | null;
  readonly secondaryProviderUrl?: string | null;
  readonly secondaryProviderApiKey?: string | null;
  readonly requireUnlock?: boolean;
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function parseProviderKind(value: string | null | undefined): Phase10ProviderKind | null {
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
}): Phase10ProviderEndpointConfig {
  return {
    kind: parseProviderKind(input.kind),
    url: emptyToNull(input.url),
    apiKey: emptyToNull(input.apiKey),
  };
}

/**
 * Build Phase 10 payout config. Does not invent Owner Jetton master.
 * Call assertPhase10Ready before real Testnet dispatch.
 */
export function buildPhase10PayoutConfig(input: Phase10ConfigInput = {}): Phase10PayoutConfig {
  const networkCode = (input.networkCode ?? PHASE10_NETWORK_CODE).trim().toUpperCase();
  const networkGlobalId = input.networkGlobalId ?? PHASE10_NETWORK_GLOBAL_ID;

  if (networkCode.includes('MAINNET') || networkGlobalId === PHASE10_MAINNET_GLOBAL_ID) {
    throw new WithdrawalDomainError(
      'CONFIG',
      'MAINNET is forbidden for Phase 10 payout config (Testnet only)',
      { details: { networkCode, networkGlobalId } },
    );
  }
  if (networkCode !== PHASE10_NETWORK_CODE) {
    throw new WithdrawalDomainError('CONFIG', 'Phase 10 requires networkCode TON_TESTNET', {
      details: { networkCode },
    });
  }
  if (networkGlobalId !== PHASE10_NETWORK_GLOBAL_ID) {
    throw new WithdrawalDomainError(
      'CONFIG',
      'Phase 10 requires networkGlobalId -3 (TON Testnet)',
      { details: { networkGlobalId } },
    );
  }

  const signerBaseUrl = (input.signerBaseUrl ?? 'http://127.0.0.1:3005').trim().replace(/\/$/, '');
  if (signerBaseUrl === '') {
    throw new WithdrawalDomainError('CONFIG', 'signerBaseUrl is required for Phase 10');
  }

  return {
    realChainEnabled: input.realChainEnabled === true,
    signerBaseUrl,
    signerServiceToken: input.signerServiceToken ?? '',
    networkCode: PHASE10_NETWORK_CODE,
    networkGlobalId: PHASE10_NETWORK_GLOBAL_ID,
    jettonMasterIdentity: emptyToNull(input.jettonMasterIdentity),
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
    requireUnlock: input.requireUnlock === true,
  };
}

export interface Phase10ReadyCheck {
  readonly ready: boolean;
  readonly missingResources: readonly string[];
}

/**
 * Fail-closed readiness gate for real Testnet payout.
 * Does not invent Owner-approved Jetton master address.
 */
export function assertPhase10Ready(config: Phase10PayoutConfig): void {
  const missing = listPhase10MissingResources(config);
  if (missing.length > 0) {
    throw new WithdrawalDomainError(
      'EXTERNAL_RESOURCE_REQUIRED',
      `PHASE10_EXTERNAL_RESOURCE_REQUIRED: ${missing.join(', ')}`,
      { details: { missingResources: missing, code: 'PHASE10_EXTERNAL_RESOURCE_REQUIRED' } },
    );
  }
}

export function listPhase10MissingResources(config: Phase10PayoutConfig): string[] {
  const missing: string[] = [];
  if (!config.realChainEnabled) {
    missing.push('WITHDRAWAL_REAL_CHAIN_ENABLED=true (Owner enable real Testnet chain)');
  }
  if (config.jettonMasterIdentity === null) {
    missing.push('TON_TESTNET_JETTON_MASTER (Owner-approved Testnet Jetton master address)');
  }
  if (config.primaryProvider.kind === null) {
    missing.push('TON_PRIMARY_PROVIDER_KIND (toncenter|tonapi)');
  }
  if (config.primaryProvider.url === null) {
    missing.push('TON_PRIMARY_PROVIDER_URL (Testnet HTTP provider base URL)');
  }
  if (config.secondaryProvider.kind === null) {
    missing.push(
      'TON_SECONDARY_PROVIDER_KIND (independent secondary toncenter|tonapi for reconciliation)',
    );
  }
  if (config.secondaryProvider.url === null) {
    missing.push('TON_SECONDARY_PROVIDER_URL (independent secondary Testnet provider base URL)');
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
  if (config.signerServiceToken.trim().length < 32) {
    missing.push('SIGNER_SERVICE_TOKEN (32+ char shared token for signer HTTP client)');
  }
  return missing;
}

export function phase10ReadyCheck(config: Phase10PayoutConfig): Phase10ReadyCheck {
  const missingResources = listPhase10MissingResources(config);
  return { ready: missingResources.length === 0, missingResources };
}
