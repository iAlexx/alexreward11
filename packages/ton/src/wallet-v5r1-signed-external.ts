/**
 * Wallet V5R1 signed-external request decode/validate (Phase 10 reconcile-only).
 *
 * Layout (createWalletTransferV5R1 / packSignatureToTail):
 *   auth_signed_external(0x7369676e)
 *   | walletId(32)
 *   | valid_until/timeout(32)
 *   | seqno(32)
 *   | actions
 *   | signature(512-bit tail)
 *
 * Does not sign or broadcast. Decode only from persisted BOC bytes.
 */
import {
  Address,
  beginCell,
  Cell,
  external,
  internal,
  loadMessage,
  SendMode,
  storeMessage,
  type Message,
} from '@ton/core';
import { WalletContractV5R1 } from '@ton/ton';

import { TON_TESTNET_NETWORK_GLOBAL_ID } from './chain-provider.js';

/** Official Wallet V5R1 external signed-auth opcode ("sign"). */
export const WALLET_V5R1_AUTH_SIGNED_EXTERNAL_OPCODE = 0x7369676e;

export interface DecodedWalletV5R1SignedExternal {
  readonly opcode: number;
  readonly walletIdSerialized: number;
  readonly networkGlobalId: number;
  readonly workchain: number;
  readonly subwalletNumber: number;
  readonly walletVersion: 'v5r1';
  readonly validUntil: number;
  readonly seqno: number;
  /** Hash of the signing message (pre-signature) — equals attempt canonical_message_hash. */
  readonly signingMessageHashHex: string;
  /** Hash of the full signed wallet-request body cell. */
  readonly signedRequestCellHashHex: string;
}

export type WalletV5R1SignedExternalDecodeFailure =
  | 'BOC_INVALID'
  | 'UNSUPPORTED_OPCODE'
  | 'UNSUPPORTED_WALLET_ID'
  | 'NETWORK_NOT_TESTNET'
  | 'SUBWALLET_UNSUPPORTED';

export type DecodeWalletV5R1SignedExternalResult =
  | { readonly ok: true; readonly decoded: DecodedWalletV5R1SignedExternal }
  | {
      readonly ok: false;
      readonly code: WalletV5R1SignedExternalDecodeFailure;
      readonly message: string;
    };

/**
 * Deserialize Wallet V5R1 walletId using the same XOR scheme as @ton/ton
 * loadWalletIdV5R1 (networkGlobalId ^ context).
 */
function loadWalletIdV5R1Client(
  walletIdSerialized: number,
  networkGlobalId: number,
):
  | {
      readonly networkGlobalId: number;
      readonly workchain: number;
      readonly subwalletNumber: number;
      readonly walletVersion: 'v5r1';
    }
  | null {
  const context = BigInt(walletIdSerialized) ^ BigInt(networkGlobalId);
  const bitReader = beginCell().storeInt(context, 32).endCell().beginParse();
  const isClientContext = bitReader.loadUint(1);
  if (isClientContext !== 1) {
    return null;
  }
  const workchain = bitReader.loadInt(8);
  const walletVersionRaw = bitReader.loadUint(8);
  const subwalletNumber = bitReader.loadUint(15);
  if (walletVersionRaw !== 0) {
    return null;
  }
  return {
    networkGlobalId,
    workchain,
    subwalletNumber,
    walletVersion: 'v5r1',
  };
}

/**
 * Decode a persisted Wallet V5R1 auth_signed_external request body BOC.
 * networkGlobalId must be Testnet (-3) — Mainnet is rejected.
 */
export function decodeWalletV5R1SignedExternal(
  bocBase64: string,
  networkGlobalId: number = TON_TESTNET_NETWORK_GLOBAL_ID,
): DecodeWalletV5R1SignedExternalResult {
  if (networkGlobalId !== TON_TESTNET_NETWORK_GLOBAL_ID) {
    return {
      ok: false,
      code: 'NETWORK_NOT_TESTNET',
      message: 'Wallet V5R1 reconcile decode requires Testnet networkGlobalId=-3',
    };
  }
  let cell: Cell;
  try {
    const roots = Cell.fromBoc(Buffer.from(bocBase64, 'base64'));
    if (roots.length !== 1 || roots[0] === undefined) {
      return { ok: false, code: 'BOC_INVALID', message: 'Expected exactly one BOC root' };
    }
    cell = roots[0];
  } catch (error) {
    return {
      ok: false,
      code: 'BOC_INVALID',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const bits = cell.bits;
  if (bits.length < 512) {
    return { ok: false, code: 'BOC_INVALID', message: 'Cell too short for 512-bit signature tail' };
  }

  try {
    const slice = cell.beginParse();
    const opcode = slice.loadUint(32);
    if (opcode !== WALLET_V5R1_AUTH_SIGNED_EXTERNAL_OPCODE) {
      return {
        ok: false,
        code: 'UNSUPPORTED_OPCODE',
        message: `Expected auth_signed_external 0x7369676e, got 0x${opcode.toString(16)}`,
      };
    }
    const walletIdSerialized = slice.loadInt(32);
    const validUntil = slice.loadUint(32);
    const seqno = slice.loadUint(32);

    const walletId = loadWalletIdV5R1Client(walletIdSerialized, networkGlobalId);
    if (walletId === null) {
      return {
        ok: false,
        code: 'UNSUPPORTED_WALLET_ID',
        message: 'walletId is not a supported V5R1 client context (subwallet/version)',
      };
    }
    if (walletId.subwalletNumber !== 0) {
      return {
        ok: false,
        code: 'SUBWALLET_UNSUPPORTED',
        message: `Only subwalletNumber=0 is supported (got ${walletId.subwalletNumber})`,
      };
    }

    const signingBits = bits.substring(0, bits.length - 512);
    let builder = beginCell().storeBits(signingBits);
    for (const ref of cell.refs) {
      builder = builder.storeRef(ref);
    }
    const signingCell = builder.endCell();

    return {
      ok: true,
      decoded: {
        opcode,
        walletIdSerialized,
        networkGlobalId: walletId.networkGlobalId,
        workchain: walletId.workchain,
        subwalletNumber: walletId.subwalletNumber,
        walletVersion: 'v5r1',
        validUntil,
        seqno,
        signingMessageHashHex: signingCell.hash().toString('hex'),
        signedRequestCellHashHex: cell.hash().toString('hex'),
      },
    };
  } catch (error) {
    return {
      ok: false,
      code: 'BOC_INVALID',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Tonkeeper-compatible normalized External-In message hash. */
export function normalizeExternalInMessageHashHex(message: Message): string {
  if (message.info.type !== 'external-in') {
    throw new Error(`Expected external-in message, received ${message.info.type}`);
  }
  return beginCell()
    .storeUint(2, 2)
    .storeUint(0, 2)
    .storeAddress(message.info.dest)
    .storeUint(0, 4)
    .storeBit(false)
    .storeBit(true)
    .storeRef(message.body)
    .endCell()
    .hash()
    .toString('hex');
}

export function parseExternalInMessageFromBoc(bocBase64: string): Message {
  const roots = Cell.fromBoc(Buffer.from(bocBase64, 'base64'));
  if (roots.length !== 1 || roots[0] === undefined) {
    throw new Error(`Expected one External-In message BOC root, received ${roots.length}`);
  }
  const message = loadMessage(roots[0].beginParse());
  if (message.info.type !== 'external-in') {
    throw new Error(`Expected external-in message, received ${message.info.type}`);
  }
  return message;
}

export interface WalletV5R1AttemptIdentityInput {
  readonly signedWalletRequestBoc: string;
  readonly expectedSeqno: number;
  readonly canonicalMessageHash: string;
  readonly validUntilUnix: number;
  readonly hotWalletAddress: string;
  readonly networkGlobalId?: number;
  readonly signedExternalMessageBoc?: string | null;
  readonly normalizedExternalMessageHash?: string | null;
  readonly externalMessageCellHash?: string | null;
}

export type WalletV5R1AttemptIdentityFailure =
  | WalletV5R1SignedExternalDecodeFailure
  | 'SEQNO_MISMATCH'
  | 'CANONICAL_HASH_MISMATCH'
  | 'VALID_UNTIL_MISMATCH'
  | 'EXTERNAL_BODY_MISMATCH'
  | 'NORMALIZED_HASH_MISMATCH'
  | 'CELL_HASH_MISMATCH'
  | 'HOT_WALLET_MISMATCH';

export type ValidateWalletV5R1AttemptIdentityResult =
  | { readonly ok: true; readonly decoded: DecodedWalletV5R1SignedExternal }
  | {
      readonly ok: false;
      readonly code: WalletV5R1AttemptIdentityFailure;
      readonly message: string;
    };

/**
 * Validate persisted signed V5R1 request identity against attempt metadata.
 * Fail closed on any mismatch — never derive financial proof from an unverified BOC.
 */
export function validateWalletV5R1SignedExternalAgainstAttempt(
  input: WalletV5R1AttemptIdentityInput,
): ValidateWalletV5R1AttemptIdentityResult {
  const networkGlobalId = input.networkGlobalId ?? TON_TESTNET_NETWORK_GLOBAL_ID;
  const decodedResult = decodeWalletV5R1SignedExternal(
    input.signedWalletRequestBoc,
    networkGlobalId,
  );
  if (!decodedResult.ok) {
    return decodedResult;
  }
  const { decoded } = decodedResult;

  if (decoded.seqno !== input.expectedSeqno) {
    return {
      ok: false,
      code: 'SEQNO_MISMATCH',
      message: `Decoded seqno ${decoded.seqno} != expected ${input.expectedSeqno}`,
    };
  }
  if (decoded.signingMessageHashHex.toLowerCase() !== input.canonicalMessageHash.toLowerCase()) {
    return {
      ok: false,
      code: 'CANONICAL_HASH_MISMATCH',
      message: 'Decoded signing hash does not match attempt canonical_message_hash',
    };
  }
  if (decoded.validUntil !== input.validUntilUnix) {
    return {
      ok: false,
      code: 'VALID_UNTIL_MISMATCH',
      message: `Decoded valid_until ${decoded.validUntil} != attempt ${input.validUntilUnix}`,
    };
  }

  const externalBoc = input.signedExternalMessageBoc;
  if (externalBoc !== undefined && externalBoc !== null && externalBoc.trim() !== '') {
    try {
      const message = parseExternalInMessageFromBoc(externalBoc);
      if (message.info.type !== 'external-in') {
        return {
          ok: false,
          code: 'HOT_WALLET_MISMATCH',
          message: 'External message is not external-in',
        };
      }
      if (!message.info.dest.equals(Address.parse(input.hotWalletAddress))) {
        return {
          ok: false,
          code: 'HOT_WALLET_MISMATCH',
          message: 'External-In destination is not the Hot Wallet',
        };
      }
      if (message.body.hash().toString('hex') !== decoded.signedRequestCellHashHex) {
        return {
          ok: false,
          code: 'EXTERNAL_BODY_MISMATCH',
          message: 'External-In body hash does not equal signed wallet-request cell hash',
        };
      }
      const roots = Cell.fromBoc(Buffer.from(externalBoc, 'base64'));
      const cellHash = roots[0]!.hash().toString('hex');
      const normalized = normalizeExternalInMessageHashHex(message);
      if (
        input.normalizedExternalMessageHash !== undefined &&
        input.normalizedExternalMessageHash !== null &&
        input.normalizedExternalMessageHash.trim() !== '' &&
        normalized.toLowerCase() !== input.normalizedExternalMessageHash.toLowerCase()
      ) {
        return {
          ok: false,
          code: 'NORMALIZED_HASH_MISMATCH',
          message: 'Recomputed normalized External-In hash does not match attempt',
        };
      }
      if (
        input.externalMessageCellHash !== undefined &&
        input.externalMessageCellHash !== null &&
        input.externalMessageCellHash.trim() !== '' &&
        cellHash.toLowerCase() !== input.externalMessageCellHash.toLowerCase()
      ) {
        return {
          ok: false,
          code: 'CELL_HASH_MISMATCH',
          message: 'Recomputed External-In cell hash does not match attempt',
        };
      }
    } catch (error) {
      return {
        ok: false,
        code: 'BOC_INVALID',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return { ok: true, decoded };
}

/**
 * Test/harness helper: build a Wallet V5R1 signed-external request BOC with a
 * deterministic dummy signature (64 zero bytes). Signing hash is still authentic.
 * NOT for production signing.
 */
export async function buildTestWalletV5R1SignedExternalBoc(input: {
  readonly publicKeyHex: string;
  readonly networkGlobalId?: number;
  readonly workchain?: number;
  readonly seqno: number;
  readonly validUntil: number;
  readonly toAddress: string;
  readonly valueNanotons?: bigint;
}): Promise<{
  readonly signedWalletRequestBocBase64: string;
  readonly signingMessageHashHex: string;
  readonly signedRequestCellHashHex: string;
}> {
  const networkGlobalId = input.networkGlobalId ?? TON_TESTNET_NETWORK_GLOBAL_ID;
  const workchain = input.workchain ?? 0;
  const publicKey = Buffer.from(input.publicKeyHex, 'hex');
  if (publicKey.length !== 32) {
    throw new Error('publicKeyHex must be 32 bytes');
  }
  const wallet = WalletContractV5R1.create({
    publicKey,
    workchain,
    walletId: { networkGlobalId },
  });

  let signingHashHex = '';
  // Test harness only: construct V5R1 signed-external body via @ton/ton WalletContractV5R1.
  // Overload typing is brittle across package versions; runtime layout is authoritative.
  const signedBody = (await (wallet.createTransfer as (args: {
    seqno: number;
    timeout: number;
    sendMode: number;
    messages: ReturnType<typeof internal>[];
    authType: 'external';
    signer: (messageCell: Cell) => Promise<Buffer>;
  }) => Promise<Cell>)({
    seqno: input.seqno,
    timeout: input.validUntil,
    sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
    messages: [
      internal({
        to: Address.parse(input.toAddress),
        value: input.valueNanotons ?? 50_000_000n,
        bounce: true,
        body: beginCell().endCell(),
      }),
    ],
    authType: 'external',
    signer: async (messageCell: Cell) => {
      signingHashHex = messageCell.hash().toString('hex');
      return Buffer.alloc(64, 0);
    },
  })) as Cell;

  return {
    signedWalletRequestBocBase64: signedBody.toBoc().toString('base64'),
    signingMessageHashHex: signingHashHex,
    signedRequestCellHashHex: signedBody.hash().toString('hex'),
  };
}

/**
 * Build a minimal External-In wrapper around a signed wallet-request body
 * (no StateInit). Used by reconcile-only tests.
 */
export function buildTestExternalInBoc(input: {
  readonly walletAddress: string;
  readonly signedWalletRequestBocBase64: string;
}): {
  readonly externalMessageBocBase64: string;
  readonly externalMessageCellHashHex: string;
  readonly normalizedExternalMessageHashHex: string;
} {
  const bodyRoots = Cell.fromBoc(Buffer.from(input.signedWalletRequestBocBase64, 'base64'));
  const body = bodyRoots[0]!;
  const message = external({
    to: Address.parse(input.walletAddress),
    body,
  });
  const cell = beginCell().store(storeMessage(message)).endCell();
  const parsed = loadMessage(cell.beginParse());
  return {
    externalMessageBocBase64: cell.toBoc().toString('base64'),
    externalMessageCellHashHex: cell.hash().toString('hex'),
    normalizedExternalMessageHashHex: normalizeExternalInMessageHashHex(parsed),
  };
}
