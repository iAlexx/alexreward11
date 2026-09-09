import { beginCell, storeStateInit, Address } from '@ton/core';
import { keyPairFromSeed } from '@ton/crypto';
import { WalletContractV4 } from '@ton/ton';
import { describe, expect, it } from 'vitest';

import {
  buildTonProofSigningDigest,
  canonicalizeTonAddress,
  extractPublicKeyFromStateInit,
  parseStateInitFromBase64,
  verifyTonProof,
  TonDomainError,
} from '../src/index.js';
import { createWalletV4Fixture, signTonProof } from './fixtures.js';

const DOMAIN = 'alex-rewards.local.test';

describe('ton_proof cryptographic verification', () => {
  it('accepts a valid real Ed25519 ton_proof', () => {
    const fixture = createWalletV4Fixture();
    const payload = 'challenge-valid-001';
    const timestamp = Math.floor(Date.now() / 1000);
    const proof = signTonProof({ fixture, domain: DOMAIN, payload, timestamp });
    const result = verifyTonProof({
      account: {
        address: fixture.address,
        network: '-3',
        publicKey: fixture.publicKey.toString('hex'),
        walletStateInit: fixture.stateInitBase64,
      },
      proof,
      expectedDomain: DOMAIN,
      expectedPayload: payload,
      expectedNetwork: '-3',
      maxAgeSeconds: 900,
      maxFutureSkewSeconds: 60,
    });
    expect(result.canonical.rawAddress).toBe(fixture.rawAddress);
    expect(result.publicKeyHex).toBe(fixture.publicKey.toString('hex'));
  });

  it('rejects an invalid signature', () => {
    const fixture = createWalletV4Fixture();
    const payload = 'challenge-bad-sig';
    const timestamp = Math.floor(Date.now() / 1000);
    const proof = signTonProof({ fixture, domain: DOMAIN, payload, timestamp });
    proof.signature = Buffer.alloc(64, 7).toString('base64');
    expect(() =>
      verifyTonProof({
        account: {
          address: fixture.address,
          network: '-3',
          walletStateInit: fixture.stateInitBase64,
        },
        proof,
        expectedDomain: DOMAIN,
        expectedPayload: payload,
        expectedNetwork: '-3',
        maxAgeSeconds: 900,
        maxFutureSkewSeconds: 60,
      }),
    ).toThrow(TonDomainError);
  });

  it('rejects altered payload', () => {
    const fixture = createWalletV4Fixture();
    const payload = 'challenge-original';
    const timestamp = Math.floor(Date.now() / 1000);
    const proof = signTonProof({ fixture, domain: DOMAIN, payload, timestamp });
    expect(() =>
      verifyTonProof({
        account: {
          address: fixture.address,
          network: '-3',
          walletStateInit: fixture.stateInitBase64,
        },
        proof,
        expectedDomain: DOMAIN,
        expectedPayload: 'challenge-altered',
        expectedNetwork: '-3',
        maxAgeSeconds: 900,
        maxFutureSkewSeconds: 60,
      }),
    ).toThrow(/payload/i);
  });

  it('rejects wrong domain', () => {
    const fixture = createWalletV4Fixture();
    const payload = 'challenge-domain';
    const timestamp = Math.floor(Date.now() / 1000);
    const proof = signTonProof({ fixture, domain: 'evil.example', payload, timestamp });
    expect(() =>
      verifyTonProof({
        account: {
          address: fixture.address,
          network: '-3',
          walletStateInit: fixture.stateInitBase64,
        },
        proof,
        expectedDomain: DOMAIN,
        expectedPayload: payload,
        expectedNetwork: '-3',
        maxAgeSeconds: 900,
        maxFutureSkewSeconds: 60,
      }),
    ).toThrow(TonDomainError);
  });

  it('rejects incorrect domain-length semantics', () => {
    const fixture = createWalletV4Fixture();
    const payload = 'challenge-domain-len';
    const timestamp = Math.floor(Date.now() / 1000);
    const proof = signTonProof({ fixture, domain: DOMAIN, payload, timestamp });
    proof.domain.lengthBytes = Buffer.byteLength(DOMAIN, 'utf8') + 1;
    expect(() =>
      verifyTonProof({
        account: {
          address: fixture.address,
          network: '-3',
          walletStateInit: fixture.stateInitBase64,
        },
        proof,
        expectedDomain: DOMAIN,
        expectedPayload: payload,
        expectedNetwork: '-3',
        maxAgeSeconds: 900,
        maxFutureSkewSeconds: 60,
      }),
    ).toThrow(TonDomainError);
  });

  it('rejects stale proof timestamp', () => {
    const fixture = createWalletV4Fixture();
    const payload = 'challenge-stale';
    const now = Math.floor(Date.now() / 1000);
    const proof = signTonProof({ fixture, domain: DOMAIN, payload, timestamp: now - 10_000 });
    expect(() =>
      verifyTonProof({
        account: {
          address: fixture.address,
          network: '-3',
          walletStateInit: fixture.stateInitBase64,
        },
        proof,
        expectedDomain: DOMAIN,
        expectedPayload: payload,
        expectedNetwork: '-3',
        nowUnixSeconds: now,
        maxAgeSeconds: 900,
        maxFutureSkewSeconds: 60,
      }),
    ).toThrow(TonDomainError);
  });

  it('rejects excessive future timestamp', () => {
    const fixture = createWalletV4Fixture();
    const payload = 'challenge-future';
    const now = Math.floor(Date.now() / 1000);
    const proof = signTonProof({ fixture, domain: DOMAIN, payload, timestamp: now + 3600 });
    expect(() =>
      verifyTonProof({
        account: {
          address: fixture.address,
          network: '-3',
          walletStateInit: fixture.stateInitBase64,
        },
        proof,
        expectedDomain: DOMAIN,
        expectedPayload: payload,
        expectedNetwork: '-3',
        nowUnixSeconds: now,
        maxAgeSeconds: 900,
        maxFutureSkewSeconds: 60,
      }),
    ).toThrow(TonDomainError);
  });

  it('rejects malformed proof', () => {
    const fixture = createWalletV4Fixture();
    expect(() =>
      verifyTonProof({
        account: {
          address: fixture.address,
          network: '-3',
          walletStateInit: fixture.stateInitBase64,
        },
        proof: {
          timestamp: 1,
          domain: { lengthBytes: 1, value: 'x' },
          payload: 'p',
          signature: 'not-base64-!!!!',
        },
        expectedDomain: 'x',
        expectedPayload: 'p',
        expectedNetwork: '-3',
        maxAgeSeconds: 900,
        maxFutureSkewSeconds: 60,
      }),
    ).toThrow(TonDomainError);
  });

  it('rejects invalid claimed public key', () => {
    const fixture = createWalletV4Fixture();
    const payload = 'challenge-pubkey';
    const timestamp = Math.floor(Date.now() / 1000);
    const proof = signTonProof({ fixture, domain: DOMAIN, payload, timestamp });
    expect(() =>
      verifyTonProof({
        account: {
          address: fixture.address,
          network: '-3',
          publicKey: Buffer.alloc(32, 9).toString('hex'),
          walletStateInit: fixture.stateInitBase64,
        },
        proof,
        expectedDomain: DOMAIN,
        expectedPayload: payload,
        expectedNetwork: '-3',
        maxAgeSeconds: 900,
        maxFutureSkewSeconds: 60,
      }),
    ).toThrow(TonDomainError);
  });

  it('rejects state-init / account address mismatch', () => {
    const fixture = createWalletV4Fixture();
    const other = createWalletV4Fixture();
    const payload = 'challenge-state-mismatch';
    const timestamp = Math.floor(Date.now() / 1000);
    const proof = signTonProof({ fixture, domain: DOMAIN, payload, timestamp });
    expect(() =>
      verifyTonProof({
        account: {
          address: other.address,
          network: '-3',
          walletStateInit: fixture.stateInitBase64,
        },
        proof,
        expectedDomain: DOMAIN,
        expectedPayload: payload,
        expectedNetwork: '-3',
        maxAgeSeconds: 900,
        maxFutureSkewSeconds: 60,
      }),
    ).toThrow(TonDomainError);
  });

  it('rejects Mainnet/Testnet network mismatch', () => {
    const fixture = createWalletV4Fixture();
    const payload = 'challenge-net';
    const timestamp = Math.floor(Date.now() / 1000);
    const proof = signTonProof({ fixture, domain: DOMAIN, payload, timestamp });
    expect(() =>
      verifyTonProof({
        account: {
          address: fixture.address,
          network: '-239',
          walletStateInit: fixture.stateInitBase64,
        },
        proof,
        expectedDomain: DOMAIN,
        expectedPayload: payload,
        expectedNetwork: '-3',
        maxAgeSeconds: 900,
        maxFutureSkewSeconds: 60,
      }),
    ).toThrow(TonDomainError);
  });

  it('fails closed on unsupported wallet state', () => {
    const fixture = createWalletV4Fixture();
    const empty = beginCell().endCell();
    const bogus = beginCell()
      .storeBit(0)
      .storeBit(0)
      .storeBit(1)
      .storeRef(empty)
      .storeBit(1)
      .storeRef(empty)
      .storeBit(0)
      .endCell()
      .toBoc()
      .toString('base64');
    expect(() => extractPublicKeyFromStateInit(parseStateInitFromBase64(bogus))).toThrow(
      TonDomainError,
    );
    expect(fixture.publicKey.length).toBe(32);
  });

  it('canonicalizes bounceable/non-bounceable/url-safe variants to one account', () => {
    const fixture = createWalletV4Fixture();
    const address = Address.parse(fixture.friendlyAddress);
    const bounceable = address.toString({ urlSafe: true, bounceable: true });
    const nonBounceable = address.toString({ urlSafe: true, bounceable: false });
    const classic = address.toString({ urlSafe: false, bounceable: true });
    const a = canonicalizeTonAddress(bounceable);
    const b = canonicalizeTonAddress(nonBounceable);
    const c = canonicalizeTonAddress(classic);
    const d = canonicalizeTonAddress(fixture.rawAddress);
    expect(a.rawAddress).toBe(b.rawAddress);
    expect(b.rawAddress).toBe(c.rawAddress);
    expect(c.rawAddress).toBe(d.rawAddress);
  });

  it('buildTonProofSigningDigest is deterministic for fixed vectors', () => {
    const addressHash = Buffer.alloc(32, 0x11);
    const d1 = buildTonProofSigningDigest({
      workchain: 0,
      addressHash,
      domainValue: 'example.com',
      domainLengthBytes: 11,
      timestamp: 1_700_000_000,
      payload: 'abc',
    });
    const d2 = buildTonProofSigningDigest({
      workchain: 0,
      addressHash,
      domainValue: 'example.com',
      domainLengthBytes: 11,
      timestamp: 1_700_000_000,
      payload: 'abc',
    });
    expect(d1.equals(d2)).toBe(true);
    expect(d1.length).toBe(32);
  });

  it('WalletContractV4 stateInit public key extraction matches keypair', () => {
    const seed = Buffer.alloc(32, 0x42);
    const keyPair = keyPairFromSeed(seed);
    const wallet = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey });
    const boc = beginCell().store(storeStateInit(wallet.init)).endCell().toBoc().toString('base64');
    const pub = extractPublicKeyFromStateInit(parseStateInitFromBase64(boc));
    expect(pub.equals(keyPair.publicKey)).toBe(true);
  });
});
