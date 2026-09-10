import { beforeAll, describe, expect, it } from 'vitest';

import { createPool, phase9DatabaseUrl, resetAndMigrate } from './harness.js';

const describePhase9 = phase9DatabaseUrl ? describe : describe.skip;

describePhase9('Phase 9 signer DB read-only role', () => {
  beforeAll(async () => {
    await resetAndMigrate(phase9DatabaseUrl);
  }, 120_000);

  it('SELECT on signing view allowed; INSERT/UPDATE financial tables denied', async () => {
    const admin = createPool(phase9DatabaseUrl);
    const dbName = new URL(phase9DatabaseUrl).pathname.replace(/^\//, '');
    try {
      await admin.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'phase9_signer_login') THEN
            CREATE ROLE phase9_signer_login LOGIN PASSWORD 'phase9-signer-ro-only';
          END IF;
        END $$;
      `);
      await admin.query(`GRANT alex_rewards_signer_ro TO phase9_signer_login`);
      await admin.query(`GRANT CONNECT ON DATABASE "${dbName}" TO phase9_signer_login`);
      await admin.query(`GRANT USAGE ON SCHEMA public TO phase9_signer_login`);
      await admin.query(
        `GRANT SELECT ON TABLE signer_withdrawal_attempt_signing_v TO phase9_signer_login`,
      );
    } finally {
      await admin.end();
    }

    const url = new URL(phase9DatabaseUrl);
    url.username = 'phase9_signer_login';
    url.password = 'phase9-signer-ro-only';
    const signerPool = createPool(url.toString());
    try {
      await expect(
        signerPool.query(`SELECT 1 FROM signer_withdrawal_attempt_signing_v LIMIT 1`),
      ).resolves.toBeTruthy();
      await expect(signerPool.query(`INSERT INTO networks DEFAULT VALUES`)).rejects.toBeTruthy();
      await expect(
        signerPool.query(`UPDATE hot_wallets SET label = 'x' WHERE false`),
      ).rejects.toBeTruthy();
      await expect(
        signerPool.query(`DELETE FROM withdrawal_attempts WHERE false`),
      ).rejects.toBeTruthy();
    } finally {
      await signerPool.end();
    }
  });
});
