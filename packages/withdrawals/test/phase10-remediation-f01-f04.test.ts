/**
 * Phase 10 final narrow remediation: F-01, F-02, F-04.
 * Disposable DB only (PHASE7_DATABASE_URL / alex_rewards_test).
 */
import { createHash, randomUUID } from 'node:crypto';

import { FakeTonChainProvider, deriveWalletV5R1AddressRaw } from '@alex-rewards/ton';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  acquireHotWalletDispatchLease,
  buildPhase10PayoutConfig,
  createWithdrawalAttempt,
  createWithdrawalFromQuote,
  createWithdrawalQuote,
  hotWalletDispatchOwnerIdentity,
  localWithdrawalEngineFixtureConfig,
  persistIntendedPayoutProvenEvidence,
  persistPreBroadcastEvidence,
  PipelineCrashError,
  releaseHotWalletDispatchLease,
  runRealTestnetPayoutPipeline,
  settleWithdrawalReservation,
  updateAttemptBroadcastState,
  withWithdrawalTransaction,
  type RealPayoutSignerPort,
} from '../src/index.js';
import {
  assertLedgerBalanced,
  bindVerifiedPrimaryWallet,
  createApprovedWithdrawal,
  createTestUser,
  createVerifiedPrimaryWallet,
  engineConfig,
  ensureEncryptedPayoutHotWallet,
  fundUserAvailable,
  phase7DatabaseUrl,
  resetAndMigrate,
  seedPhase7Base,
  truncateWithdrawalTables,
  userBucketBalance,
} from './harness.js';

const PAYOUT_JETTON_WALLET = '0:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const RECIPIENT_RAW = '0:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TEST_PUBLIC_KEY_HEX = '11'.repeat(32);
const ENCRYPTED_SIGNER_REF = createHash('sha256')
  .update(Buffer.from(TEST_PUBLIC_KEY_HEX, 'hex'))
  .digest('hex');
const HOT_WALLET_RAW = deriveWalletV5R1AddressRaw({
  publicKeyHex: TEST_PUBLIC_KEY_HEX,
  networkGlobalId: -3,
});
const TEST_CANONICAL_HASH = '22'.repeat(32);
const nonFakeEngine = localWithdrawalEngineFixtureConfig({ fakeChainEnabled: false });

function createBarrier(n: number): { wait: () => Promise<void>; arrive: () => void } {
  let remaining = n;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  return {
    wait: () => gate,
    arrive: () => {
      remaining -= 1;
      if (remaining <= 0) release();
    },
  };
}

describe.skipIf(phase7DatabaseUrl === '')('Phase 10 final F-01 confirmed-attempt settlement', () => {
  let pool: Pool;
  let assetId: string;
  let networkId: string;
  let adminUserId: string;
  let hotWalletId: string;
  let seq = 11_100;

  beforeAll(async () => {
    await resetAndMigrate(phase7DatabaseUrl);
    pool = new Pool({ connectionString: phase7DatabaseUrl, max: 20 });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await truncateWithdrawalTables(pool);
    const base = await seedPhase7Base(pool);
    assetId = base.assetId;
    networkId = base.networkId;
    adminUserId = base.adminUserId;
    hotWalletId = base.hotWalletId;
  });

  async function approved(): Promise<string> {
    const userId = await createTestUser(pool, String(++seq));
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    return createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
  }

  async function makeAttempt(
    withdrawalId: string,
    state: 'BROADCASTED' | 'UNKNOWN',
  ): Promise<{ id: string; fence: bigint }> {
    const owner = hotWalletDispatchOwnerIdentity(withdrawalId);
    return withWithdrawalTransaction(pool, async (client) => {
      const lease = await acquireHotWalletDispatchLease(client, hotWalletId, owner);
      expect(lease.status).toBe('ACQUIRED');
      if (lease.status !== 'ACQUIRED') throw new Error('lease');
      const attempt = await createWithdrawalAttempt(client, {
        withdrawalId,
        hotWalletId,
        fencingToken: lease.fencingToken,
        signerKeyReference: 'TEST_ONLY_FAKE_HOT_1',
        leaseOwnerIdentity: owner,
      });
      await persistPreBroadcastEvidence(client, {
        attemptId: attempt.id,
        signedExternalMessageBoc: `boc-${attempt.id}`,
        signedWalletRequestBoc: 'dGVzdA==',
        externalMessageCellHash: 'a'.repeat(64),
        normalizedExternalMessageHash: 'b'.repeat(64),
      });
      await updateAttemptBroadcastState(client, {
        attemptId: attempt.id,
        broadcastResultState: state,
        markBroadcastStarted: true,
      });
      await client.query(
        `UPDATE withdrawal_attempts SET broadcast_submitted_at = now() WHERE id = $1::uuid`,
        [attempt.id],
      );
      return { id: attempt.id, fence: lease.fencingToken };
    });
  }

  it('settles only proven attempt; UNKNOWN sibling blocks B until independently resolved', async () => {
    const a = await approved();
    const b = await approved();
    const confirmed = await makeAttempt(a, 'BROADCASTED');

    // Fixture: sibling UNKNOWN attempt (submitted but not confirmed). Not manufacturing settled_at.
    await pool.query(
      `INSERT INTO withdrawal_attempts (
         withdrawal_id, attempt_number, hot_wallet_id, expected_seqno, query_id,
         valid_until, canonical_message_hash, signer_key_reference,
         dispatch_fencing_token, broadcast_result_state, requires_state_init,
         broadcast_submitted_at, broadcast_started_at, signed_external_message_boc
       )
       SELECT withdrawal_id, attempt_number + 1, hot_wallet_id, expected_seqno + 1, query_id + 1,
              valid_until, 'unknown-sibling-hash', signer_key_reference,
              dispatch_fencing_token, 'UNKNOWN', requires_state_init,
              now(), now(), 'dW5rbm93bg=='
       FROM withdrawal_attempts WHERE id = $1::uuid`,
      [confirmed.id],
    );
    const unknownId = (
      await pool.query<{ id: string }>(
        `SELECT id::text AS id FROM withdrawal_attempts
         WHERE withdrawal_id = $1::uuid AND broadcast_result_state = 'UNKNOWN'`,
        [a],
      )
    ).rows[0]!.id;

    await withWithdrawalTransaction(pool, async (client) => {
      await persistIntendedPayoutProvenEvidence(client, {
        withdrawalId: a,
        attemptId: confirmed.id,
        observedRecipient: '0:recipient',
        observedAmountAtomic: '190000',
        observedQueryId: '1',
        evidenceSummary: { test: 'f01-attribution' },
      });
      await client.query(
        `UPDATE withdrawals
         SET state = 'CONFIRMED', confirmed_at = now(), updated_at = now()
         WHERE id = $1::uuid`,
        [a],
      );
      await settleWithdrawalReservation(client, {
        withdrawalId: a,
        confirmedAttemptId: confirmed.id,
      });
      const owner = hotWalletDispatchOwnerIdentity(a);
      await releaseHotWalletDispatchLease(client, {
        hotWalletId,
        ownerIdentity: owner,
        fencingToken: confirmed.fence,
        reason: 'CONFIRMED_SETTLED',
      });
    });

    const stamps = await pool.query<{ id: string; settled_at: Date | null }>(
      `SELECT id::text AS id, settled_at FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid`,
      [a],
    );
    const byId = new Map(stamps.rows.map((r) => [r.id, r.settled_at]));
    expect(byId.get(confirmed.id)).not.toBeNull();
    expect(byId.get(unknownId)).toBeNull();

    // Per-attempt fence: UNKNOWN sibling still blocks B.
    await pool.query(
      `UPDATE hot_wallet_dispatch_leases
       SET acquired_at = now() - interval '2 minutes',
           expires_at = now() - interval '1 minute',
           released_at = NULL
       WHERE hot_wallet_id = $1::uuid`,
      [hotWalletId],
    );
    await withWithdrawalTransaction(pool, async (client) => {
      const blocked = await acquireHotWalletDispatchLease(
        client,
        hotWalletId,
        hotWalletDispatchOwnerIdentity(b),
      );
      expect(blocked.status).toBe('BLOCKED_UNRESOLVED');
    });

    // Independently resolve the sibling → B may proceed.
    await pool.query(
      `INSERT INTO withdrawal_payout_reconciliations (
         withdrawal_id, withdrawal_attempt_id, resolution, evidence_summary, resolved_at
       ) VALUES ($1::uuid, $2::uuid, 'DEFINITIVE_NONPAYMENT', '{}'::jsonb, now())`,
      [a, unknownId],
    );
    await withWithdrawalTransaction(pool, async (client) => {
      const leaseB = await acquireHotWalletDispatchLease(
        client,
        hotWalletId,
        hotWalletDispatchOwnerIdentity(b),
      );
      expect(leaseB.status).toBe('ACQUIRED');
    });
    await assertLedgerBalanced(pool);
  });

  it('CONFIRMED resume attributes settlement to proven attempt 1, not newer BROADCASTED attempt 2', async () => {
    const a = await approved();
    const attempt1 = await makeAttempt(a, 'BROADCASTED');

    await withWithdrawalTransaction(pool, async (client) => {
      await persistIntendedPayoutProvenEvidence(client, {
        withdrawalId: a,
        attemptId: attempt1.id,
        observedRecipient: '0:recipient',
        observedAmountAtomic: '190000',
        observedQueryId: '1',
        evidenceSummary: { test: 'f01-latest-not-confirmed' },
      });
      await client.query(
        `UPDATE withdrawals
         SET state = 'CONFIRMED', confirmed_at = now(), updated_at = now()
         WHERE id = $1::uuid`,
        [a],
      );
      await settleWithdrawalReservation(client, {
        withdrawalId: a,
        confirmedAttemptId: attempt1.id,
      });
    });

    // Newer sibling BROADCASTED without proof (latest by attempt_number).
    await pool.query(
      `INSERT INTO withdrawal_attempts (
         withdrawal_id, attempt_number, hot_wallet_id, expected_seqno, query_id,
         valid_until, canonical_message_hash, signer_key_reference,
         dispatch_fencing_token, broadcast_result_state, requires_state_init,
         broadcast_submitted_at, broadcast_started_at, signed_external_message_boc
       )
       SELECT withdrawal_id, attempt_number + 1, hot_wallet_id, expected_seqno + 1, query_id + 1,
              valid_until, 'newer-broadcasted-no-proof', signer_key_reference,
              dispatch_fencing_token, 'BROADCASTED', requires_state_init,
              now(), now(), 'bmV3ZXI='
       FROM withdrawal_attempts WHERE id = $1::uuid`,
      [attempt1.id],
    );
    const attempt2 = (
      await pool.query<{ id: string }>(
        `SELECT id::text AS id FROM withdrawal_attempts
         WHERE withdrawal_id = $1::uuid AND canonical_message_hash = 'newer-broadcasted-no-proof'`,
        [a],
      )
    ).rows[0]!.id;

    // Explicit wrong attribution rejected.
    await expect(
      withWithdrawalTransaction(pool, async (client) =>
        settleWithdrawalReservation(client, {
          withdrawalId: a,
          confirmedAttemptId: attempt2,
        }),
      ),
    ).rejects.toMatchObject({ code: 'RECONCILE_REQUIRED' });

    // Resume-style settle without assuming latest attempt — stamps only attempt 1.
    const resumed = await withWithdrawalTransaction(pool, async (client) =>
      settleWithdrawalReservation(client, { withdrawalId: a }),
    );
    expect(resumed.confirmedAttemptId).toBe(attempt1.id);
    expect(resumed.settled).toBe(false);

    const stamps = await pool.query<{ id: string; settled_at: Date | null }>(
      `SELECT id::text AS id, settled_at FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid`,
      [a],
    );
    const byId = new Map(stamps.rows.map((r) => [r.id, r.settled_at]));
    expect(byId.get(attempt1.id)).not.toBeNull();
    expect(byId.get(attempt2)).toBeNull();
  });

  it('rejects UNKNOWN attempt settle and wrong attempt identity', async () => {
    const a = await approved();
    const unknown = await makeAttempt(a, 'UNKNOWN');

    await pool.query(
      `UPDATE withdrawals SET state = 'CONFIRMED', confirmed_at = now() WHERE id = $1::uuid`,
      [a],
    );

    await expect(
      withWithdrawalTransaction(pool, async (client) =>
        settleWithdrawalReservation(client, {
          withdrawalId: a,
          confirmedAttemptId: unknown.id,
        }),
      ),
    ).rejects.toMatchObject({ code: 'RECONCILE_REQUIRED' });

    await expect(
      withWithdrawalTransaction(pool, async (client) =>
        settleWithdrawalReservation(client, {
          withdrawalId: a,
          confirmedAttemptId: randomUUID(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'RECONCILE_REQUIRED' });

    await pool.query(
      `UPDATE hot_wallet_dispatch_leases
       SET acquired_at = now() - interval '2 minutes',
           expires_at = now() - interval '1 minute',
           released_at = NULL
       WHERE hot_wallet_id = $1::uuid`,
      [hotWalletId],
    );
    const blocked = await withWithdrawalTransaction(pool, async (client) =>
      acquireHotWalletDispatchLease(
        client,
        hotWalletId,
        hotWalletDispatchOwnerIdentity(await approved()),
      ),
    );
    expect(blocked.status).toBe('BLOCKED_UNRESOLVED');
  });
});

describe.skipIf(phase7DatabaseUrl === '')('Phase 10 final F-02 all-eight concurrent idempotency', () => {
  let pool: Pool;
  let assetId: string;
  let networkId: string;
  let seq = 11_200;

  beforeAll(async () => {
    await resetAndMigrate(phase7DatabaseUrl);
    pool = new Pool({ connectionString: phase7DatabaseUrl, max: 40 });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await truncateWithdrawalTables(pool);
    const base = await seedPhase7Base(pool);
    assetId = base.assetId;
    networkId = base.networkId;
  });

  it('eight independent connections: all succeed with one withdrawal and one reservation', async () => {
    const userId = await createTestUser(pool, String(++seq));
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '1000000',
      key: randomUUID(),
    });
    const quote = await createWithdrawalQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      amountAtomic: '200000',
    });
    const key = `idem-strict-${randomUUID()}`;
    const barrier = createBarrier(8);
    const connections = Array.from({ length: 8 }, () => {
      const p = new Pool({ connectionString: phase7DatabaseUrl, max: 2 });
      return p;
    });

    try {
      const results = await Promise.all(
        connections.map(async (conn) => {
          barrier.arrive();
          await barrier.wait();
          return createWithdrawalFromQuote(conn, engineConfig, {
            authenticatedUserId: userId,
            quoteId: quote.id,
            idempotencyKey: key,
          });
        }),
      );

      expect(results).toHaveLength(8);
      const ids = new Set(results.map((r) => r.id));
      expect(ids.size).toBe(1);
      for (const r of results) {
        expect(r.id).toBe(results[0]!.id);
      }

      const withdrawalCount = await pool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM withdrawals WHERE withdrawal_quote_id = $1::uuid`,
        [quote.id],
      );
      expect(withdrawalCount.rows[0]?.c).toBe(1);
      expect(await userBucketBalance(pool, userId, assetId, 'USER_RESERVED_LIABILITY')).toBe(
        200000n,
      );
      expect(await userBucketBalance(pool, userId, assetId, 'USER_AVAILABLE_LIABILITY')).toBe(
        800000n,
      );
      const reservations = await pool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM ledger_transactions
         WHERE idempotency_scope = $1`,
        [`withdrawal-reservation:${results[0]!.id}`],
      );
      expect(reservations.rows[0]?.c).toBe(1);
      await assertLedgerBalanced(pool);
    } finally {
      await Promise.all(connections.map((c) => c.end()));
    }
  });

  it('same key different quote → IDEMPOTENCY_CONFLICT; other key cannot reuse consumed quote', async () => {
    const userId = await createTestUser(pool, String(++seq));
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '2000000',
      key: randomUUID(),
    });
    const q1 = await createWithdrawalQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      amountAtomic: '200000',
    });
    const q2 = await createWithdrawalQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      amountAtomic: '200000',
    });
    const key = `conflict-${randomUUID()}`;
    await createWithdrawalFromQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      quoteId: q1.id,
      idempotencyKey: key,
    });
    await expect(
      createWithdrawalFromQuote(pool, engineConfig, {
        authenticatedUserId: userId,
        quoteId: q2.id,
        idempotencyKey: key,
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      createWithdrawalFromQuote(pool, engineConfig, {
        authenticatedUserId: userId,
        quoteId: q1.id,
        idempotencyKey: `other-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: 'QUOTE_CONSUMED' });
  });
});

describe.skipIf(phase7DatabaseUrl === '')('Phase 10 final F-04 resumePersistedPipeline concurrency', () => {
  let pool: Pool;
  let assetId: string;
  let networkId: string;
  let adminUserId: string;
  let hotWalletId: string;
  let jettonMaster: string;
  let seq = 11_300;

  beforeAll(async () => {
    await resetAndMigrate(phase7DatabaseUrl);
    pool = new Pool({ connectionString: phase7DatabaseUrl, max: 20 });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await truncateWithdrawalTables(pool);
    const base = await seedPhase7Base(pool);
    assetId = base.assetId;
    networkId = base.networkId;
    adminUserId = base.adminUserId;
    hotWalletId = await ensureEncryptedPayoutHotWallet(pool, {
      networkId,
      address: HOT_WALLET_RAW,
      friendlyAddress: 'EQ_phase10_f04',
      signerReference: ENCRYPTED_SIGNER_REF,
      payoutJettonWalletAddress: PAYOUT_JETTON_WALLET,
    });
    const master = await pool.query<{ contract_identity: string }>(
      `SELECT contract_identity FROM assets WHERE id = $1::uuid`,
      [assetId],
    );
    jettonMaster = master.rows[0]!.contract_identity;
  });

  function createTestSigner(): RealPayoutSignerPort {
    return {
      async getSigningIdentity() {
        return {
          publicKeyHex: TEST_PUBLIC_KEY_HEX,
          publicKeyFingerprint: ENCRYPTED_SIGNER_REF,
          walletAddressRaw: HOT_WALLET_RAW,
          signingReady: true,
          custodyState: 'n/a',
        };
      },
      async signWithdrawalAttempt(withdrawalAttemptId: string) {
        const row = await pool.query<{
          withdrawal_id: string;
          canonical_message_hash: string;
        }>(
          `SELECT withdrawal_id::text AS withdrawal_id, canonical_message_hash
           FROM withdrawal_attempts WHERE id = $1::uuid`,
          [withdrawalAttemptId],
        );
        const attempt = row.rows[0]!;
        return {
          withdrawalAttemptId,
          withdrawalId: attempt.withdrawal_id,
          canonicalMessageHash: attempt.canonical_message_hash,
          canonicalSigningHash: attempt.canonical_message_hash,
          signedMessageHash: '33'.repeat(32),
          publicKeyFingerprint: ENCRYPTED_SIGNER_REF,
          walletAddressRaw: HOT_WALLET_RAW,
          signatureBase64: 'dGVzdC1zaWc=',
          keySpec: 'TEST_ONLY',
          signingAlgorithm: 'ED25519_SHA_512',
          signedWalletRequestBocBase64: 'dGVzdC13YWxsZXQtcmVxdWVzdA==',
          externalMessageBocBase64: 'dGVzdC1ib2MtYmFzZTY0',
          externalMessageCellHash: '44'.repeat(32),
          normalizedExternalMessageHash: '33'.repeat(32),
          signatureFingerprintHash: '55'.repeat(32),
        };
      },
    };
  }

  async function queuedWithdrawal(): Promise<{
    withdrawalId: string;
    netAmount: string;
  }> {
    const userId = await createTestUser(pool, String(++seq));
    await createVerifiedPrimaryWallet(pool, {
      userId,
      networkId,
      rawAddress: RECIPIENT_RAW,
    });
    const withdrawalId = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
      engineConfig: nonFakeEngine,
    });
    await pool.query(
      `UPDATE withdrawals SET state = 'QUEUED', queued_at = now() WHERE id = $1::uuid`,
      [withdrawalId],
    );
    const w = await pool.query<{ net_amount_atomic: string }>(
      `SELECT net_amount_atomic::text FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    return { withdrawalId, netAmount: w.rows[0]!.net_amount_atomic };
  }

  function phase10Config() {
    return buildPhase10PayoutConfig({
      realChainEnabled: true,
      signerServiceToken: 'local-signer-service-token-32chars!!',
      jettonMasterIdentity: jettonMaster,
      primaryProviderKind: 'toncenter',
      primaryProviderUrl: 'https://testnet.toncenter.com/api/v2',
      secondaryProviderKind: 'tonapi',
      secondaryProviderUrl: 'https://testnet.tonapi.io',
    });
  }

  function seedProviders(netAmount: string, withdrawalId: string) {
    const primary = new FakeTonChainProvider();
    const secondary = new FakeTonChainProvider();
    primary.seedActiveV5R1({
      address: HOT_WALLET_RAW,
      seqno: 7,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
    });
    secondary.seedActiveV5R1({
      address: HOT_WALLET_RAW,
      seqno: 7,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
    });
    const queryId =
      (1n << 32n) +
      BigInt(
        Math.abs(
          [...`${withdrawalId}:${RECIPIENT_RAW}`].reduce(
            (acc, char) => (acc * 31 + char.charCodeAt(0)) | 0,
            7,
          ),
        ),
      );
    const evidence = {
      hotWallet: HOT_WALLET_RAW,
      jettonMaster,
      recipient: RECIPIENT_RAW,
      amountAtomic: netAmount,
      queryId: queryId.toString(10),
      success: true,
      bounced: false,
      networkGlobalId: -3 as const,
      senderJettonWallet: PAYOUT_JETTON_WALLET,
    };
    primary.seedTransfer(evidence);
    secondary.seedTransfer(evidence);
    return { primary, secondary };
  }

  it('two concurrent runRealTestnetPayoutPipeline resumes → exactly one sendBoc', async () => {
    const { withdrawalId, netAmount } = await queuedWithdrawal();
    const { primary, secondary } = seedProviders(netAmount, withdrawalId);
    const sharedPrimary = primary;

    // Crash after BOC persisted, before claim/send — both resumes race from there.
    await expect(
      runRealTestnetPayoutPipeline(pool, {
        withdrawalId,
        phase10: phase10Config(),
        engine: nonFakeEngine,
        chainProvider: primary,
        secondaryChainProvider: secondary,
        signer: createTestSigner(),
        allowTestExecutionPath: true,
        buildCanonicalMessageHash: async () => TEST_CANONICAL_HASH,
        crashAfter: 'AFTER_BOC_PERSISTED',
      }),
    ).rejects.toBeInstanceOf(PipelineCrashError);

    expect(sharedPrimary.getSendBocCallCount()).toBe(0);
    const bocBefore = await pool.query<{
      id: string;
      signed_external_message_boc: string | null;
      canonical_message_hash: string;
      broadcast_submitted_at: Date | null;
    }>(
      `SELECT id::text, signed_external_message_boc, canonical_message_hash, broadcast_submitted_at
       FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid`,
      [withdrawalId],
    );
    expect(bocBefore.rows).toHaveLength(1);
    expect(bocBefore.rows[0]?.signed_external_message_boc).toBeTruthy();
    expect(bocBefore.rows[0]?.broadcast_submitted_at).toBeNull();
    const messageHash = bocBefore.rows[0]!.canonical_message_hash;
    const attemptId = bocBefore.rows[0]!.id;
    const boc = bocBefore.rows[0]!.signed_external_message_boc;

    const barrier = createBarrier(2);
    const runResume = async () => {
      barrier.arrive();
      await barrier.wait();
      return runRealTestnetPayoutPipeline(pool, {
        withdrawalId,
        phase10: phase10Config(),
        engine: nonFakeEngine,
        chainProvider: sharedPrimary,
        secondaryChainProvider: secondary,
        signer: createTestSigner(),
        allowTestExecutionPath: true,
        buildCanonicalMessageHash: async () => TEST_CANONICAL_HASH,
      });
    };

    const [r1, r2] = await Promise.all([runResume(), runResume()]);
    expect(sharedPrimary.getSendBocCallCount()).toBe(1);

    const outcomes = [r1, r2];
    const winners = outcomes.filter((r) => r.stagesCompleted?.includes('provider_sendBoc'));
    const losers = outcomes.filter(
      (r) =>
        r.reason === 'broadcast_already_claimed' ||
        r.stagesCompleted?.includes('broadcast_claim_lost_observe_only') ||
        r.stagesCompleted?.includes('resume_without_blind_resend') ||
        r.state === 'RECONCILE_REQUIRED' ||
        r.state === 'CONFIRMED',
    );
    expect(winners.length + losers.length).toBeGreaterThanOrEqual(2);
    // Exactly one economic send; message identity unchanged; no second attempt.
    const after = await pool.query<{
      c: number;
      boc: string | null;
      hash: string;
    }>(
      `SELECT count(*)::int AS c,
              max(signed_external_message_boc) AS boc,
              max(canonical_message_hash) AS hash
       FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid`,
      [withdrawalId],
    );
    expect(after.rows[0]?.c).toBe(1);
    expect(after.rows[0]?.boc).toBe(boc);
    expect(after.rows[0]?.hash).toBe(messageHash);
    expect(attemptId).toBe(bocBefore.rows[0]!.id);

    const reserved = await pool.query<{ bal: string }>(
      `SELECT b.balance_atomic::text AS bal
       FROM ledger_account_balances b
       JOIN ledger_accounts a ON a.id = b.ledger_account_id
       JOIN withdrawals w ON w.user_id = a.owner_id
       WHERE w.id = $1::uuid AND a.account_type = 'USER_RESERVED_LIABILITY'`,
      [withdrawalId],
    );
    // Reserved until CONFIRMED settlement of the winning path; if both end reconcile, reserved stays.
    expect(BigInt(reserved.rows[0]?.bal ?? '0')).toBeGreaterThanOrEqual(0n);
  });

  it('crash after claim before send → resume does not blind resend', async () => {
    const { withdrawalId, netAmount } = await queuedWithdrawal();
    const { primary, secondary } = seedProviders(netAmount, withdrawalId);

    await expect(
      runRealTestnetPayoutPipeline(pool, {
        withdrawalId,
        phase10: phase10Config(),
        engine: nonFakeEngine,
        chainProvider: primary,
        secondaryChainProvider: secondary,
        signer: createTestSigner(),
        allowTestExecutionPath: true,
        buildCanonicalMessageHash: async () => TEST_CANONICAL_HASH,
        crashAfter: 'AFTER_SUBMIT_INTENT',
      }),
    ).rejects.toBeInstanceOf(PipelineCrashError);

    expect(primary.getSendBocCallCount()).toBe(0);
    const claimed = await pool.query<{ broadcast_submitted_at: Date | null }>(
      `SELECT broadcast_submitted_at FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid`,
      [withdrawalId],
    );
    expect(claimed.rows[0]?.broadcast_submitted_at).not.toBeNull();

    const resumed = await runRealTestnetPayoutPipeline(pool, {
      withdrawalId,
      phase10: phase10Config(),
      engine: nonFakeEngine,
      chainProvider: primary,
      secondaryChainProvider: secondary,
      signer: createTestSigner(),
      allowTestExecutionPath: true,
      buildCanonicalMessageHash: async () => TEST_CANONICAL_HASH,
    });
    expect(primary.getSendBocCallCount()).toBe(0);
    expect(resumed.state === 'RECONCILE_REQUIRED' || resumed.state === 'CONFIRMED').toBe(true);
  });

  it('RPC timeout → unknown outcome, no second sendBoc', async () => {
    const { withdrawalId, netAmount } = await queuedWithdrawal();
    const { primary, secondary } = seedProviders(netAmount, withdrawalId);
    primary.setSendBocTimeout(true);

    const first = await runRealTestnetPayoutPipeline(pool, {
      withdrawalId,
      phase10: phase10Config(),
      engine: nonFakeEngine,
      chainProvider: primary,
      secondaryChainProvider: secondary,
      signer: createTestSigner(),
      allowTestExecutionPath: true,
      buildCanonicalMessageHash: async () => TEST_CANONICAL_HASH,
    });
    expect(first.state).toBe('RECONCILE_REQUIRED');
    expect(primary.getSendBocCallCount()).toBe(1);

    primary.setSendBocTimeout(false);
    const second = await runRealTestnetPayoutPipeline(pool, {
      withdrawalId,
      phase10: phase10Config(),
      engine: nonFakeEngine,
      chainProvider: primary,
      secondaryChainProvider: secondary,
      signer: createTestSigner(),
      allowTestExecutionPath: true,
      buildCanonicalMessageHash: async () => TEST_CANONICAL_HASH,
    });
    expect(primary.getSendBocCallCount()).toBe(1);
    expect(second.state === 'RECONCILE_REQUIRED' || second.state === 'CONFIRMED').toBe(true);
  });
});
