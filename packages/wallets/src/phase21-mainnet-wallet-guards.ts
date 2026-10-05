/**
 * Phase 21 Mainnet wallet guards — pure helpers (no DB).
 *
 * Network mapping, payout address shape, and documentation constants for
 * primary-change fresh proof / cooldown. Wallet app display names are never security authority.
 */
import { WalletDomainError } from './errors.js';

/** Primary wallet change always requires a fresh ton_proof (documentation constant). */
export const PRIMARY_CHANGE_REQUIRES_FRESH_PROOF = true as const;

/** V1.2 / Phase 21: 24h withdrawal cooldown after primary change (documentation constant). */
export const PRIMARY_CHANGE_WITHDRAWAL_COOLDOWN_HOURS = 24 as const;

export const TON_MAINNET_CONNECT_NETWORK_ID = '-239' as const;
export const TON_TESTNET_CONNECT_NETWORK_ID = '-3' as const;

export interface MainnetNetworkMappingInput {
  readonly acceptedNetworkCode: string;
  /** Server-derived TonConnect network id from authoritative networks row. */
  readonly tonConnectNetworkId: string;
  /**
   * Optional client-supplied network claim. When present must exactly match
   * tonConnectNetworkId — client never overrides Mainnet authority.
   */
  readonly clientNetworkId?: string | null;
}

/**
 * Accept -239 for TON_MAINNET; reject -3 on Mainnet config; reject client override.
 */
export function assertAcceptedMainnetNetworkMapping(input: MainnetNetworkMappingInput): void {
  const code = input.acceptedNetworkCode.trim().toUpperCase();
  const serverId = String(input.tonConnectNetworkId).trim();

  if (code === 'TON_MAINNET') {
    if (serverId === TON_TESTNET_CONNECT_NETWORK_ID) {
      throw new WalletDomainError('INVALID_NETWORK', 'Network is not accepted', {
        details: {
          reason: 'TESTNET_NETWORK_ID_ON_MAINNET_CONFIG',
          tonConnectNetworkId: serverId,
        },
      });
    }
    if (serverId !== TON_MAINNET_CONNECT_NETWORK_ID) {
      throw new WalletDomainError('INVALID_NETWORK', 'Network is not accepted', {
        details: {
          reason: 'MAINNET_NETWORK_ID_MISMATCH',
          expected: TON_MAINNET_CONNECT_NETWORK_ID,
          tonConnectNetworkId: serverId,
        },
      });
    }
  }

  const clientRaw = input.clientNetworkId;
  if (clientRaw !== undefined && clientRaw !== null && String(clientRaw).trim() !== '') {
    const clientId = String(clientRaw).trim();
    if (clientId !== serverId) {
      throw new WalletDomainError('INVALID_NETWORK', 'Network is not accepted', {
        details: {
          reason: 'CLIENT_NETWORK_OVERRIDE_REJECTED',
          clientNetworkId: clientId,
          tonConnectNetworkId: serverId,
        },
      });
    }
  }
}

const RAW_TON_RE = /^0:[0-9a-fA-F]{64}$/;
const FRIENDLY_TON_RE = /^[EU]Q[A-Za-z0-9_-]{46}$/;

/**
 * Reject TRON (T...), EVM (0x), Solana-ish long base58 non-TON shapes.
 * Allow raw 0:hex and friendly EQ/UQ.
 */
export function assertTonPayoutAddressShape(address: string): string {
  const trimmed = address.trim();
  if (trimmed.length === 0) {
    throw new WalletDomainError('INVALID_ADDRESS', 'Wallet ownership proof was rejected', {
      details: { reason: 'ADDRESS_EMPTY' },
    });
  }
  if (trimmed.startsWith('0x') || trimmed.startsWith('0X')) {
    throw new WalletDomainError('INVALID_ADDRESS', 'Wallet ownership proof was rejected', {
      details: { reason: 'EVM_ADDRESS_REJECTED' },
    });
  }
  // TRON mainnet addresses are base58check starting with T (typically 34 chars).
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(trimmed)) {
    throw new WalletDomainError('INVALID_ADDRESS', 'Wallet ownership proof was rejected', {
      details: { reason: 'TRON_ADDRESS_REJECTED' },
    });
  }
  if (RAW_TON_RE.test(trimmed) || FRIENDLY_TON_RE.test(trimmed)) {
    return trimmed;
  }
  // Solana-ish: long base58 without TON friendly/raw shape.
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed) && !trimmed.startsWith('EQ') && !trimmed.startsWith('UQ')) {
    throw new WalletDomainError('INVALID_ADDRESS', 'Wallet ownership proof was rejected', {
      details: { reason: 'SOLANA_ISH_ADDRESS_REJECTED' },
    });
  }
  throw new WalletDomainError('INVALID_ADDRESS', 'Wallet ownership proof was rejected', {
    details: { reason: 'TON_ADDRESS_SHAPE_REJECTED' },
  });
}

/**
 * Wallet app display name is display-only — never a security/trust authority.
 * Returns a note suitable for logs/UI; does not throw.
 */
export function assertWalletAppNameNotAuthority(walletName: string): string {
  const trimmed = walletName.trim();
  const label = trimmed.length === 0 ? '(unnamed)' : trimmed.slice(0, 120);
  return `Wallet app name "${label}" is display-only and is never security authority`;
}

/** Documentation helper: primary change always needs fresh proof + 24h cooldown. */
export function primaryChangePolicyNotes(): readonly string[] {
  return [
    `PRIMARY_CHANGE_REQUIRES_FRESH_PROOF=${String(PRIMARY_CHANGE_REQUIRES_FRESH_PROOF)}`,
    `PRIMARY_CHANGE_WITHDRAWAL_COOLDOWN_HOURS=${String(PRIMARY_CHANGE_WITHDRAWAL_COOLDOWN_HOURS)}`,
  ];
}
