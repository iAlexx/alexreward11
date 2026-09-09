import { Address } from '@ton/core';

import { TonDomainError } from './errors.js';

export interface CanonicalTonAddress {
  readonly workchain: number;
  /** Deterministic `workchain:hex` lowercase form (no bounceable/url variants). */
  readonly rawAddress: string;
  /** Server-derived bounceable URL-safe friendly form. */
  readonly friendlyAddress: string;
  readonly addressHash: Buffer;
}

/**
 * Canonicalize any accepted TON textual encoding to one logical account.
 * Never trust client formatting for uniqueness.
 */
export function canonicalizeTonAddress(input: string): CanonicalTonAddress {
  const trimmed = input.trim();
  if (trimmed === '') {
    throw new TonDomainError('INVALID_ADDRESS', 'TON address is invalid');
  }
  let address: Address;
  try {
    address = Address.parse(trimmed);
  } catch (error) {
    throw new TonDomainError('INVALID_ADDRESS', 'TON address is invalid', { cause: error });
  }
  const rawAddress = `${address.workChain}:${address.hash.toString('hex')}`;
  return {
    workchain: address.workChain,
    rawAddress,
    friendlyAddress: address.toString({ urlSafe: true, bounceable: true }),
    addressHash: Buffer.from(address.hash),
  };
}

/** Parse TON Connect account address form `0:<hex>` / `-1:<hex>`. */
export function parseTonConnectAccountAddress(accountAddress: string): CanonicalTonAddress {
  const trimmed = accountAddress.trim();
  const match = /^(-?\d+):([0-9a-fA-F]{64})$/.exec(trimmed);
  if (match === null) {
    return canonicalizeTonAddress(trimmed);
  }
  const workchain = Number(match[1]);
  const hex = match[2] ?? '';
  if (!Number.isInteger(workchain)) {
    throw new TonDomainError('INVALID_ADDRESS', 'TON address is invalid');
  }
  try {
    const address = Address.parseRaw(`${workchain}:${hex.toLowerCase()}`);
    return {
      workchain: address.workChain,
      rawAddress: `${address.workChain}:${address.hash.toString('hex')}`,
      friendlyAddress: address.toString({ urlSafe: true, bounceable: true }),
      addressHash: Buffer.from(address.hash),
    };
  } catch (error) {
    throw new TonDomainError('INVALID_ADDRESS', 'TON address is invalid', { cause: error });
  }
}
