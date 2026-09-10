import { Address } from '@ton/core';
import { WalletContractV5R1 } from '@ton/ton';

import { SIGNER_BOUNDARY } from './boundary.js';
import { SignerError } from './errors.js';

export interface WalletV5R1DerivationInput {
  readonly publicKey: Buffer;
  readonly networkGlobalId: number;
  readonly workchain?: number;
}

export interface WalletV5R1Derivation {
  readonly addressRaw: string;
  readonly addressFriendly: string;
  readonly networkGlobalId: number;
  readonly workchain: number;
  readonly walletVersion: 'v5R1';
}

export function deriveWalletV5R1(input: WalletV5R1DerivationInput): WalletV5R1Derivation {
  if (input.publicKey.length !== 32) {
    throw new SignerError('POLICY_REJECTED', 'Wallet V5 R1 public key must be 32 bytes');
  }
  if (input.networkGlobalId === SIGNER_BOUNDARY.networkGlobalIdMainnet) {
    throw new SignerError('MAINNET_REJECTED', 'Phase 9 rejects MAINNET Wallet V5 R1 identity');
  }
  if (input.networkGlobalId !== SIGNER_BOUNDARY.networkGlobalIdTestnet) {
    throw new SignerError(
      'POLICY_REJECTED',
      `Phase 9 requires TESTNET networkGlobalId ${SIGNER_BOUNDARY.networkGlobalIdTestnet}`,
      { networkGlobalId: input.networkGlobalId },
    );
  }

  const workchain = input.workchain ?? 0;
  const wallet = WalletContractV5R1.create({
    publicKey: input.publicKey,
    workchain,
    walletId: {
      networkGlobalId: input.networkGlobalId,
    },
  });

  return {
    addressRaw: wallet.address.toRawString(),
    addressFriendly: wallet.address.toString({ bounceable: true, urlSafe: true, testOnly: true }),
    networkGlobalId: input.networkGlobalId,
    workchain,
    walletVersion: 'v5R1',
  };
}

export function addressesEqual(a: string, b: string): boolean {
  try {
    return Address.parse(a).equals(Address.parse(b));
  } catch {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }
}
