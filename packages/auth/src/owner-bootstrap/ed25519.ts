/**
 * Ed25519 helpers using Node crypto (raw 32-byte public / 64-byte secret seed+pk form
 * via PKCS8/SPKI conversion). Test-only and ceremony keys stay out of git.
 */
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function generateEd25519KeyPair(): {
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
} {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;
  return {
    publicKey: new Uint8Array(pubDer.subarray(pubDer.length - 32)),
    privateKey: new Uint8Array(privDer.subarray(privDer.length - 32)),
  };
}

function toPublicKeyObject(rawPublicKey: Uint8Array): KeyObject {
  if (rawPublicKey.byteLength !== 32) {
    throw new Error('Ed25519 public key must be 32 bytes');
  }
  const der = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(rawPublicKey)]);
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

function toPrivateKeyObject(rawPrivateSeed: Uint8Array): KeyObject {
  if (rawPrivateSeed.byteLength !== 32) {
    throw new Error('Ed25519 private seed must be 32 bytes');
  }
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(rawPrivateSeed)]);
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

export function publicKeyFromPrivateSeed(rawPrivateSeed: Uint8Array): Uint8Array {
  const priv = toPrivateKeyObject(rawPrivateSeed);
  const pub = createPublicKey(priv);
  const pubDer = pub.export({ type: 'spki', format: 'der' }) as Buffer;
  return new Uint8Array(pubDer.subarray(pubDer.length - 32));
}

export function ed25519Sign(rawPrivateSeed: Uint8Array, message: Uint8Array): Uint8Array {
  const key = toPrivateKeyObject(rawPrivateSeed);
  const sig = sign(null, Buffer.from(message), key);
  return new Uint8Array(sig);
}

export function ed25519Verify(
  rawPublicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  if (signature.byteLength !== 64) return false;
  try {
    const key = toPublicKeyObject(rawPublicKey);
    return verify(null, Buffer.from(message), key, Buffer.from(signature));
  } catch {
    return false;
  }
}

export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) {
    throw new Error('invalid hex');
  }
  return new Uint8Array(Buffer.from(hex.toLowerCase(), 'hex'));
}

export function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('invalid base64url');
  }
  return new Uint8Array(Buffer.from(value, 'base64url'));
}
