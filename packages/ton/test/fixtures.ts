/**
 * Deterministic ton_proof fixture helpers — real Ed25519, no crypto mocks.
 */
import { createHash, randomBytes } from 'node:crypto';

import { beginCell, storeStateInit } from '@ton/core';
import { keyPairFromSeed, sign } from '@ton/crypto';
import { WalletContractV4 } from '@ton/ton';

import { buildTonProofSigningDigest } from '../src/proof-message.js';

export interface ProofFixture {
  readonly seed: Buffer;
  readonly publicKey: Buffer;
  readonly secretKey: Buffer;
  readonly address: string;
  readonly rawAddress: string;
  readonly friendlyAddress: string;
  readonly stateInitBase64: string;
  readonly network: '-3';
}

export function createWalletV4Fixture(seed?: Buffer): ProofFixture {
  const seedBytes = seed ?? randomBytes(32);
  const keyPair = keyPairFromSeed(seedBytes);
  const wallet = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey });
  const stateInitCell = beginCell().store(storeStateInit(wallet.init)).endCell();
  return {
    seed: seedBytes,
    publicKey: keyPair.publicKey,
    secretKey: keyPair.secretKey,
    address: `${wallet.address.workChain}:${wallet.address.hash.toString('hex')}`,
    rawAddress: wallet.address.toRawString(),
    friendlyAddress: wallet.address.toString({ urlSafe: true, bounceable: true }),
    stateInitBase64: stateInitCell.toBoc().toString('base64'),
    network: '-3',
  };
}

export function signTonProof(input: {
  readonly fixture: ProofFixture;
  readonly domain: string;
  readonly payload: string;
  readonly timestamp: number;
  readonly domainLengthBytes?: number;
}): {
  timestamp: number;
  domain: { lengthBytes: number; value: string };
  payload: string;
  signature: string;
  state_init: string;
} {
  const domainLengthBytes = input.domainLengthBytes ?? Buffer.byteLength(input.domain, 'utf8');
  const digest = buildTonProofSigningDigest({
    workchain: 0,
    addressHash: Buffer.from(input.fixture.address.split(':')[1] ?? '', 'hex'),
    domainValue: input.domain,
    domainLengthBytes,
    timestamp: input.timestamp,
    payload: input.payload,
  });
  const signature = sign(digest, input.fixture.secretKey);
  return {
    timestamp: input.timestamp,
    domain: { lengthBytes: domainLengthBytes, value: input.domain },
    payload: input.payload,
    signature: signature.toString('base64'),
    state_init: input.fixture.stateInitBase64,
  };
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
