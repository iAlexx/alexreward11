import { Cell } from '@ton/core';

export const JETTON_TRANSFER_OP = 0x0f8a7ea5;
export const JETTON_INTERNAL_TRANSFER_OP = 0x178d4519;
export const JETTON_TRANSFER_NOTIFICATION_OP = 0x7362d09c;

export interface ParsedJettonMessage {
  readonly op: number;
  readonly queryId: string;
  readonly amountAtomic: string;
  readonly address?: string;
}

function parseCell(cell: Cell): ParsedJettonMessage | null {
  try {
    const slice = cell.beginParse();
    const op = slice.loadUint(32);
    if (
      op !== JETTON_TRANSFER_OP &&
      op !== JETTON_INTERNAL_TRANSFER_OP &&
      op !== JETTON_TRANSFER_NOTIFICATION_OP
    ) {
      return null;
    }
    const queryId = slice.loadUintBig(64).toString(10);
    const amountAtomic = slice.loadCoins().toString(10);
    if (op === JETTON_TRANSFER_NOTIFICATION_OP) {
      const sender = slice.loadAddress();
      return {
        op,
        queryId,
        amountAtomic,
        ...(sender === null ? {} : { address: sender.toString() }),
      };
    }
    const address = slice.loadAddress();
    if (address === null) return null;
    return { op, queryId, amountAtomic, address: address.toString() };
  } catch {
    return null;
  }
}

export function parseJettonMessageBase64(body: string): ParsedJettonMessage | null {
  try {
    return parseCell(Cell.fromBase64(body));
  } catch {
    return null;
  }
}

export function parseJettonMessageHex(body: string): ParsedJettonMessage | null {
  try {
    const bytes = Buffer.from(body, 'hex');
    if (bytes.length === 0 || bytes.toString('hex').toLowerCase() !== body.toLowerCase())
      return null;
    const roots = Cell.fromBoc(bytes);
    if (roots.length !== 1) return null;
    return parseCell(roots[0]!);
  } catch {
    return null;
  }
}
