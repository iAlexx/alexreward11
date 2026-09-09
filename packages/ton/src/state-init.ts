import { beginCell, Cell, loadStateInit, storeStateInit, type StateInit } from '@ton/core';
import { WalletContractV3R2, WalletContractV4, WalletContractV5R1 } from '@ton/ton';

import { TonDomainError } from './errors.js';

const ZERO_KEY = Buffer.alloc(32);

function knownCodeHashes(): ReadonlyMap<string, 'V3R2' | 'V4' | 'V5R1'> {
  const map = new Map<string, 'V3R2' | 'V4' | 'V5R1'>();
  map.set(
    WalletContractV3R2.create({ workchain: 0, publicKey: ZERO_KEY })
      .init.code.hash()
      .toString('hex'),
    'V3R2',
  );
  map.set(
    WalletContractV4.create({ workchain: 0, publicKey: ZERO_KEY }).init.code.hash().toString('hex'),
    'V4',
  );
  map.set(
    WalletContractV5R1.create({ workchain: 0, publicKey: ZERO_KEY })
      .init.code.hash()
      .toString('hex'),
    'V5R1',
  );
  return map;
}

const CODE_HASH_TO_VERSION = knownCodeHashes();

function extractPublicKeyFromData(version: 'V3R2' | 'V4' | 'V5R1', data: Cell): Buffer {
  const slice = data.beginParse();
  try {
    if (version === 'V5R1') {
      // isSignatureAuthAllowed (1) + seqno (32) + walletId (32) + publicKey (256) + extensions
      slice.loadBit();
      slice.loadUint(32);
      slice.loadUint(32);
      return Buffer.from(slice.loadBuffer(32));
    }
    // V3R2 / V4: seqno (32) + walletId (32) + publicKey (256)
    slice.loadUint(32);
    slice.loadUint(32);
    return Buffer.from(slice.loadBuffer(32));
  } catch (error) {
    throw new TonDomainError('INVALID_WALLET', 'Wallet state cannot be verified', { cause: error });
  }
}

export function parseStateInitFromBase64(stateInitBase64: string): StateInit {
  try {
    const cell = Cell.fromBase64(stateInitBase64);
    return loadStateInit(cell.beginParse());
  } catch (error) {
    throw new TonDomainError('INVALID_WALLET', 'Wallet state cannot be verified', { cause: error });
  }
}

/**
 * Extract Ed25519 public key from a known standard wallet StateInit.
 * Unknown / unsupported wallet code fails closed as INVALID_WALLET.
 */
export function extractPublicKeyFromStateInit(stateInit: StateInit): Buffer {
  if (
    stateInit.code === null ||
    stateInit.code === undefined ||
    stateInit.data === null ||
    stateInit.data === undefined
  ) {
    throw new TonDomainError('INVALID_WALLET', 'Wallet state cannot be verified');
  }
  const codeHash = stateInit.code.hash().toString('hex');
  const version = CODE_HASH_TO_VERSION.get(codeHash);
  if (version === undefined) {
    throw new TonDomainError('INVALID_WALLET', 'Wallet state cannot be verified', {
      details: { reason: 'UNSUPPORTED_WALLET_CODE' },
    });
  }
  return extractPublicKeyFromData(version, stateInit.data);
}

/** Ensure StateInit hash matches the declared account address hash. */
export function assertStateInitMatchesAddress(stateInit: StateInit, addressHash: Buffer): void {
  const cell = beginCell().store(storeStateInit(stateInit)).endCell();
  if (!cell.hash().equals(addressHash)) {
    throw new TonDomainError('INVALID_WALLET', 'Wallet state does not match account address');
  }
}
