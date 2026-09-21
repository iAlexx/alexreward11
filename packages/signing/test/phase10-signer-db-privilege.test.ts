/**
 * Phase 10 S-05: dedicated signer LOGIN privilege isolation.
 * Destructive against PHASE9_DATABASE_URL / opted-in disposable DB only.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import {
  assertSignerDatabaseReadBoundary,
  inspectSignerDatabasePrivileges,
  SignerError,
} from '../src/index.js';
import { createPool, phase9DatabaseUrl, resetAndMigrate } from './harness.js';

const SIGNER_PASSWORD = 'local-signer-ro-only-test';
const describePhase9 = phase9DatabaseUrl ? describe : describe.skip;

describePhase9('Phase 10 S-05 signer DB privilege isolation', () => {
  beforeAll(async () => {
    await resetAndMigrate(phase9DatabaseUrl);
  }, 180_000);

  it('migration creates alex_rewards_signer LOGIN inheriting RO role', async () => {
    const admin = createPool(phase9DatabaseUrl);
    try {
      const role = await admin.query<{
        rolcanlogin: boolean;
        rolsuper: boolean;
        rolcreaterole: boolean;
        rolcreatedb: boolean;
      }>(
        `SELECT rolcanlogin, rolsuper, rolcreaterole, rolcreatedb
         FROM pg_roles WHERE rolname = 'alex_rewards_signer'`,
      );
      expect(role.rows[0]?.rolcanlogin).toBe(true);
      expect(role.rows[0]?.rolsuper).toBe(false);
      expect(role.rows[0]?.rolcreaterole).toBe(false);
      expect(role.rows[0]?.rolcreatedb).toBe(false);
      const inherit = await admin.query<{ ok: boolean }>(
        `SELECT pg_has_role('alex_rewards_signer', 'alex_rewards_signer_ro', 'USAGE') AS ok`,
      );
      expect(inherit.rows[0]?.ok).toBe(true);
    } finally {
      await admin.end();
    }
  });

  it('provisioned signer can SELECT view; denied DML/DDL/escalation', async () => {
    const admin = createPool(phase9DatabaseUrl);
    const dbName = new URL(phase9DatabaseUrl).pathname.replace(/^\//, '');
    try {
      await admin.query(
        `ALTER ROLE alex_rewards_signer WITH LOGIN PASSWORD '${SIGNER_PASSWORD.replace(/'/g, "''")}'`,
      );
      await admin.query(`GRANT CONNECT ON DATABASE "${dbName}" TO alex_rewards_signer`);
      await admin.query(`GRANT USAGE ON SCHEMA public TO alex_rewards_signer`);
      await admin.query(
        `GRANT SELECT ON TABLE signer_withdrawal_attempt_signing_v TO alex_rewards_signer`,
      );
    } finally {
      await admin.end();
    }

    const url = new URL(phase9DatabaseUrl);
    url.username = 'alex_rewards_signer';
    url.password = SIGNER_PASSWORD;
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
      await expect(
        signerPool.query(`TRUNCATE ledger_entries`),
      ).rejects.toBeTruthy();
      await expect(
        signerPool.query(`CREATE TABLE signer_escalation_probe (id int)`),
      ).rejects.toBeTruthy();
      await expect(
        signerPool.query(`GRANT alex_rewards_signer TO CURRENT_USER`),
      ).rejects.toBeTruthy();

      await expect(assertSignerDatabaseReadBoundary(signerPool)).resolves.toBeUndefined();
      const snap = await inspectSignerDatabasePrivileges(signerPool);
      expect(snap.writableFinancialTables).toEqual([]);
      expect(snap.isSuperuser).toBe(false);
    } finally {
      await signerPool.end();
    }
  });

  it('privileged admin credentials are rejected by fail-closed assert', async () => {
    const admin = createPool(phase9DatabaseUrl);
    try {
      await expect(assertSignerDatabaseReadBoundary(admin)).rejects.toBeInstanceOf(SignerError);
      await expect(assertSignerDatabaseReadBoundary(admin)).rejects.toMatchObject({
        code: 'CONFIG',
      });
    } finally {
      await admin.end();
    }
  });
});
