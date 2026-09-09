/**
 * Phase 6 concurrency / replay safety against real PostgreSQL.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  changePrimaryWallet,
  createTonProofChallenge,
  verifyTonProofAndBindWallet,
  type WalletDomainError,
} from '../src/index.js';
import {
  createTestUser,
  createWalletFixture,
  phase6DatabaseUrl,
  resetAndMigrate,
  signProof,
  walletConfig,
} from './harness.js';

const describeDb = describe.skipIf(!phase6DatabaseUrl);

describeDb('Phase 6 concurrency', () => {
  let pool: Pool;

  beforeAll(async () => {
    await resetAndMigrate(phase6DatabaseUrl);
    pool = new Pool({ connectionString: phase6DatabaseUrl, max: 10 });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE TABLE
        outbox_events,
        audit_logs,
        user_wallet_proof_nonces,
        user_wallets,
        users
      RESTART IDENTITY CASCADE
    `);
  });

  it('concurrent same nonce => exactly one verification', async () => {
    const userId = await createTestUser(pool, '62001');
    const fixture = createWalletFixture();
    const challenge = await createTonProofChallenge(pool, walletConfig, {
      authenticatedUserId: userId,
    });
    const proof = signProof({ fixture, payload: challenge.challenge });
    const input = {
      authenticatedUserId: userId,
      account: {
        address: fixture.address,
        network: '-3' as const,
        walletStateInit: fixture.stateInitBase64,
      },
      proof,
    };
    const results = await Promise.allSettled([
      verifyTonProofAndBindWallet(pool, walletConfig, input),
      verifyTonProofAndBindWallet(pool, walletConfig, input),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    const reason = (failed[0] as PromiseRejectedResult).reason as WalletDomainError;
    expect(['REPLAY', 'CHALLENGE_CONSUMED']).toContain(reason.code);
    const wallets = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM user_wallets WHERE user_id = $1`,
      [userId],
    );
    expect(wallets.rows[0]?.c).toBe(1);
  });

  it('concurrent same new wallet with different challenges => one wallet row', async () => {
    const userId = await createTestUser(pool, '62002');
    const fixture = createWalletFixture();
    const c1 = await createTonProofChallenge(pool, walletConfig, { authenticatedUserId: userId });
    const c2 = await createTonProofChallenge(pool, walletConfig, { authenticatedUserId: userId });
    const results = await Promise.allSettled([
      verifyTonProofAndBindWallet(pool, walletConfig, {
        authenticatedUserId: userId,
        account: {
          address: fixture.address,
          network: '-3',
          walletStateInit: fixture.stateInitBase64,
        },
        proof: signProof({ fixture, payload: c1.challenge }),
      }),
      verifyTonProofAndBindWallet(pool, walletConfig, {
        authenticatedUserId: userId,
        account: {
          address: fixture.address,
          network: '-3',
          walletStateInit: fixture.stateInitBase64,
        },
        proof: signProof({ fixture, payload: c2.challenge }),
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    const wallets = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM user_wallets WHERE user_id = $1`,
      [userId],
    );
    expect(wallets.rows[0]?.c).toBe(1);
  });

  it('concurrent first-wallet registrations => exactly one primary', async () => {
    const userId = await createTestUser(pool, '62003');
    const a = createWalletFixture();
    const b = createWalletFixture();
    const c1 = await createTonProofChallenge(pool, walletConfig, { authenticatedUserId: userId });
    const c2 = await createTonProofChallenge(pool, walletConfig, { authenticatedUserId: userId });
    await Promise.allSettled([
      verifyTonProofAndBindWallet(pool, walletConfig, {
        authenticatedUserId: userId,
        account: { address: a.address, network: '-3', walletStateInit: a.stateInitBase64 },
        proof: signProof({ fixture: a, payload: c1.challenge }),
      }),
      verifyTonProofAndBindWallet(pool, walletConfig, {
        authenticatedUserId: userId,
        account: { address: b.address, network: '-3', walletStateInit: b.stateInitBase64 },
        proof: signProof({ fixture: b, payload: c2.challenge }),
      }),
    ]);
    const primaries = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM user_wallets
       WHERE user_id = $1 AND is_primary AND disabled_at IS NULL`,
      [userId],
    );
    expect(primaries.rows[0]?.c).toBe(1);
  });

  it('concurrent primary changes => deterministic single primary and one cooldown', async () => {
    const userId = await createTestUser(pool, '62004');
    const a = createWalletFixture();
    const b = createWalletFixture();
    const c = createWalletFixture();
    const first = await createTonProofChallenge(pool, walletConfig, {
      authenticatedUserId: userId,
    });
    await verifyTonProofAndBindWallet(pool, walletConfig, {
      authenticatedUserId: userId,
      account: { address: a.address, network: '-3', walletStateInit: a.stateInitBase64 },
      proof: signProof({ fixture: a, payload: first.challenge }),
    });

    const cb = await createTonProofChallenge(pool, walletConfig, { authenticatedUserId: userId });
    const cc = await createTonProofChallenge(pool, walletConfig, { authenticatedUserId: userId });
    const results = await Promise.allSettled([
      changePrimaryWallet(pool, walletConfig, {
        authenticatedUserId: userId,
        account: { address: b.address, network: '-3', walletStateInit: b.stateInitBase64 },
        proof: signProof({ fixture: b, payload: cb.challenge }),
      }),
      changePrimaryWallet(pool, walletConfig, {
        authenticatedUserId: userId,
        account: { address: c.address, network: '-3', walletStateInit: c.stateInitBase64 },
        proof: signProof({ fixture: c, payload: cc.challenge }),
      }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const primaries = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM user_wallets
       WHERE user_id = $1 AND is_primary AND disabled_at IS NULL`,
      [userId],
    );
    expect(primaries.rows[0]?.c).toBe(1);
    const user = await pool.query<{ withdrawal_cooldown_until: Date | null }>(
      `SELECT withdrawal_cooldown_until FROM users WHERE id = $1`,
      [userId],
    );
    expect(user.rows[0]?.withdrawal_cooldown_until).not.toBeNull();
    const audits = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM audit_logs WHERE action_type = 'PRIMARY_WALLET_CHANGED'`,
    );
    expect(audits.rows[0]?.c).toBeGreaterThanOrEqual(1);
    expect(audits.rows[0]?.c).toBeLessThanOrEqual(2);
  });

  it('successful switch always consumes nonce', async () => {
    const userId = await createTestUser(pool, '62005');
    const a = createWalletFixture();
    const b = createWalletFixture();
    const first = await createTonProofChallenge(pool, walletConfig, {
      authenticatedUserId: userId,
    });
    await verifyTonProofAndBindWallet(pool, walletConfig, {
      authenticatedUserId: userId,
      account: { address: a.address, network: '-3', walletStateInit: a.stateInitBase64 },
      proof: signProof({ fixture: a, payload: first.challenge }),
    });
    const challenge = await createTonProofChallenge(pool, walletConfig, {
      authenticatedUserId: userId,
    });
    await changePrimaryWallet(pool, walletConfig, {
      authenticatedUserId: userId,
      account: { address: b.address, network: '-3', walletStateInit: b.stateInitBase64 },
      proof: signProof({ fixture: b, payload: challenge.challenge }),
    });
    const nonce = await pool.query<{ consumed_at: Date | null; consumed_wallet_id: string | null }>(
      `SELECT consumed_at, consumed_wallet_id FROM user_wallet_proof_nonces WHERE id = $1`,
      [challenge.challengeId],
    );
    expect(nonce.rows[0]?.consumed_at).not.toBeNull();
    expect(nonce.rows[0]?.consumed_wallet_id).not.toBeNull();
  });
});
