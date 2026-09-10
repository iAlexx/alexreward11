import { Address, beginCell, Cell, loadMessage, type Message, type StateInit } from '@ton/core';
import { describe, expect, it } from 'vitest';

import {
  assertExternalInMessageBody,
  assertExternalInMessageDestination,
  assertExternalInMessageInitPresence,
  buildExternalInMessage,
  normalizeExternalInMessageHash,
  parseExternalInMessageFromBoc,
  walletStateInitForSeqno,
} from '../src/index.js';

const walletAddress = Address.parse(
  '0:1111111111111111111111111111111111111111111111111111111111111111',
);
const signedWalletRequestBody = beginCell()
  .storeUint(0x7369676e, 32)
  .storeBuffer(Buffer.alloc(64, 7))
  .endCell();
const stateInit: StateInit = {
  code: beginCell().storeUint(1, 1).endCell(),
  data: beginCell().storeUint(2, 2).endCell(),
};

function parseDirect(cell: Cell): Message {
  const roots = Cell.fromBoc(cell.toBoc());
  return loadMessage(roots[0]!.beginParse());
}

describe('Phase 10 External-In message construction', () => {
  it('builds a parseable External-In with StateInit for seqno zero', () => {
    const firstUseStateInit = walletStateInitForSeqno(0, stateInit);
    expect(firstUseStateInit).toBe(stateInit);
    const cell = buildExternalInMessage({
      walletAddress,
      signedWalletRequestBody,
      stateInit: firstUseStateInit!,
    });
    const message = parseDirect(cell);

    expect(message.info.type).toBe('external-in');
    assertExternalInMessageDestination(message, walletAddress);
    assertExternalInMessageBody(message, signedWalletRequestBody);
    assertExternalInMessageInitPresence(message, true);
  });

  it('omits StateInit after the wallet has a positive seqno', () => {
    const deployedStateInit = walletStateInitForSeqno(1, stateInit);
    expect(deployedStateInit).toBeUndefined();
    const cell = buildExternalInMessage({
      walletAddress,
      signedWalletRequestBody,
      ...(deployedStateInit === undefined ? {} : { stateInit: deployedStateInit }),
    });
    const message = parseExternalInMessageFromBoc(cell.toBoc().toString('base64'));

    expect(message.info.type).toBe('external-in');
    assertExternalInMessageDestination(message, walletAddress);
    assertExternalInMessageBody(message, signedWalletRequestBody);
    assertExternalInMessageInitPresence(message, false);
  });

  it('changes normalized identity when the signed body is tampered', () => {
    const original = parseDirect(
      buildExternalInMessage({ walletAddress, signedWalletRequestBody }),
    );
    const tamperedBody = beginCell()
      .storeUint(0x7369676e, 32)
      .storeBuffer(Buffer.alloc(64, 8))
      .endCell();
    const tampered = parseDirect(
      buildExternalInMessage({ walletAddress, signedWalletRequestBody: tamperedBody }),
    );

    expect(
      normalizeExternalInMessageHash(tampered).equals(normalizeExternalInMessageHash(original)),
    ).toBe(false);
  });

  it('normalizes equivalent messages identically regardless of StateInit representation', () => {
    const withInit = parseDirect(
      buildExternalInMessage({ walletAddress, signedWalletRequestBody, stateInit }),
    );
    const withoutInit = parseDirect(
      buildExternalInMessage({ walletAddress, signedWalletRequestBody }),
    );

    expect(
      normalizeExternalInMessageHash(withInit).equals(normalizeExternalInMessageHash(withoutInit)),
    ).toBe(true);
  });
});
