import { createHash } from 'node:crypto';

import { TonDomainError } from './errors.js';

export const TON_PROOF_ITEM_PREFIX = 'ton-proof-item-v2/';
export const TON_CONNECT_PREFIX = 'ton-connect';

export interface TonProofMessageParts {
  readonly workchain: number;
  readonly addressHash: Buffer;
  readonly domainValue: string;
  readonly domainLengthBytes: number;
  readonly timestamp: number;
  readonly payload: string;
}

/**
 * Official TON Connect ton_proof message construction.
 * Spec: ton-proof-item-v2/ ++ Address ++ AppDomain ++ Timestamp ++ Payload
 */
export function buildTonProofMessage(parts: TonProofMessageParts): Buffer {
  if (parts.addressHash.length !== 32) {
    throw new TonDomainError('INVALID_PROOF', 'Proof address hash is invalid');
  }
  const domainBytes = Buffer.from(parts.domainValue, 'utf8');
  if (domainBytes.length !== parts.domainLengthBytes) {
    throw new TonDomainError('INVALID_DOMAIN', 'Proof domain length does not match domain value', {
      details: {
        lengthBytes: parts.domainLengthBytes,
        actualBytes: domainBytes.length,
      },
    });
  }
  if (!Number.isInteger(parts.timestamp) || parts.timestamp < 0) {
    throw new TonDomainError('INVALID_PROOF', 'Proof timestamp is invalid');
  }

  const workchainBuf = Buffer.alloc(4);
  workchainBuf.writeInt32BE(parts.workchain, 0);

  const domainLenBuf = Buffer.alloc(4);
  domainLenBuf.writeUInt32LE(parts.domainLengthBytes, 0);

  const timestampBuf = Buffer.alloc(8);
  timestampBuf.writeBigUInt64LE(BigInt(parts.timestamp), 0);

  return Buffer.concat([
    Buffer.from(TON_PROOF_ITEM_PREFIX, 'utf8'),
    workchainBuf,
    parts.addressHash,
    domainLenBuf,
    domainBytes,
    timestampBuf,
    Buffer.from(parts.payload, 'utf8'),
  ]);
}

/**
 * Digest signed by Ed25519:
 * sha256(0xffff ++ utf8("ton-connect") ++ sha256(message))
 */
export function buildTonProofSigningDigest(parts: TonProofMessageParts): Buffer {
  const message = buildTonProofMessage(parts);
  const messageHash = createHash('sha256').update(message).digest();
  return createHash('sha256')
    .update(
      Buffer.concat([
        Buffer.from([0xff, 0xff]),
        Buffer.from(TON_CONNECT_PREFIX, 'utf8'),
        messageHash,
      ]),
    )
    .digest();
}
