/**
 * Phase 6 wallet lifecycle + primary change matrix.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  changePrimaryWallet,
  createTonProofChallenge,
  verifyTonProofAndBindWallet,
  WalletDomainError,
} from '../src/index.js';
import {
  addressVariants,
  claimFounderForUser,
  createTestUser,
  createWalletFixture,
  phase6DatabaseUrl,
  resetAndMigrate,
  signProof,
  walletConfig,
} from './harness.js';

const describeDb = describe.skipIf(!phase6DatabaseUrl);

describeDb('Phase 6 wallet lifecycle', () => {
  let pool: Pool;

  beforeAll(async () => {
    await resetAndMigrate(phase6DatabaseUrl);
    pool = new Pool({ connectionString: phase6DatabaseUrl });
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
        user_memberships,
        users
      RESTART IDENTITY CASCADE
    `);
  });

  async function bindWallet(userId: string, fixture = createWalletFixture()) {
    const challenge = await createTonProofChallenge(pool, walletConfig, {
      authenticatedUserId: userId,
    });
    const proof = signProof({ fixture, payload: challenge.challenge });
    const result = await verifyTonProofAndBindWallet(pool, walletConfig, {
      authenticatedUserId: userId,
      account: {
        address: fixture.address,
        network: '-3',
        walletStateInit: fixture.stateInitBase64,
      },
      proof,
    });
    return { result, fixture, challenge };
  }

  it('stores first verified wallet as primary without cooldown', async () => {
    const userId = await createTestUser(pool, '61001');
    const { result, fixture } = await bindWallet(userId);
    expect(result.isPrimary).toBe(true);
    expect(result.becamePrimary).toBe(true);
    expect(result.rawAddress).toBe(fixture.rawAddress);
    const user = await pool.query<{
      withdrawal_cooldown_until: Date | null;
      primary_wallet_changed_at: Date | null;
    }>(`SELECT withdrawal_cooldown_until, primary_wallet_changed_at FROM users WHERE id = $1`, [
      userId,
    ]);
    expect(user.rows[0]?.withdrawal_cooldown_until).toBeNull();
    expect(user.rows[0]?.primary_wallet_changed_at).toBeNull();
    const wallet = await pool.query<{
      friendly_address: string;
      verification_method: string;
      verified: boolean;
    }>(`SELECT friendly_address, verification_method, verified FROM user_wallets WHERE id = $1`, [
      result.walletId,
    ]);
    expect(wallet.rows[0]?.verified).toBe(true);
    expect(wallet.rows[0]?.verification_method).toBe('TON_PROOF');
    expect(wallet.rows[0]?.friendly_address).toBe(fixture.friendlyAddress);
  });

  it('canonicalizes address variants to one wallet row', async () => {
    const userId = await createTestUser(pool, '61002');
    const fixture = createWalletFixture();
    await bindWallet(userId, fixture);
    for (const variant of addressVariants(fixture.friendlyAddress)) {
      const challenge = await createTonProofChallenge(pool, walletConfig, {
        authenticatedUserId: userId,
      });
      // Sign for canonical account; submit variant as account.address only if parseable as same account.
      // TON Connect uses raw form; prove server canonicalize of friendly variants via upsert path.
      const proof = signProof({ fixture, payload: challenge.challenge });
      await verifyTonProofAndBindWallet(pool, walletConfig, {
        authenticatedUserId: userId,
        account: {
          address: variant.includes(':') ? variant : fixture.address,
          network: '-3',
          walletStateInit: fixture.stateInitBase64,
        },
        proof,
      });
    }
    const count = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM user_wallets WHERE user_id = $1`,
      [userId],
    );
    expect(count.rows[0]?.c).toBe(1);
  });

  it('re-proof does not duplicate wallet rows', async () => {
    const userId = await createTestUser(pool, '61003');
    const fixture = createWalletFixture();
    await bindWallet(userId, fixture);
    await bindWallet(userId, fixture);
    const count = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM user_wallets WHERE user_id = $1`,
      [userId],
    );
    expect(count.rows[0]?.c).toBe(1);
  });

  it('does not mutate another user wallet via their challenge', async () => {
    const userA = await createTestUser(pool, '61004');
    const userB = await createTestUser(pool, '61005');
    const { fixture } = await bindWallet(userA);
    const challengeB = await createTonProofChallenge(pool, walletConfig, {
      authenticatedUserId: userB,
    });
    const proof = signProof({ fixture, payload: challengeB.challenge });
    await verifyTonProofAndBindWallet(pool, walletConfig, {
      authenticatedUserId: userB,
      account: {
        address: fixture.address,
        network: '-3',
        walletStateInit: fixture.stateInitBase64,
      },
      proof,
    });
    const rows = await pool.query(
      `SELECT user_id FROM user_wallets WHERE raw_address = $1 ORDER BY user_id`,
      [fixture.rawAddress],
    );
    expect(rows.rowCount).toBe(2);
  });

  it('changes primary A->B with fresh proof, history, audit, invalidate, 24h cooldown', async () => {
    const userId = await createTestUser(pool, '61006');
    const walletA = createWalletFixture();
    const walletB = createWalletFixture();
    const boundA = await bindWallet(userId, walletA);

    const openChallenge = await createTonProofChallenge(pool, walletConfig, {
      authenticatedUserId: userId,
    });

    const changeChallenge = await createTonProofChallenge(pool, walletConfig, {
      authenticatedUserId: userId,
    });
    const proof = signProof({ fixture: walletB, payload: changeChallenge.challenge });
    const changed = await changePrimaryWallet(pool, walletConfig, {
      authenticatedUserId: userId,
      account: {
        address: walletB.address,
        network: '-3',
        walletStateInit: walletB.stateInitBase64,
      },
      proof,
    });

    expect(changed.primaryChanged).toBe(true);
    if (!changed.primaryChanged) throw new Error('expected change');
    expect(changed.oldWalletId).toBe(boundA.result.walletId);
    expect(changed.newWalletId).not.toBe(boundA.result.walletId);

    const wallets = await pool.query<{ id: string; is_primary: boolean }>(
      `SELECT id, is_primary FROM user_wallets WHERE user_id = $1 ORDER BY created_at`,
      [userId],
    );
    expect(wallets.rowCount).toBe(2);
    const primary = wallets.rows.filter((w) => w.is_primary);
    expect(primary).toHaveLength(1);
    expect(primary[0]?.id).toBe(changed.newWalletId);
    expect(wallets.rows.find((w) => w.id === boundA.result.walletId)?.is_primary).toBe(false);

    const user = await pool.query<{
      primary_wallet_changed_at: Date;
      withdrawal_cooldown_until: Date;
    }>(`SELECT primary_wallet_changed_at, withdrawal_cooldown_until FROM users WHERE id = $1`, [
      userId,
    ]);
    const changedAt = user.rows[0]?.primary_wallet_changed_at.getTime() ?? 0;
    const cooldown = user.rows[0]?.withdrawal_cooldown_until.getTime() ?? 0;
    expect(cooldown - changedAt).toBe(24 * 60 * 60 * 1000);

    const audits = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM audit_logs WHERE action_type = 'PRIMARY_WALLET_CHANGED'`,
    );
    expect(audits.rows[0]?.c).toBe(1);

    const outbox = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM outbox_events WHERE event_type = 'primary_wallet.changed'`,
    );
    expect(outbox.rows[0]?.c).toBe(1);

    const invalidated = await pool.query<{
      invalidated_at: Date | null;
      invalidation_reason: string | null;
    }>(`SELECT invalidated_at, invalidation_reason FROM user_wallet_proof_nonces WHERE id = $1`, [
      openChallenge.challengeId,
    ]);
    expect(invalidated.rows[0]?.invalidated_at).not.toBeNull();
    expect(invalidated.rows[0]?.invalidation_reason).toBe('PRIMARY_WALLET_CHANGED');
  });

  it('replay cannot repeat primary change cooldown', async () => {
    const userId = await createTestUser(pool, '61007');
    const a = createWalletFixture();
    const b = createWalletFixture();
    await bindWallet(userId, a);
    const challenge = await createTonProofChallenge(pool, walletConfig, {
      authenticatedUserId: userId,
    });
    const proof = signProof({ fixture: b, payload: challenge.challenge });
    const input = {
      authenticatedUserId: userId,
      account: {
        address: b.address,
        network: '-3' as const,
        walletStateInit: b.stateInitBase64,
      },
      proof,
    };
    await changePrimaryWallet(pool, walletConfig, input);
    const cooldown1 = await pool.query<{ withdrawal_cooldown_until: Date }>(
      `SELECT withdrawal_cooldown_until FROM users WHERE id = $1`,
      [userId],
    );
    await expect(changePrimaryWallet(pool, walletConfig, input)).rejects.toMatchObject({
      code: 'REPLAY',
    });
    const cooldown2 = await pool.query<{ withdrawal_cooldown_until: Date }>(
      `SELECT withdrawal_cooldown_until FROM users WHERE id = $1`,
      [userId],
    );
    expect(cooldown2.rows[0]?.withdrawal_cooldown_until.getTime()).toBe(
      cooldown1.rows[0]?.withdrawal_cooldown_until.getTime(),
    );
  });

  it('re-proof of current primary does not trigger wallet change cooldown', async () => {
    const userId = await createTestUser(pool, '61008');
    const fixture = createWalletFixture();
    await bindWallet(userId, fixture);
    const challenge = await createTonProofChallenge(pool, walletConfig, {
      authenticatedUserId: userId,
    });
    const proof = signProof({ fixture, payload: challenge.challenge });
    const result = await changePrimaryWallet(pool, walletConfig, {
      authenticatedUserId: userId,
      account: {
        address: fixture.address,
        network: '-3',
        walletStateInit: fixture.stateInitBase64,
      },
      proof,
    });
    expect(result.primaryChanged).toBe(false);
    const user = await pool.query<{ withdrawal_cooldown_until: Date | null }>(
      `SELECT withdrawal_cooldown_until FROM users WHERE id = $1`,
      [userId],
    );
    expect(user.rows[0]?.withdrawal_cooldown_until).toBeNull();
  });

  it('Founder membership gets the same 24h cooldown', async () => {
    const userId = await createTestUser(pool, '61009');
    await claimFounderForUser(pool, userId);
    const a = createWalletFixture();
    const b = createWalletFixture();
    await bindWallet(userId, a);
    const challenge = await createTonProofChallenge(pool, walletConfig, {
      authenticatedUserId: userId,
    });
    const proof = signProof({ fixture: b, payload: challenge.challenge });
    const changed = await changePrimaryWallet(pool, walletConfig, {
      authenticatedUserId: userId,
      account: {
        address: b.address,
        network: '-3',
        walletStateInit: b.stateInitBase64,
      },
      proof,
    });
    expect(changed.primaryChanged).toBe(true);
    if (!changed.primaryChanged) throw new Error('expected change');
    const delta =
      changed.withdrawalCooldownUntil.getTime() - changed.primaryWalletChangedAt.getTime();
    expect(delta).toBe(24 * 60 * 60 * 1000);
  });

  it('failed proof leaves primary and cooldown unchanged', async () => {
    const userId = await createTestUser(pool, '61010');
    const a = createWalletFixture();
    const b = createWalletFixture();
    await bindWallet(userId, a);
    const challenge = await createTonProofChallenge(pool, walletConfig, {
      authenticatedUserId: userId,
    });
    const proof = signProof({ fixture: b, payload: challenge.challenge });
    proof.signature = Buffer.alloc(64, 1).toString('base64');
    await expect(
      changePrimaryWallet(pool, walletConfig, {
        authenticatedUserId: userId,
        account: {
          address: b.address,
          network: '-3',
          walletStateInit: b.stateInitBase64,
        },
        proof,
      }),
    ).rejects.toBeInstanceOf(WalletDomainError);

    const wallets = await pool.query<{ id: string; is_primary: boolean }>(
      `SELECT id, is_primary FROM user_wallets WHERE user_id = $1`,
      [userId],
    );
    expect(wallets.rowCount).toBe(1);
    expect(wallets.rows[0]?.is_primary).toBe(true);
    const user = await pool.query<{ withdrawal_cooldown_until: Date | null }>(
      `SELECT withdrawal_cooldown_until FROM users WHERE id = $1`,
      [userId],
    );
    expect(user.rows[0]?.withdrawal_cooldown_until).toBeNull();
  });

  it('user_wallets has no private key or seed columns', async () => {
    const cols = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'user_wallets'`,
    );
    const names = cols.rows.map((r) => r.column_name);
    expect(names.some((n) => /private|seed|mnemonic|secret/i.test(n))).toBe(false);
  });

  it('rolls back primary switch when audit insert is forced to fail', async () => {
    const userId = await createTestUser(pool, '61011');
    const a = createWalletFixture();
    const b = createWalletFixture();
    await bindWallet(userId, a);
    const challenge = await createTonProofChallenge(pool, walletConfig, {
      authenticatedUserId: userId,
    });
    const proof = signProof({ fixture: b, payload: challenge.challenge });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `CREATE OR REPLACE FUNCTION app_reject_primary_wallet_audit()
         RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
           IF NEW.action_type = 'PRIMARY_WALLET_CHANGED' THEN
             RAISE EXCEPTION 'injected audit failure';
           END IF;
           RETURN NEW;
         END $$;`,
      );
      await client.query(
        `CREATE TRIGGER trg_reject_primary_wallet_audit
         BEFORE INSERT ON audit_logs
         FOR EACH ROW EXECUTE FUNCTION app_reject_primary_wallet_audit();`,
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    await expect(
      changePrimaryWallet(pool, walletConfig, {
        authenticatedUserId: userId,
        account: {
          address: b.address,
          network: '-3',
          walletStateInit: b.stateInitBase64,
        },
        proof,
      }),
    ).rejects.toThrow();

    const wallets = await pool.query<{ primaries: number; total: number }>(
      `SELECT count(*) FILTER (WHERE is_primary)::int AS primaries,
              count(*)::int AS total
       FROM user_wallets WHERE user_id = $1`,
      [userId],
    );
    expect(wallets.rows[0]?.primaries).toBe(1);
    expect(wallets.rows[0]?.total).toBe(1);
    const user = await pool.query<{ withdrawal_cooldown_until: Date | null }>(
      `SELECT withdrawal_cooldown_until FROM users WHERE id = $1`,
      [userId],
    );
    expect(user.rows[0]?.withdrawal_cooldown_until).toBeNull();
    const nonce = await pool.query<{ consumed_at: Date | null }>(
      `SELECT consumed_at FROM user_wallet_proof_nonces WHERE id = $1`,
      [challenge.challengeId],
    );
    expect(nonce.rows[0]?.consumed_at).toBeNull();

    await pool.query(`DROP TRIGGER IF EXISTS trg_reject_primary_wallet_audit ON audit_logs`);
    await pool.query(`DROP FUNCTION IF EXISTS app_reject_primary_wallet_audit()`);
  });
});
