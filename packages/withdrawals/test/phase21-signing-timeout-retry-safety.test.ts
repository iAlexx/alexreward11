import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { FakeTonChainProvider, deriveWalletV5R1AddressRaw } from '@alex-rewards/ton';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SIGNER_HTTP_SIGN_TIMEOUT_MS,
  SIGNER_HTTP_VALID_UNTIL_MARGIN_MS,
  SIGNING_LATE_COMPLETION_REJECTED,
  SIGNING_RESUME_EXPIRED_NO_BOC_OWNER_RECOVERY,
  SIGNING_RESUME_NO_BOC_OWNER_RECOVERY,
  SignerHttpClient,
  buildPhase10PayoutConfig,
  classifySigningResumeWithoutBoc,
  localWithdrawalEngineFixtureConfig,
  PipelineCrashError,
  resolveSignerHttpTimeoutMs,
  runRealTestnetPayoutPipeline,
  WithdrawalDomainError,
  type RealPayoutSignerPort,
} from '../src/index.js';
import {
  createApprovedWithdrawal,
  createTestUser,
  createVerifiedPrimaryWallet,
  ensureEncryptedPayoutHotWallet,
  phase7DatabaseUrl,
  resetAndMigrate,
  seedPhase7Base,
  truncateWithdrawalTables,
} from './harness.js';

describe('Signer HTTP deadline helpers', () => {
  it('caps timeout to leave margin before valid_until', () => {
    const nowMs = 1_000_000;
    const validUntilMs = nowMs + 90_000;
    expect(
      resolveSignerHttpTimeoutMs({
        nowMs,
        timeoutMs: SIGNER_HTTP_SIGN_TIMEOUT_MS,
        validUntilMs,
        marginMs: SIGNER_HTTP_VALID_UNTIL_MARGIN_MS,
      }),
    ).toBe(45_000);
    // With more room before valid_until, still capped by the configured sign timeout.
    expect(
      resolveSignerHttpTimeoutMs({
        nowMs,
        timeoutMs: SIGNER_HTTP_SIGN_TIMEOUT_MS,
        validUntilMs: nowMs + 200_000,
        marginMs: SIGNER_HTTP_VALID_UNTIL_MARGIN_MS,
      }),
    ).toBe(SIGNER_HTTP_SIGN_TIMEOUT_MS);
    // With less room, margin wins over the configured timeout.
    expect(
      resolveSignerHttpTimeoutMs({
        nowMs,
        timeoutMs: SIGNER_HTTP_SIGN_TIMEOUT_MS,
        validUntilMs: nowMs + 50_000,
        marginMs: SIGNER_HTTP_VALID_UNTIL_MARGIN_MS,
      }),
    ).toBe(20_000);
  });

  it('refuses Signer HTTP when already inside valid_until margin', () => {
    expect(() =>
      resolveSignerHttpTimeoutMs({
        nowMs: 1_000_000,
        timeoutMs: 45_000,
        validUntilMs: 1_000_000 + SIGNER_HTTP_VALID_UNTIL_MARGIN_MS,
        marginMs: SIGNER_HTTP_VALID_UNTIL_MARGIN_MS,
      }),
    ).toThrow(/SIGNER_HTTP_REFUSED_EXPIRED_VALID_UNTIL/);
  });
});

describe('classifySigningResumeWithoutBoc', () => {
  it('marks expired attempts for fail-closed Owner recovery without signing', () => {
    const nowMs = Date.parse('2026-10-12T18:21:50.000Z');
    const classified = classifySigningResumeWithoutBoc({
      validUntil: new Date('2026-10-12T18:21:49.667Z'),
      nowMs,
    });
    expect(classified.expired).toBe(true);
    expect(classified.reason).toBe(SIGNING_RESUME_EXPIRED_NO_BOC_OWNER_RECOVERY);
  });

  it('marks non-expired SIGNING-without-BOC as Owner recovery (no blind re-sign)', () => {
    const nowMs = Date.parse('2026-10-12T18:17:00.000Z');
    const classified = classifySigningResumeWithoutBoc({
      validUntil: new Date('2026-10-12T18:21:49.667Z'),
      nowMs,
    });
    expect(classified.expired).toBe(false);
    expect(classified.reason).toBe(SIGNING_RESUME_NO_BOC_OWNER_RECOVERY);
  });
});

describe('SignerHttpClient bounded I/O', () => {
  it('times out when response headers never arrive', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal == null) {
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          },
          { once: true },
        );
      });
    }) as unknown as typeof fetch;

    const client = new SignerHttpClient({
      baseUrl: 'http://127.0.0.1:3999',
      serviceToken: 'a-secure-local-token-that-is-long-enough',
      fetchImpl,
      signTimeoutMs: 50,
    });

    await expect(client.signWithdrawalAttempt('00000000-0000-4000-8000-000000000001')).rejects.toMatchObject({
      code: 'EXTERNAL_RESOURCE_REQUIRED',
      publicMessage: expect.stringContaining('SIGNER_HTTP_HEADERS_TIMEOUT'),
      details: expect.objectContaining({ phase: 'HEADERS_TIMEOUT', headersReceived: false }),
    });
  });

  it('times out when HTTP 200 headers arrive but body never completes', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const stream = new Readable({
        read() {
          // never push → body hang
        },
      });
      const signal = init?.signal;
      if (signal != null) {
        signal.addEventListener(
          'abort',
          () => {
            stream.destroy(new DOMException('The operation was aborted.', 'AbortError'));
          },
          { once: true },
        );
      }
      return new Response(Readable.toWeb(stream) as never, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const client = new SignerHttpClient({
      baseUrl: 'http://127.0.0.1:3999',
      serviceToken: 'a-secure-local-token-that-is-long-enough',
      fetchImpl,
      signTimeoutMs: 80,
    });

    await expect(client.signWithdrawalAttempt('00000000-0000-4000-8000-000000000001')).rejects.toBeInstanceOf(
      WithdrawalDomainError,
    );
    await expect(client.signWithdrawalAttempt('00000000-0000-4000-8000-000000000001')).rejects.toMatchObject({
      publicMessage: expect.stringContaining('SIGNER_HTTP_BODY_TIMEOUT'),
      details: expect.objectContaining({ phase: 'BODY_TIMEOUT', headersReceived: true }),
    });
  });

  it('respects upstream activity cancellation AbortSignal', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener(
          'abort',
          () => reject(new DOMException('The operation was aborted.', 'AbortError')),
          { once: true },
        );
      });
    }) as unknown as typeof fetch;

    const client = new SignerHttpClient({
      baseUrl: 'http://127.0.0.1:3999',
      serviceToken: 'a-secure-local-token-that-is-long-enough',
      fetchImpl,
      signTimeoutMs: 5_000,
    });

    const pending = client.signWithdrawalAttempt('00000000-0000-4000-8000-000000000001', {
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      publicMessage: expect.stringContaining('SIGNER_HTTP_CANCELLED'),
    });
  });

  it('parses a normal sign response under the deadline', async () => {
    const payload = {
      withdrawalAttemptId: '00000000-0000-4000-8000-000000000001',
      withdrawalId: '00000000-0000-4000-8000-000000000002',
      canonicalMessageHash: 'aa'.repeat(32),
      canonicalSigningHash: 'aa'.repeat(32),
      signedMessageHash: 'bb'.repeat(32),
      normalizedExternalMessageHash: 'bb'.repeat(32),
      publicKeyFingerprint: 'cc'.repeat(32),
      walletAddressRaw: '0:' + 'dd'.repeat(32),
      signatureBase64: 'c2ln',
      keySpec: 'local',
      signingAlgorithm: 'ed25519',
      signedWalletRequestBocBase64: 'd2FsbGV0',
      externalMessageBocBase64: 'ZXh0',
      externalMessageCellHash: 'ee'.repeat(32),
    };
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const client = new SignerHttpClient({
      baseUrl: 'http://127.0.0.1:3999',
      serviceToken: 'a-secure-local-token-that-is-long-enough',
      fetchImpl,
    });
    const signed = await client.signWithdrawalAttempt(payload.withdrawalAttemptId, {
      validUntil: new Date(Date.now() + 120_000),
    });
    expect(signed.externalMessageBocBase64).toBe('ZXh0');
    expect(signed.normalizedExternalMessageHash).toBe(payload.normalizedExternalMessageHash);
  });
});

describe('late-completion rejection token', () => {
  it('exports a stable reason prefix for pipeline guards', () => {
    expect(SIGNING_LATE_COMPLETION_REJECTED).toBe('SIGNING_LATE_COMPLETION_REJECTED');
  });
});

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
const NORMALIZED_HASH = '33'.repeat(32);
const nonFakeEngine = localWithdrawalEngineFixtureConfig({ fakeChainEnabled: false });

describe.skipIf(phase7DatabaseUrl === '')('signing timeout/retry safety (disposable Postgres)', () => {
  let pool: Pool;
  let assetId: string;
  let networkId: string;
  let adminUserId: string;
  let hotWalletId: string;
  let jettonMaster: string;
  let userSequence = 21_100;

  beforeAll(async () => {
    await resetAndMigrate(phase7DatabaseUrl);
    pool = new Pool({ connectionString: phase7DatabaseUrl });
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
      friendlyAddress: 'EQ_phase21_signing_timeout_safety',
      signerReference: ENCRYPTED_SIGNER_REF,
      payoutJettonWalletAddress: PAYOUT_JETTON_WALLET,
    });
    const asset = await pool.query<{ contract_identity: string }>(
      `SELECT contract_identity FROM assets WHERE id = $1::uuid`,
      [assetId],
    );
    jettonMaster = asset.rows[0]!.contract_identity;
  });

  function makeSigner(signCalls: string[]): RealPayoutSignerPort {
    return {
      async getSigningIdentity() {
        return {
          publicKeyHex: TEST_PUBLIC_KEY_HEX,
          publicKeyFingerprint: ENCRYPTED_SIGNER_REF,
          walletAddressRaw: HOT_WALLET_RAW,
          signingReady: true,
          custodyState: 'test',
        };
      },
      async signWithdrawalAttempt(withdrawalAttemptId: string) {
        signCalls.push(withdrawalAttemptId);
        const result = await pool.query<{
          withdrawal_id: string;
          canonical_message_hash: string;
        }>(
          `SELECT withdrawal_id::text, canonical_message_hash
           FROM withdrawal_attempts WHERE id = $1::uuid`,
          [withdrawalAttemptId],
        );
        const attempt = result.rows[0]!;
        return {
          withdrawalAttemptId,
          withdrawalId: attempt.withdrawal_id,
          canonicalMessageHash: attempt.canonical_message_hash,
          canonicalSigningHash: attempt.canonical_message_hash,
          signedMessageHash: NORMALIZED_HASH,
          publicKeyFingerprint: ENCRYPTED_SIGNER_REF,
          walletAddressRaw: HOT_WALLET_RAW,
          signatureBase64: 'dGVzdC1zaWc=',
          keySpec: 'TEST_ONLY',
          signingAlgorithm: 'ED25519_SHA_512',
          signedWalletRequestBocBase64: 'dGVzdC13YWxsZXQtcmVxdWVzdA==',
          externalMessageBocBase64: 'dGVzdC1ib2MtYmFzZTY0',
          externalMessageCellHash: '44'.repeat(32),
          normalizedExternalMessageHash: NORMALIZED_HASH,
          signatureFingerprintHash: '55'.repeat(32),
        };
      },
    };
  }

  async function queueWithdrawal(): Promise<string> {
    const userId = await createTestUser(pool, String(userSequence++));
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
    return withdrawalId;
  }

  function seedProviders(withdrawalId: string, netAmount: string): {
    primary: FakeTonChainProvider;
    secondary: FakeTonChainProvider;
  } {
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
    const primary = new FakeTonChainProvider();
    const secondary = new FakeTonChainProvider();
    primary.seedActiveV5R1({
      address: HOT_WALLET_RAW,
      seqno: 12,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
    });
    secondary.seedActiveV5R1({
      address: HOT_WALLET_RAW,
      seqno: 12,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
    });
    primary.seedTransfer(evidence);
    secondary.seedTransfer(evidence);
    return { primary, secondary };
  }

  it('late cancelled activity cannot persist BOC or broadcast', async () => {
    const withdrawalId = await queueWithdrawal();
    const net = await pool.query<{ net_amount_atomic: string }>(
      `SELECT net_amount_atomic::text FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    const { primary, secondary } = seedProviders(withdrawalId, net.rows[0]!.net_amount_atomic);
    const signCalls: string[] = [];
    const cancelled = new AbortController();
    cancelled.abort();
    const phase10 = buildPhase10PayoutConfig({
      realChainEnabled: true,
      signerServiceToken: 'local-signer-service-token-32chars!!',
      jettonMasterIdentity: jettonMaster,
      primaryProviderKind: 'toncenter',
      primaryProviderUrl: 'https://testnet.toncenter.com/api/v2',
      secondaryProviderKind: 'tonapi',
      secondaryProviderUrl: 'https://testnet.tonapi.io',
    });

    const result = await runRealTestnetPayoutPipeline(pool, {
      withdrawalId,
      phase10,
      engine: nonFakeEngine,
      chainProvider: primary,
      secondaryChainProvider: secondary,
      signer: makeSigner(signCalls),
      allowTestExecutionPath: true,
      buildCanonicalMessageHash: async () => TEST_CANONICAL_HASH,
      cancellationSignal: cancelled.signal,
    });

    expect(result.state).toBe('FAILED_PRE_BROADCAST');
    expect(result.reason).toContain(SIGNING_LATE_COMPLETION_REJECTED);
    expect(signCalls).toHaveLength(1);
    expect(primary.getSendBocCallCount()).toBe(0);

    const attempt = await pool.query<{
      signed_external_message_boc: string | null;
      broadcast_submitted_at: Date | null;
    }>(
      `SELECT signed_external_message_boc, broadcast_submitted_at
       FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid`,
      [withdrawalId],
    );
    expect(attempt.rowCount).toBe(1);
    expect(attempt.rows[0]?.signed_external_message_boc).toBeNull();
    expect(attempt.rows[0]?.broadcast_submitted_at).toBeNull();
  });

  it('expired SIGNING attempt never signs on resume', async () => {
    const withdrawalId = await queueWithdrawal();
    const net = await pool.query<{ net_amount_atomic: string }>(
      `SELECT net_amount_atomic::text FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    const { primary, secondary } = seedProviders(withdrawalId, net.rows[0]!.net_amount_atomic);
    const signCalls: string[] = [];
    const phase10 = buildPhase10PayoutConfig({
      realChainEnabled: true,
      signerServiceToken: 'local-signer-service-token-32chars!!',
      jettonMasterIdentity: jettonMaster,
      primaryProviderKind: 'toncenter',
      primaryProviderUrl: 'https://testnet.toncenter.com/api/v2',
      secondaryProviderKind: 'tonapi',
      secondaryProviderUrl: 'https://testnet.tonapi.io',
    });
    const baseInput = {
      withdrawalId,
      phase10,
      engine: nonFakeEngine,
      chainProvider: primary,
      secondaryChainProvider: secondary,
      signer: makeSigner(signCalls),
      allowTestExecutionPath: true,
      buildCanonicalMessageHash: async () => TEST_CANONICAL_HASH,
    };

    await expect(
      runRealTestnetPayoutPipeline(pool, {
        ...baseInput,
        crashAfter: 'AFTER_SIGNED',
      }),
    ).rejects.toBeInstanceOf(PipelineCrashError);
    expect(signCalls).toHaveLength(1);

    const attemptMeta = await pool.query<{ valid_until: Date }>(
      `SELECT valid_until FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid`,
      [withdrawalId],
    );
    const validUntilMs = attemptMeta.rows[0]!.valid_until.getTime();
    const recovered = await runRealTestnetPayoutPipeline(pool, {
      ...baseInput,
      // Simulate clock past valid_until margin without mutating immutable attempt fields.
      authorityNowMs: validUntilMs - SIGNER_HTTP_VALID_UNTIL_MARGIN_MS + 1,
    });
    expect(recovered.state).toBe('FAILED_PRE_BROADCAST');
    expect(recovered.reason).toBe(SIGNING_RESUME_EXPIRED_NO_BOC_OWNER_RECOVERY);
    expect(signCalls).toHaveLength(1);
    expect(primary.getSendBocCallCount()).toBe(0);
  });

  it('concurrent resume + late path cannot duplicate payout (single attempt, no send)', async () => {
    const withdrawalId = await queueWithdrawal();
    const net = await pool.query<{ net_amount_atomic: string }>(
      `SELECT net_amount_atomic::text FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    const { primary, secondary } = seedProviders(withdrawalId, net.rows[0]!.net_amount_atomic);
    const signCalls: string[] = [];
    const phase10 = buildPhase10PayoutConfig({
      realChainEnabled: true,
      signerServiceToken: 'local-signer-service-token-32chars!!',
      jettonMasterIdentity: jettonMaster,
      primaryProviderKind: 'toncenter',
      primaryProviderUrl: 'https://testnet.toncenter.com/api/v2',
      secondaryProviderKind: 'tonapi',
      secondaryProviderUrl: 'https://testnet.tonapi.io',
    });
    const baseInput = {
      withdrawalId,
      phase10,
      engine: nonFakeEngine,
      chainProvider: primary,
      secondaryChainProvider: secondary,
      signer: makeSigner(signCalls),
      allowTestExecutionPath: true,
      buildCanonicalMessageHash: async () => TEST_CANONICAL_HASH,
    };

    await expect(
      runRealTestnetPayoutPipeline(pool, {
        ...baseInput,
        crashAfter: 'AFTER_SIGNED',
      }),
    ).rejects.toBeInstanceOf(PipelineCrashError);
    expect(signCalls).toHaveLength(1);

    // Automatic resume fail-closes without a second Signer POST.
    const resumed = await runRealTestnetPayoutPipeline(pool, baseInput);
    expect(resumed.state).toBe('FAILED_PRE_BROADCAST');
    expect(resumed.reason).toMatch(/SIGNING_RESUME_.*OWNER_RECOVERY/);
    expect(signCalls).toHaveLength(1);
    expect(primary.getSendBocCallCount()).toBe(0);

    const attempts = await pool.query<{
      c: string;
      boc: string | null;
      broadcast_submitted_at: Date | null;
    }>(
      `SELECT count(*)::text AS c,
              max(signed_external_message_boc) AS boc,
              max(broadcast_submitted_at) AS broadcast_submitted_at
       FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid`,
      [withdrawalId],
    );
    expect(attempts.rows[0]?.c).toBe('1');
    expect(attempts.rows[0]?.boc).toBeNull();
    expect(attempts.rows[0]?.broadcast_submitted_at).toBeNull();

    const wd = await pool.query<{ state: string }>(
      `SELECT state::text FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    expect(wd.rows[0]?.state).toBe('FAILED_PRE_BROADCAST');

    // Late completion guard (already covered by cancelled-signal test): with no BOC
    // and FAILED_PRE, nothing remains to broadcast. Re-invoking the pipeline would
    // intentionally re-queue FAILED_PRE for a *new* attempt (Owner/workflow path),
    // which Temporal maximumAttempts:1 prevents after activity timeout.
  });

  it('normal signing persists BOC before any broadcast', async () => {
    const withdrawalId = await queueWithdrawal();
    const net = await pool.query<{ net_amount_atomic: string }>(
      `SELECT net_amount_atomic::text FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    const { primary, secondary } = seedProviders(withdrawalId, net.rows[0]!.net_amount_atomic);
    const signCalls: string[] = [];
    const phase10 = buildPhase10PayoutConfig({
      realChainEnabled: true,
      signerServiceToken: 'local-signer-service-token-32chars!!',
      jettonMasterIdentity: jettonMaster,
      primaryProviderKind: 'toncenter',
      primaryProviderUrl: 'https://testnet.toncenter.com/api/v2',
      secondaryProviderKind: 'tonapi',
      secondaryProviderUrl: 'https://testnet.tonapi.io',
    });

    const result = await runRealTestnetPayoutPipeline(pool, {
      withdrawalId,
      phase10,
      engine: nonFakeEngine,
      chainProvider: primary,
      secondaryChainProvider: secondary,
      signer: makeSigner(signCalls),
      allowTestExecutionPath: true,
      buildCanonicalMessageHash: async () => TEST_CANONICAL_HASH,
    });

    expect(result.state).toBe('CONFIRMED');
    expect(result.stagesCompleted).toEqual(
      expect.arrayContaining([
        'signer_attempt_id_signing',
        'persist_signed_boc_before_send',
        'provider_sendBoc',
      ]),
    );
    const persistIdx = result.stagesCompleted!.indexOf('persist_signed_boc_before_send');
    const sendIdx = result.stagesCompleted!.indexOf('provider_sendBoc');
    expect(persistIdx).toBeGreaterThanOrEqual(0);
    expect(sendIdx).toBeGreaterThan(persistIdx);
    expect(signCalls).toHaveLength(1);
    expect(primary.getSendBocCallCount()).toBe(1);

    const attempt = await pool.query<{
      signed_external_message_boc: string | null;
      normalized_external_message_hash: string | null;
    }>(
      `SELECT signed_external_message_boc, normalized_external_message_hash
       FROM withdrawal_attempts WHERE id = $1::uuid`,
      [result.attemptId],
    );
    expect(attempt.rows[0]?.signed_external_message_boc).toBe('dGVzdC1ib2MtYmFzZTY0');
    expect(attempt.rows[0]?.normalized_external_message_hash).toBe(NORMALIZED_HASH);
  });
});
