import {
  Address,
  beginCell,
  Cell,
  external,
  loadMessage,
  storeMessage,
  type Message,
  type StateInit,
} from '@ton/core';

export interface BuildExternalInMessageInput {
  readonly walletAddress: Address | string;
  readonly signedWalletRequestBody: Cell;
  readonly stateInit?: StateInit | null;
}

/** A wallet needs StateInit only for its first (seqno zero) External-In message. */
export function walletStateInitForSeqno(
  seqno: number,
  walletStateInit: StateInit,
): StateInit | undefined {
  return seqno === 0 ? walletStateInit : undefined;
}

/** Build the final External-In message cell accepted by TON sendBoc. */
export function buildExternalInMessage(input: BuildExternalInMessageInput): Cell {
  const message = external({
    to: input.walletAddress,
    init: input.stateInit ?? undefined,
    body: input.signedWalletRequestBody,
  });
  return beginCell().store(storeMessage(message)).endCell();
}

/** Tonkeeper-compatible normalized External-In message hash. */
export function normalizeExternalInMessageHash(message: Message): Buffer {
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
    .hash();
}

export function parseExternalInMessageFromBoc(bocBase64: string): Message {
  const roots = Cell.fromBoc(Buffer.from(bocBase64, 'base64'));
  if (roots.length !== 1) {
    throw new Error(`Expected one External-In message BOC root, received ${roots.length}`);
  }
  const message = loadMessage(roots[0]!.beginParse());
  if (message.info.type !== 'external-in') {
    throw new Error(`Expected external-in message, received ${message.info.type}`);
  }
  return message;
}

export function assertExternalInMessageDestination(
  message: Message,
  expectedWalletAddress: Address | string,
): void {
  if (message.info.type !== 'external-in') {
    throw new Error(`Expected external-in message, received ${message.info.type}`);
  }
  const expected =
    typeof expectedWalletAddress === 'string'
      ? Address.parse(expectedWalletAddress)
      : expectedWalletAddress;
  if (!message.info.dest.equals(expected)) {
    throw new Error(
      `External-In destination mismatch: expected ${expected.toRawString()}, received ${message.info.dest.toRawString()}`,
    );
  }
}

export function assertExternalInMessageBody(message: Message, expectedBody: Cell): void {
  if (!message.body.hash().equals(expectedBody.hash())) {
    throw new Error('External-In body does not equal the signed wallet request body');
  }
}

export function assertExternalInMessageInitPresence(
  message: Message,
  expectedPresent: boolean,
): void {
  const present = message.init !== undefined && message.init !== null;
  if (present !== expectedPresent) {
    throw new Error(
      `External-In StateInit presence mismatch: expected ${expectedPresent ? 'present' : 'absent'}`,
    );
  }
}
