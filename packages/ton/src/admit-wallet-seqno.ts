/**
 * Canonical fail-closed Wallet V5R1 seqno admission (Phase 10).
 *
 * NEVER maps TonCenter exit_code=-13 alone to seqno=0.
 * NEVER silently switches primary provider to TonAPI.
 * Uninitialized wallets admit seqno=0 only when dual independent providers agree
 * the account is uninitialized AND local StateInit derives the approved address.
 */

import { createHash } from 'node:crypto';

import { Address, Cell } from '@ton/core';
import { WalletContractV5R1 } from '@ton/ton';

import {
  TON_TESTNET_NETWORK_GLOBAL_ID,
  type TonAccountState,
  type TonAccountStatus,
  type TonChainProvider,
} from './chain-provider.js';
import { isTonProviderRateLimit, TonProviderHttpError } from './provider-http.js';
import { walletStateInitForSeqno } from './wallet-v5r1-state-init.js';

export type AdmitWalletSeqnoBlockCode =
  | 'NETWORK_NOT_TESTNET'
  | 'SIGNER_REFERENCE_MISMATCH'
  | 'PUBLIC_KEY_INVALID'
  | 'STATEINIT_ADDRESS_MISMATCH'
  | 'SECONDARY_PROVIDER_REQUIRED'
  | 'PROVIDER_DISAGREEMENT'
  | 'ACCOUNT_FROZEN'
  | 'ACCOUNT_UNEXPECTED_STATUS'
  | 'UNEXPECTED_DEPLOYED_CODE'
  | 'SEQNO_UNAVAILABLE'
  | 'SEQNO_INCONSISTENT'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'MALFORMED_RESPONSE'
  | 'PROVIDER_ERROR'
  | 'CONFLICTING_EVIDENCE';

export interface AdmitWalletSeqnoInput {
  readonly networkGlobalId: number;
  readonly hotWalletAddress: string;
  /** 32-byte Ed25519 public key as 64-char hex. */
  readonly publicKeyHex: string;
  /** Observed signer key reference (fingerprint) from Signer / material. */
  readonly signerKeyReference: string;
  /** Approved Hot Wallet signer_reference from DB. */
  readonly approvedSignerKeyReference: string;
  readonly primary: TonChainProvider;
  readonly secondary: TonChainProvider;
  readonly workchain?: number;
}

export interface AdmitWalletSeqnoSuccess {
  readonly ok: true;
  readonly seqno: number;
  readonly accountStatus: 'uninit' | 'active';
  readonly requiresStateInit: boolean;
  readonly derivedAddressRaw: string;
  readonly approvedCodeHash: string;
  readonly primary: TonAccountState;
  readonly secondary: TonAccountState;
  readonly publicKeyFingerprint: string;
}

export interface AdmitWalletSeqnoBlocked {
  readonly ok: false;
  readonly code: AdmitWalletSeqnoBlockCode;
  readonly message: string;
  readonly primary?: TonAccountState;
  readonly secondary?: TonAccountState;
}

export type AdmitWalletSeqnoResult = AdmitWalletSeqnoSuccess | AdmitWalletSeqnoBlocked;

function normalizeHex(value: string): string {
  return value.trim().toLowerCase().replace(/^0x/, '');
}

function publicKeyFingerprintHex(publicKey: Buffer): string {
  return createHash('sha256').update(publicKey).digest('hex');
}

function addressesEqual(left: string, right: string): boolean {
  try {
    return Address.parse(left).equals(Address.parse(right));
  } catch {
    return normalizeHex(left) === normalizeHex(right);
  }
}

function isUninitStatus(status: TonAccountStatus): boolean {
  return status === 'uninit' || status === 'nonexist';
}

function classifyProviderError(error: unknown): AdmitWalletSeqnoBlockCode {
  if (isTonProviderRateLimit(error)) return 'RATE_LIMITED';
  if (error instanceof TonProviderHttpError && error.status === 429) return 'RATE_LIMITED';
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out|AbortError|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(message)) {
    return 'TIMEOUT';
  }
  if (/MALFORMED_RESPONSE/i.test(message)) return 'MALFORMED_RESPONSE';
  if (/RATE_LIMIT|HTTP 429/i.test(message)) return 'RATE_LIMITED';
  return 'PROVIDER_ERROR';
}

/** Approved Wallet V5R1 code hash for the given public key / network. */
export function approvedWalletV5R1CodeHash(input: {
  readonly publicKeyHex: string;
  readonly networkGlobalId: number;
  readonly workchain?: number;
}): string {
  const publicKey = Buffer.from(normalizeHex(input.publicKeyHex), 'hex');
  if (publicKey.length !== 32) {
    throw new Error('PUBLIC_KEY_INVALID: expected 32-byte hex public key');
  }
  const wallet = WalletContractV5R1.create({
    publicKey,
    workchain: input.workchain ?? 0,
    walletId: { networkGlobalId: input.networkGlobalId },
  });
  const code = wallet.init.code;
  if (!(code instanceof Cell)) {
    throw new Error('UNEXPECTED_DEPLOYED_CODE: missing V5R1 code cell');
  }
  return code.hash().toString('hex');
}

export function deriveWalletV5R1AddressRaw(input: {
  readonly publicKeyHex: string;
  readonly networkGlobalId: number;
  readonly workchain?: number;
}): string {
  const publicKey = Buffer.from(normalizeHex(input.publicKeyHex), 'hex');
  if (publicKey.length !== 32) {
    throw new Error('PUBLIC_KEY_INVALID: expected 32-byte hex public key');
  }
  const wallet = WalletContractV5R1.create({
    publicKey,
    workchain: input.workchain ?? 0,
    walletId: { networkGlobalId: input.networkGlobalId },
  });
  return wallet.address.toRawString();
}

/**
 * Fail-closed dual-provider seqno admission for approved Hot Wallet V5R1.
 */
export async function admitWalletSeqno(
  input: AdmitWalletSeqnoInput,
): Promise<AdmitWalletSeqnoResult> {
  if (input.networkGlobalId !== TON_TESTNET_NETWORK_GLOBAL_ID) {
    return {
      ok: false,
      code: 'NETWORK_NOT_TESTNET',
      message: `seqno admission requires networkGlobalId=${TON_TESTNET_NETWORK_GLOBAL_ID}`,
    };
  }
  if (input.secondary === undefined || input.secondary === null) {
    return {
      ok: false,
      code: 'SECONDARY_PROVIDER_REQUIRED',
      message: 'independent secondary provider required for seqno admission',
    };
  }

  const publicKeyHex = normalizeHex(input.publicKeyHex);
  if (!/^[0-9a-f]{64}$/.test(publicKeyHex)) {
    return {
      ok: false,
      code: 'PUBLIC_KEY_INVALID',
      message: 'publicKeyHex must be 64 hex characters',
    };
  }

  const approvedRef = normalizeHex(input.approvedSignerKeyReference);
  const observedRef = normalizeHex(input.signerKeyReference);
  if (approvedRef === '' || observedRef === '' || approvedRef !== observedRef) {
    return {
      ok: false,
      code: 'SIGNER_REFERENCE_MISMATCH',
      message: 'signer reference does not match approved Hot Wallet identity',
    };
  }

  const publicKey = Buffer.from(publicKeyHex, 'hex');
  const fingerprint = publicKeyFingerprintHex(publicKey);
  if (fingerprint !== approvedRef) {
    return {
      ok: false,
      code: 'SIGNER_REFERENCE_MISMATCH',
      message: 'public key fingerprint does not match approved signer_reference',
    };
  }

  let derivedAddressRaw: string;
  let approvedCodeHash: string;
  try {
    const derivation = {
      publicKeyHex,
      networkGlobalId: input.networkGlobalId,
      ...(input.workchain !== undefined ? { workchain: input.workchain } : {}),
    };
    derivedAddressRaw = deriveWalletV5R1AddressRaw(derivation);
    approvedCodeHash = approvedWalletV5R1CodeHash(derivation);
  } catch (error) {
    return {
      ok: false,
      code: 'PUBLIC_KEY_INVALID',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (!addressesEqual(derivedAddressRaw, input.hotWalletAddress)) {
    return {
      ok: false,
      code: 'STATEINIT_ADDRESS_MISMATCH',
      message:
        'locally derived Wallet V5R1 StateInit address does not match approved Hot Wallet address',
    };
  }

  // Prove StateInit for seqno=0 would target the approved address (identity gate).
  try {
    const wallet = WalletContractV5R1.create({
      publicKey,
      workchain: input.workchain ?? 0,
      walletId: { networkGlobalId: input.networkGlobalId },
    });
    const stateInit = walletStateInitForSeqno(0, wallet.init);
    if (stateInit === undefined || stateInit.code === undefined) {
      return {
        ok: false,
        code: 'CONFLICTING_EVIDENCE',
        message: 'Wallet V5R1 StateInit missing for seqno=0 identity proof',
      };
    }
  } catch (error) {
    return {
      ok: false,
      code: 'CONFLICTING_EVIDENCE',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  let primaryState: TonAccountState;
  let secondaryState: TonAccountState;
  try {
    [primaryState, secondaryState] = await Promise.all([
      input.primary.getAccountState(input.hotWalletAddress),
      input.secondary.getAccountState(input.hotWalletAddress),
    ]);
  } catch (error) {
    return {
      ok: false,
      code: classifyProviderError(error),
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (primaryState.status === 'frozen' || secondaryState.status === 'frozen') {
    return {
      ok: false,
      code: 'ACCOUNT_FROZEN',
      message: 'Hot Wallet account is frozen',
      primary: primaryState,
      secondary: secondaryState,
    };
  }

  if (primaryState.status === 'unknown' || secondaryState.status === 'unknown') {
    return {
      ok: false,
      code: 'ACCOUNT_UNEXPECTED_STATUS',
      message: 'provider returned unknown account status',
      primary: primaryState,
      secondary: secondaryState,
    };
  }

  const primaryUninit = isUninitStatus(primaryState.status);
  const secondaryUninit = isUninitStatus(secondaryState.status);
  const primaryActive = primaryState.status === 'active';
  const secondaryActive = secondaryState.status === 'active';

  if (primaryUninit !== secondaryUninit || primaryActive !== secondaryActive) {
    return {
      ok: false,
      code: 'PROVIDER_DISAGREEMENT',
      message: `account status disagreement primary=${primaryState.status} secondary=${secondaryState.status}`,
      primary: primaryState,
      secondary: secondaryState,
    };
  }

  if (primaryUninit && secondaryUninit) {
    // Dual-provider uninitialized → admit seqno=0 only (identity already proven above).
    return {
      ok: true,
      seqno: 0,
      accountStatus: 'uninit',
      requiresStateInit: true,
      derivedAddressRaw,
      approvedCodeHash,
      primary: primaryState,
      secondary: secondaryState,
      publicKeyFingerprint: fingerprint,
    };
  }

  if (!primaryActive || !secondaryActive) {
    return {
      ok: false,
      code: 'ACCOUNT_UNEXPECTED_STATUS',
      message: `unexpected account status primary=${primaryState.status} secondary=${secondaryState.status}`,
      primary: primaryState,
      secondary: secondaryState,
    };
  }

  const primaryCode = primaryState.codeHash !== null ? normalizeHex(primaryState.codeHash) : null;
  const secondaryCode =
    secondaryState.codeHash !== null ? normalizeHex(secondaryState.codeHash) : null;
  const approved = normalizeHex(approvedCodeHash);

  if (primaryCode !== null && primaryCode !== approved) {
    return {
      ok: false,
      code: 'UNEXPECTED_DEPLOYED_CODE',
      message: 'primary reported code hash does not match approved Wallet V5R1',
      primary: primaryState,
      secondary: secondaryState,
    };
  }
  if (secondaryCode !== null && secondaryCode !== approved) {
    return {
      ok: false,
      code: 'UNEXPECTED_DEPLOYED_CODE',
      message: 'secondary reported code hash does not match approved Wallet V5R1',
      primary: primaryState,
      secondary: secondaryState,
    };
  }
  if (primaryCode !== null && secondaryCode !== null && primaryCode !== secondaryCode) {
    return {
      ok: false,
      code: 'PROVIDER_DISAGREEMENT',
      message: 'active wallet code hash disagreement between providers',
      primary: primaryState,
      secondary: secondaryState,
    };
  }
  // At least one provider must confirm code when active (fail-closed if both omit).
  if (primaryCode === null && secondaryCode === null) {
    return {
      ok: false,
      code: 'UNEXPECTED_DEPLOYED_CODE',
      message: 'active wallet code hash unavailable from both providers',
      primary: primaryState,
      secondary: secondaryState,
    };
  }

  let primarySeqno: number;
  try {
    primarySeqno = await input.primary.getSeqno(input.hotWalletAddress);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Explicit: never treat exit_code=-13 as seqno=0 once status is active.
    if (/exit_code\s*=?\s*-13/i.test(message)) {
      return {
        ok: false,
        code: 'SEQNO_UNAVAILABLE',
        message:
          'TonCenter seqno exit_code=-13 on provider-reported active account (blocked; never maps to 0)',
        primary: primaryState,
        secondary: secondaryState,
      };
    }
    return {
      ok: false,
      code: classifyProviderError(error),
      message,
      primary: primaryState,
      secondary: secondaryState,
    };
  }

  if (!Number.isSafeInteger(primarySeqno) || primarySeqno < 0) {
    return {
      ok: false,
      code: 'MALFORMED_RESPONSE',
      message: `invalid primary seqno=${String(primarySeqno)}`,
      primary: primaryState,
      secondary: secondaryState,
    };
  }

  // Independent consistency where secondary can also read seqno.
  try {
    const secondarySeqno = await input.secondary.getSeqno(input.hotWalletAddress);
    if (
      Number.isSafeInteger(secondarySeqno) &&
      secondarySeqno >= 0 &&
      secondarySeqno !== primarySeqno
    ) {
      return {
        ok: false,
        code: 'SEQNO_INCONSISTENT',
        message: `seqno disagreement primary=${primarySeqno} secondary=${secondarySeqno}`,
        primary: primaryState,
        secondary: secondaryState,
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Secondary seqno failure on active wallet is fail-closed (no silent primary-only admit).
    if (/exit_code\s*=?\s*-13/i.test(message)) {
      return {
        ok: false,
        code: 'SEQNO_UNAVAILABLE',
        message: 'secondary seqno exit_code=-13 on active account (blocked)',
        primary: primaryState,
        secondary: secondaryState,
      };
    }
    return {
      ok: false,
      code: classifyProviderError(error),
      message: `secondary seqno check failed: ${message}`,
      primary: primaryState,
      secondary: secondaryState,
    };
  }

  return {
    ok: true,
    seqno: primarySeqno,
    accountStatus: 'active',
    requiresStateInit: primarySeqno === 0,
    derivedAddressRaw,
    approvedCodeHash,
    primary: primaryState,
    secondary: secondaryState,
    publicKeyFingerprint: fingerprint,
  };
}
