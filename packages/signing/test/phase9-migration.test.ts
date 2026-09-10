import { beforeAll, describe, expect, it } from 'vitest';

import { createPool, phase9DatabaseUrl, resetAndMigrate } from './harness.js';

const describePhase9 = phase9DatabaseUrl ? describe : describe.skip;

describePhase9('Phase 9 migration 0020', () => {
  beforeAll(async () => {
    await resetAndMigrate(phase9DatabaseUrl);
  }, 120_000);

  it('records migration 0020 and exposes signer view + jetton wallet column', async () => {
    const pool = createPool(phase9DatabaseUrl);
    try {
      const migrations = await pool.query<{ version: string }>(
        `SELECT version FROM schema_migrations WHERE version = '0020_signer_read_boundary'`,
      );
      expect(migrations.rowCount).toBe(1);
      const col = await pool.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_name = 'hot_wallets' AND column_name = 'payout_jetton_wallet_address'`,
      );
      expect(col.rowCount).toBe(1);
      const view = await pool.query(`SELECT 1 FROM signer_withdrawal_attempt_signing_v LIMIT 0`);
      expect(view.rows).toEqual([]);
      const role = await pool.query(`SELECT 1 FROM pg_roles WHERE rolname = 'alex_rewards_signer_ro'`);
      expect(role.rowCount).toBe(1);
    } finally {
      await pool.end();
    }
  });
});
