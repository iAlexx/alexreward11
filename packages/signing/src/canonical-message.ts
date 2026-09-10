import { Address, beginCell, internal, SendMode, type Cell, type MessageRelaxed } from '@ton/core';
import { WalletContractV5R1 } from '@ton/ton';

import { SignerError } from './errors.js';

/** TEP-74 Jetton transfer op code. */
export const JETTON_TRANSFER_OP = 0xf8a7ea5;

/**
 * TESTNET/SPIKE only: attached TON for jetton-wallet gas.
 * Not a production funding / Mainnet default.
 */
export const SPIKE_JETTON_ATTACHED_TON = 50_000_000n; // 0.05 TON

/**
 * TESTNET/SPIKE only: forward TON amount inside jetton transfer body.
 */
export const SPIKE_JETTON_FORWARD_TON = 1n;

export const SPIKE_SEND_MODE = SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS;

export interface CanonicalPayoutIntent {
  readonly publicKey: Buffer;
  readonly networkGlobalId: number;
  readonly workchain: number;
  readonly subwalletNumber: number;
  readonly seqno: number;
  readonly validUntil: number;
  readonly queryId: bigint;
  readonly netAmountAtomic: bigint;
  readonly recipientAddress: string;
  readonly hotWalletAddress: string;
  readonly payoutJettonWalletAddress: string;
  readonly jettonMasterIdentity: string;
}

export interface CanonicalMessageBuild {
  readonly signingCell: Cell;
  readonly signingHash: Buffer;
  readonly canonicalMessageHashHex: string;
  readonly outboundMessages: MessageRelaxed[];
  readonly walletAddressRaw: string;
  readonly jettonMasterIdentity: string;
}

export function buildJettonTransferBodyForIntent(intent: CanonicalPayoutIntent): Cell {
  const destination = Address.parse(intent.recipientAddress);
  const responseDestination = Address.parse(intent.hotWalletAddress);
  return beginCell()
    .storeUint(JETTON_TRANSFER_OP, 32)
    .storeUint(intent.queryId, 64)
    .storeCoins(intent.netAmountAtomic)
    .storeAddress(destination)
    .storeAddress(responseDestination)
    .storeBit(0) // no custom payload
    .storeCoins(SPIKE_JETTON_FORWARD_TON)
    .storeBit(0) // no forward payload
    .endCell();
}

export async function buildCanonicalSigningMessageAsync(
  intent: CanonicalPayoutIntent,
): Promise<CanonicalMessageBuild> {
  if (intent.networkGlobalId === -239) {
    throw new SignerError('MAINNET_REJECTED', 'Cannot build MAINNET canonical message in Phase 9');
  }
  if (!intent.jettonMasterIdentity || intent.jettonMasterIdentity.trim() === '') {
    throw new SignerError('POLICY_REJECTED', 'Jetton master identity required');
  }

  const wallet = WalletContractV5R1.create({
    publicKey: intent.publicKey,
    workchain: intent.workchain,
    walletId: {
      networkGlobalId: intent.networkGlobalId,
    },
  });

  const jettonWallet = Address.parse(intent.payoutJettonWalletAddress);
  const body = buildJettonTransferBodyForIntent(intent);
  const outboundMessages: MessageRelaxed[] = [
    internal({
      to: jettonWallet,
      value: SPIKE_JETTON_ATTACHED_TON,
      bounce: true,
      body,
    }),
  ];

  let signingCell!: Cell;
  let signingHash!: Buffer;

  await wallet.createTransfer({
    seqno: intent.seqno,
    timeout: intent.validUntil,
    sendMode: SPIKE_SEND_MODE,
    messages: outboundMessages,
    authType: 'external',
    signer: async (messageCell: Cell) => {
      signingCell = messageCell;
      signingHash = Buffer.from(messageCell.hash());
      return Buffer.alloc(64, 0);
    },
  });

  return {
    signingCell,
    signingHash,
    canonicalMessageHashHex: signingHash.toString('hex'),
    outboundMessages,
    walletAddressRaw: wallet.address.toRawString(),
    jettonMasterIdentity: intent.jettonMasterIdentity,
  };
}
