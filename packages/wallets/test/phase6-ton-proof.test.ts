/**
 * Phase 6 ton_proof challenge + verify matrix against real PostgreSQL.
 *
 * Destructive against PHASE6_DATABASE_URL (or PHASE6_WALLET_TESTS=1 + DATABASE_URL).
 */
import { beginCell } from '@ton/core';
import { sign } from '@ton/crypto';
import { buildTonProofSigningDigest } from '@alex-rewards/ton';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createTonProofChallenge,
  localWalletOwnershipFixtureConfig,
  verifyTonProofAndBindWallet,
  WalletDomainError,
} from '../src/index.js';
import {
  createTestUser,
  createWalletFixture,
  phase6DatabaseUrl,
  resetAndMigrate,
  signProof,
  walletConfig,
} from './harness.js';

async function truncateWalletTables(pool: Pool): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      outbox_events,
      audit_logs,
      user_wallet_proof_nonces,
      user_wallets,
      user_memberships,
      users
    RESTART IDENTITY CASCADE
  `);
  await pool.query(`UPDATE networks SET status = 'ACTIVE' WHERE code = 'TON_TESTNET'`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.skipIf(phase6DatabaseUrl === '')('Phase 6 ton_proof challenge + verify gate', () => {
  let pool: Pool;
  let telegramSeq = 600_000_000_000;

  beforeAll(async () => {
    await resetAndMigrate(phase6DatabaseUrl);
    pool = new Pool({ connectionString: phase6DatabaseUrl, max: 10 });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await truncateWalletTables(pool);
  });

  async function nextUser(): Promise<string> {
    telegramSeq += 1;
    return createTestUser(pool, String(telegramSeq));
  }

  it('accepts a valid proof and stores wallet verified via TON_PROOF', async () => {
    const userId = await nextUser();
    const fixture = createWalletFixture();
    const challenge = await createTonProofChallenge(pool, walletConfig, {
      authenticatedUserId: userId,
    });
    const proof = signProof({ fixture, payload: challenge.challenge });
    const bound = await verifyTonProofAndBindWallet(pool, walletConfig, {
      authenticatedUserId: userId,
      account: {
        address: fixture.address,
        network: '-3',
        walletStateInit: fixture.stateInitBase64,
      },
      proof,
    });

    expect(bound.verified).toBe(true);
    expect(bound.verificationMethod).toBe('TON_PROOF');
    expect(bound.isPrimary).toBe(true);
    expect(bound.rawAddress).toBe(fixture.rawAddress);

    const row = await pool.query<{ verified: boolean; verification_method: string }>(
      `SELECT verified, verification_method::text AS verification_method
       FROM user_wallets WHERE id = $1`,
      [bound.walletId],
    );
    expect(row.rows[0]?.verified).toBe(true);
    expect(row.rows[0]?.verification_method).toBe('TON_PROOF');
  });

  it('rejects an invalid signature', async () => {
    const userId = await nextUser();
    const fixture = createWalletFixture();
    const challenge = await createTonProofChallenge(pool, walletConfig, {
      authenticatedUserId: userId,
    });
    const proof = signProof({ fixture, payload: challenge.challenge });
    proof.signature = Buffer.alloc(64, 7).toString('base64');

    await expect(
      verifyTonProofAndBindWallet(pool, walletConfig, {
        authenticatedUserId: userId,
        account: {
          address: fixture.address,
          network: '-3',
          walletStateInit: fixture.stateInitBase64,
        },
        proof,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PROOF' });
  });

  it('rejects altered payload / wrong nonce', async () => {
    const userId = await nextUser();
    const fixture = createWalletFixture();
    const challengeA = await createTonProofChallenge(pool, walletConfig, {
      authenticatedUserId: userId,
    });
    const challengeB = await createTonProofChallenge(pool, walletConfig, {
      authenticatedUserId: userId,
    });
    const proof = signProof({ fixture, payload: challengeA.challenge });
    proof.payload = challengeB.challenge;

    await expect(
      verifyTonProofAndBindWallet(pool, walletConfig, {
        authenticatedUserId: userId,
        account: {
          address: fixture.address,
          network: '-3',
          walletStateInit: fixture.stateInitBase64,
        },
        proof,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PROOF' });

    const missing = signProof({ fixture, payload: 'never-issued-nonce-value' });
    await expect(
      verifyTonProofAndBindWallet(pool, walletConfig, {
        authenticatedUserId: userId,
        account: {
          address: fixture.address,
          network: '-3',
          walletStateInit: fixture.stateInitBase64,
        },
        proof: missing,
      }),
    ).rejects.toMatchObject({ code: 'CHALLENGE_NOT_FOUND' });
  });

  it('rejects nonce replay', async () => {
    const userId = await nextUser();
    const fixture = createWalletFixture();
    const challenge = await createTonProofChallenge(pool, walletConfig, {
      authenticatedUserId: userId,
    });
    const proof = signProof({ fixture, payload: challenge.challenge });
    const account = {
      address: fixture.address,
      network: '-3' as const,
      walletStateInit: fixture.stateInitBase64,
    };
    await verifyTonProofAndBindWallet(pool, walletConfig, {
      authenticatedUserId: userId,
      account,
      proof,
    });

    await expect(
      verifyTonProofAndBindWallet(pool, walletConfig, {
        authenticatedUserId: userId,
        account,
        proof,
      }),
    ).rejects.toMatchObject({ code: 'REPLAY' });
  });

  it('rejects expired challenge', async () => {
    const userId = await nextUser();
    const fixture = createWalletFixture();
    const shortTtl = localWalletOwnershipFixtureConfig({ challengeTtlSeconds: 1 });
    const challenge = await createTonProofChallenge(pool, shortTtl, {
      authenticatedUserId: userId,
    });
    await pool.query(
      `UPDATE user_wallet_proof_nonces
       SET issued_at = now() - interval '10 seconds',
           expires_at = now() - interval '1 second'
       WHERE id = $1::uuid`,
      [challenge.challengeId],
    );
    const proof = signProof({ fixture, payload: challenge.challenge });

    await expect(
      verifyTonProofAndBindWallet(pool, walletConfig, {
        authenticatedUserId: userId,
        account: {
          address: fixture.address,
          network: '-3',
          walletStateInit: fixture.stateInitBase64,
        },
        proof,
      }),
    ).rejects.toMatchObject({ code: 'CHALLENGE_EXPIRED' });

    const live = await createTonProofChallenge(pool, shortTtl, {
      authenticatedUserId: userId,
    });
    await sleep(1_100);
    const liveProof = signProof({ fixture, payload: live.challenge });
    await expect(
      verifyTonProofAndBindWallet(pool, shortTtl, {
        authenticatedUserId: userId,
        account: {
          address: fixture.address,
          network: '-3',
          walletStateInit: fixture.stateInitBase64,
        },
        proof: liveProof,
      }),
    ).rejects.toMatchObject({ code: 'CHALLENGE_EXPIRED' });
  });

  it('rejects stale proof timestamp', async () => {
    const userId = await nextUser();
    const fixture = createWalletFixture();
    const challenge = await createTonProofChallenge(pool, walletConfig, {
      authenticatedUserId: userId,
    });
    const nowUnix = Math.floor(Date.now() / 1000);
    const proof = signProof({
      fixture,
      payload: challenge.challenge,
      timestamp: nowUnix - 10_000,
    });

    await expect(
      verifyTonProofAndBindWallet(pool, walletConfig, {
        authenticatedUserId: userId,
        account: {
          address: fixture.address,
          network: '-3',
          walletStateInit: fixture.stateInitBase64,
        },
        proof,
        now: new Date(nowUnix * 1000),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PROOF' });
  });

  it('rejects excessive future timestamp', async () => {
    const userId = await nextUser();
    const fixture = createWalletFixture();
    const challenge = await createTonProofChallenge(pool, walletConfig, {
      authenticatedUserId: userId,
    });
    const nowUnix = Math.floor(Date.now() / 1000);
    const proof = signProof({
      fixture,
      payload: challenge.challenge,
      timestamp: nowUnix + 3600,
    });

    await expect(
      verifyTonProofAndBindWallet(pool, walletConfig, {
        authenticatedUserId: userId,
        account: {
          address: fixture.address,
          network: '-3',
          walletStateInit: fixture.stateInitBase64,
        },
        proof,
        now: new Date(nowUnix * 1000),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PROOF' });
  });

  it('rejects wrong domain', async () => {
    const userId = await nextUser();
    const fixture = createWalletFixture();
    const challenge = await createTonProofChallenge(pool, walletConfig, {
      authenticatedUserId: userId,
    });
    const proof = signProof({
      fixture,
      payload: challenge.challenge,
      domain: 'evil.example',
    });

    await expect(
      verifyTonProofAndBindWallet(pool, walletConfig, {
        authenticatedUserId: userId,
        account: {
          address: fixture.address,
          network: '-3',
          walletStateInit: fixture.stateInitBase64,
        },
        proof,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_DOMAIN' });
  });

  it('rejects incorrect domain-length', async () => {
    const userId = await nextUser();
    const fixture = createWalletFixture();
    const challenge = await createTonProofChallenge(pool, walletConfig, {
      authenticatedUserId: userId,
    });
    const proof = signProof({
      fixture,
      payload: challenge.challenge,
    });
    proof.domain.lengthBytes = Buffer.byteLength(walletConfig.expectedTonProofDomain, 'utf8') + 1;

    await expect(
      verifyTonProofAndBindWallet(pool, walletConfig, {
        authenticatedUserId: userId,
        account: {
          address: fixture.address,
          network: '-3',
          walletStateInit: fixture.stateInitBase64,
        },
        proof,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_DOMAIN' });
  });

  it('rejects malformed proof', async () => {
    const userId = await nextUser();
    const fixture = createWalletFixture();
    const challenge = await createTonProofChallenge(pool, walletConfig, {
      authenticatedUserId: userId,
    });

    await expect(
      verifyTonProofAndBindWallet(pool, walletConfig, {
        authenticatedUserId: userId,
        account: {
          address: fixture.address,
          network: '-3',
          walletStateInit: fixture.stateInitBase64,
        },
        proof: {
          timestamp: 1,
          domain: { lengthBytes: 1, value: 'x' },
          payload: challenge.challenge,
          signature: 'not-base64-!!!!',
        },
      }),
    ).rejects.toBeInstanceOf(WalletDomainError);
  });

  it('rejects invalid claimed public key', async () => {
    const userId = await nextUser();
    const fixture = createWalletFixture();
    const challenge = await createTonProofChallenge(pool, walletConfig, {
      authenticatedUserId: userId,
    });
    const proof = signProof({ fixture, payload: challenge.challenge });

    await expect(
      verifyTonProofAndBindWallet(pool, walletConfig, {
        authenticatedUserId: userId,
        account: {
          address: fixture.address,
          network: '-3',
          publicKey: Buffer.alloc(32, 9).toString('hex'),
          walletStateInit: fixture.stateInitBase64,
        },
        proof,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_WALLET' });
  });

  it('rejects state-init / account address mismatch', async () => {
    const userId = await nextUser();
    const fixture = createWalletFixture();
    const other = createWalletFixture();
    const challenge = await createTonProofChallenge(pool, walletConfig, {
      authenticatedUserId: userId,
    });
    const proof = signProof({ fixture, payload: challenge.challenge });

    await expect(
      verifyTonProofAndBindWallet(pool, walletConfig, {
        authenticatedUserId: userId,
        account: {
          address: other.address,
          network: '-3',
          walletStateInit: fixture.stateInitBase64,
        },
        proof,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_WALLET' });
  });

  it('rejects address / signing-key mismatch', async () => {
    const userId = await nextUser();
    const fixture = createWalletFixture();
    const wrongKey = createWalletFixture();
    const challenge = await createTonProofChallenge(pool, walletConfig, {
      authenticatedUserId: userId,
    });
    const domain = walletConfig.expectedTonProofDomain;
    const timestamp = Math.floor(Date.now() / 1000);
    const digest = buildTonProofSigningDigest({
      workchain: 0,
      addressHash: Buffer.from(fixture.address.split(':')[1] ?? '', 'hex'),
      domainValue: domain,
      domainLengthBytes: Buffer.byteLength(domain, 'utf8'),
      timestamp,
      payload: challenge.challenge,
    });
    const proof = {
      timestamp,
      domain: { lengthBytes: Buffer.byteLength(domain, 'utf8'), value: domain },
      payload: challenge.challenge,
      signature: sign(digest, wrongKey.secretKey).toString('base64'),
      state_init: fixture.stateInitBase64,
    };

    await expect(
      verifyTonProofAndBindWallet(pool, walletConfig, {
        authenticatedUserId: userId,
        account: {
          address: fixture.address,
          network: '-3',
          walletStateInit: fixture.stateInitBase64,
        },
        proof,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PROOF' });
  });

  it('rejects invalid TON address', async () => {
    const userId = await nextUser();
    const fixture = createWalletFixture();
    const challenge = await createTonProofChallenge(pool, walletConfig, {
      authenticatedUserId: userId,
    });
    const proof = signProof({ fixture, payload: challenge.challenge });

    await expect(
      verifyTonProofAndBindWallet(pool, walletConfig, {
        authenticatedUserId: userId,
        account: {
          address: 'not-a-valid-ton-address',
          network: '-3',
          walletStateInit: fixture.stateInitBase64,
        },
        proof,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ADDRESS' });
  });

  it('fails closed on unsupported wallet state_init', async () => {
    const userId = await nextUser();
    const fixture = createWalletFixture();
    const challenge = await createTonProofChallenge(pool, walletConfig, {
      authenticatedUserId: userId,
    });
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
    const proof = signProof({ fixture, payload: challenge.challenge });
    proof.state_init = bogus;

    await expect(
      verifyTonProofAndBindWallet(pool, walletConfig, {
        authenticatedUserId: userId,
        account: {
          address: fixture.address,
          network: '-3',
          walletStateInit: bogus,
        },
        proof,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_WALLET' });
  });

  it('rejects unacceptable network id from client', async () => {
    const userId = await nextUser();
    const fixture = createWalletFixture();
    const challenge = await createTonProofChallenge(pool, walletConfig, {
      authenticatedUserId: userId,
    });
    const proof = signProof({ fixture, payload: challenge.challenge });

    await expect(
      verifyTonProofAndBindWallet(pool, walletConfig, {
        authenticatedUserId: userId,
        account: {
          address: fixture.address,
          network: '-239',
          walletStateInit: fixture.stateInitBase64,
        },
        proof,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_NETWORK' });
  });

  it('rejects disabled network', async () => {
    const userId = await nextUser();
    const fixture = createWalletFixture();
    await pool.query(`UPDATE networks SET status = 'DISABLED' WHERE code = 'TON_TESTNET'`);

    await expect(
      createTonProofChallenge(pool, walletConfig, { authenticatedUserId: userId }),
    ).rejects.toMatchObject({ code: 'INVALID_NETWORK' });

    await pool.query(`UPDATE networks SET status = 'ACTIVE' WHERE code = 'TON_TESTNET'`);
    const challenge = await createTonProofChallenge(pool, walletConfig, {
      authenticatedUserId: userId,
    });
    const proof = signProof({ fixture, payload: challenge.challenge });
    await pool.query(`UPDATE networks SET status = 'DISABLED' WHERE code = 'TON_TESTNET'`);

    await expect(
      verifyTonProofAndBindWallet(pool, walletConfig, {
        authenticatedUserId: userId,
        account: {
          address: fixture.address,
          network: '-3',
          walletStateInit: fixture.stateInitBase64,
        },
        proof,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_NETWORK' });
  });

  it('rejects Mainnet/Testnet mismatch', async () => {
    const userId = await nextUser();
    const fixture = createWalletFixture();
    const challenge = await createTonProofChallenge(pool, walletConfig, {
      authenticatedUserId: userId,
    });
    const proof = signProof({ fixture, payload: challenge.challenge });

    await expect(
      verifyTonProofAndBindWallet(pool, walletConfig, {
        authenticatedUserId: userId,
        account: {
          address: fixture.address,
          network: '-239',
          walletStateInit: fixture.stateInitBase64,
          publicKey: fixture.publicKey.toString('hex'),
        },
        proof,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_NETWORK' });
  });

  it("rejects another user's nonce", async () => {
    const userA = await nextUser();
    const userB = await nextUser();
    const fixture = createWalletFixture();
    const challenge = await createTonProofChallenge(pool, walletConfig, {
      authenticatedUserId: userA,
    });
    const proof = signProof({ fixture, payload: challenge.challenge });

    await expect(
      verifyTonProofAndBindWallet(pool, walletConfig, {
        authenticatedUserId: userB,
        account: {
          address: fixture.address,
          network: '-3',
          walletStateInit: fixture.stateInitBase64,
        },
        proof,
      }),
    ).rejects.toMatchObject({ code: 'CHALLENGE_NOT_FOUND' });
  });
});
