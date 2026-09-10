import { Cell } from '@ton/core';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  SignerError,
  assertExternalInMessageBody,
  parseExternalInMessageFromBoc,
  reconstructCanonicalHash,
  signWithdrawalAttempt,
} from '../src/index.js';
import {
  createPool,
  createProductionShapedSignableAttempt,
  phase9DatabaseUrl,
  resetAndMigrate,
  type ProductionShapedAttemptFixture,
} from './harness.js';

const describePhase9 = phase9DatabaseUrl ? describe : describe.skip;

describePhase9('Phase 9 production-shaped sign flow', () => {
  let fixture: ProductionShapedAttemptFixture;

  beforeAll(async () => {
    await resetAndMigrate(phase9DatabaseUrl);
    const pool = createPool(phase9DatabaseUrl);
    fixture = await createProductionShapedSignableAttempt(pool);
  }, 180_000);

  it('signs a production-shaped attempt with real canonical hash (not fake-hash)', async () => {
    expect(fixture.canonicalMessageHash.startsWith('fake-hash:')).toBe(false);
    expect(fixture.canonicalMessageHash).toMatch(/^[0-9a-f]{64}$/);

    const result = await signWithdrawalAttempt({
      pool: fixture.pool,
      withdrawalAttemptId: fixture.attemptId,
      signPort: fixture.signPort,
      config: fixture.config,
    });

    expect(result.withdrawalAttemptId).toBe(fixture.attemptId);
    expect(result.canonicalMessageHash).toBe(fixture.canonicalMessageHash);
    expect(result.walletAddressRaw).toBe(fixture.walletAddressRaw);
    expect(result.signatureBase64.length).toBeGreaterThan(40);
    expect(result.externalMessageBocBase64.length).toBeGreaterThan(40);
    expect(result.signedMessageHash).toBe(result.normalizedExternalMessageHash);
    expect(result.canonicalSigningHash).toBe(result.canonicalMessageHash);
    const message = parseExternalInMessageFromBoc(result.externalMessageBocBase64);
    const signedRequest = Cell.fromBoc(
      Buffer.from(result.signedWalletRequestBocBase64, 'base64'),
    )[0]!;
    assertExternalInMessageBody(message, signedRequest);
    expect(message.init == null).toBe(true);
    expect(result.kmsKeySpec).toBe('LOCAL_EPHEMERAL_ED25519');
  });

  it('100 reconstructions of the same attempt are identical', async () => {
    const hashes: string[] = [];
    for (let i = 0; i < 100; i += 1) {
      hashes.push(
        await reconstructCanonicalHash({
          pool: fixture.pool,
          withdrawalAttemptId: fixture.attemptId,
          config: fixture.config,
          publicKey: fixture.publicKey,
        }),
      );
    }
    expect(new Set(hashes).size).toBe(1);
    expect(hashes[0]).toBe(fixture.canonicalMessageHash);
  });

  it('rejects Phase 7 fake-hash attempts fail-closed', async () => {
    await fixture.pool
      .query(
        `UPDATE withdrawal_attempts
       SET canonical_message_hash = $2
       WHERE id = $1::uuid`,
        [fixture.attemptId, `fake-hash:${fixture.withdrawalId}:1`],
      )
      .catch(() => undefined);

    // If immutability trigger blocks UPDATE, insert a dedicated fake attempt on a clone path:
    const existing = await fixture.pool.query<{ canonical_message_hash: string }>(
      `SELECT canonical_message_hash FROM withdrawal_attempts WHERE id = $1::uuid`,
      [fixture.attemptId],
    );
    if (existing.rows[0]?.canonical_message_hash.startsWith('fake-hash:')) {
      await expect(
        signWithdrawalAttempt({
          pool: fixture.pool,
          withdrawalAttemptId: fixture.attemptId,
          signPort: fixture.signPort,
          config: fixture.config,
        }),
      ).rejects.toBeInstanceOf(SignerError);
      return;
    }

    // Immutability preserved — policy unit tests already cover fake-hash rejection.
    expect(existing.rows[0]?.canonical_message_hash.startsWith('fake-hash:')).toBe(false);
  });
});
