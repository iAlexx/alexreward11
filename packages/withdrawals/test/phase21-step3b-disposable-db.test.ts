/**
 * Disposable DB apply proofs for Phase 21 Step 3B.
 * Uses PHASE4_DATABASE_URL (or PHASE4_LEDGER_TESTS=1 + DATABASE_URL).
 * Temporarily sets production ceremony env gates against disposable DB name identity.
 */
import { Client, Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  assertConnectedDestructiveTestDatabase,
  assertSafeDestructiveTestDatabaseUrl,
  migrateDatabase,
} from '@alex-rewards/db';

import { __phase21TestSetApplyEnv } from '../src/phase21-ceremony-apply-gates.js';
import {
  applyPhase21ProductionFlagBaseline,
  PHASE21_PRODUCTION_FLAG_BASELINE,
  planPhase21ProductionFlagBaseline,
} from '../src/phase21-production-flag-baseline.js';
import { mintAuthenticatedPhase21OwnerCeremonyTrustForTests } from '../src/test-only/phase21-ceremony-test-hooks.js';
import {
  applyPhase21MainnetRegistryBootstrap,
  planPhase21MainnetRegistryBootstrap,
} from '../src/phase21-mainnet-registry-bootstrap.js';

const explicitUrl = process.env.PHASE4_DATABASE_URL ?? process.env.PHASE20_DATABASE_URL ?? '';
const optedInUrl =
  process.env.PHASE4_LEDGER_TESTS === '1' ? (process.env.DATABASE_URL ?? '') : '';
const databaseUrl = explicitUrl !== '' ? explicitUrl : optedInUrl;

const describeDb = databaseUrl === '' ? describe.skip : describe;

async function seedOwnerAdmin(pool: Pool): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, display_name, status)
     VALUES ($1, 'Phase21 Step3C Owner', 'ACTIVE')
     RETURNING id`,
    [`phase21-step3c-owner-${Date.now()}@example.local`],
  );
  const adminUserId = result.rows[0]?.id;
  if (adminUserId === undefined) throw new Error('admin insert failed');
  const role = await pool.query<{ id: string }>(
    `SELECT id FROM admin_roles WHERE code = 'OWNER' AND status = 'ACTIVE'`,
  );
  const roleId = role.rows[0]?.id;
  if (roleId === undefined) throw new Error('OWNER role missing');
  await pool.query(
    `INSERT INTO admin_role_bindings (admin_user_id, role_id)
     VALUES ($1::uuid, $2::uuid)
     ON CONFLICT DO NOTHING`,
    [adminUserId, roleId],
  );
  return adminUserId;
}


const USDT_MASTER = 'EQD0vdSA_NedR9uvbgN9EikRX-suesDxGeFg69XQMavfLqIw';

const envKeys = [
  'DEPLOYMENT_ENV',
  'PHASE21_OPERATIONAL_CEREMONY_ENABLED',
  'PHASE21_PRODUCTION_FLAG_BASELINE_APPLY',
  'PHASE21_MAINNET_REGISTRY_BOOTSTRAP_APPLY',
  'PHASE21_CEREMONY_REQUIRED_DATABASE_NAME',
] as const;

async function resetAndMigrate(url: string): Promise<void> {
  assertSafeDestructiveTestDatabaseUrl(url);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await assertConnectedDestructiveTestDatabase(client);
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query('GRANT ALL ON SCHEMA public TO PUBLIC');
  } finally {
    await client.end();
  }
  await migrateDatabase(url);
}

describeDb('phase21 step3b disposable DB apply', () => {
  let pool: Pool;
  let dbName: string;
  let ownerAdminId: string;
  const prev: Record<string, string | undefined> = {};

  beforeAll(async () => {
    await resetAndMigrate(databaseUrl);
    pool = new Pool({ connectionString: databaseUrl });
    const row = await pool.query<{ name: string }>(`SELECT current_database() AS name`);
    dbName = row.rows[0]!.name;
    ownerAdminId = await seedOwnerAdmin(pool);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(() => {
    for (const k of envKeys) prev[k] = process.env[k];
  });

  afterEach(async () => {
    for (const k of envKeys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    // audit_logs is append-only — do not DELETE; isolate via cascaded flag/network cleanup.
    await pool.query(`DELETE FROM feature_flags WHERE environment = 'PRODUCTION'`);
    await pool.query(`DELETE FROM withdrawal_limit_rules`);
    await pool.query(`DELETE FROM withdrawal_fee_rules`);
    await pool.query(`DELETE FROM assets WHERE symbol IN ('USDT', 'GRAM')`);
    await pool.query(`DELETE FROM networks WHERE code = 'TON_MAINNET'`);
  });

  async function mintOwnerTrust(client: { query: (text: string, params?: unknown[]) => Promise<{ rows: Array<{ sid?: string; name?: string }> }> }) {
    const sid = await client.query(`SELECT system_identifier::text AS sid FROM pg_control_system()`);
    const db = await client.query(`SELECT current_database() AS name`);
    process.env.PHASE21_CEREMONY_REQUIRED_SYSTEM_IDENTIFIER = String(sid.rows[0]?.sid ?? '');
    process.env.ALEX_PHASE21_CEREMONY_TEST_HOOKS = '1';
    return mintAuthenticatedPhase21OwnerCeremonyTrustForTests({
      adminUserId: ownerAdminId,
      currentDatabase: String(db.rows[0]?.name ?? ''),
      systemIdentifier: String(sid.rows[0]?.sid ?? ''),
    });
  }

  function setProductionGates(tool: 'flags' | 'registry'): void {
    __phase21TestSetApplyEnv({
      DEPLOYMENT_ENV: 'production',
      PHASE21_OPERATIONAL_CEREMONY_ENABLED: 'true',
      PHASE21_CEREMONY_REQUIRED_DATABASE_NAME: dbName,
      PHASE21_PRODUCTION_FLAG_BASELINE_APPLY: tool === 'flags' ? '1' : '0',
      PHASE21_MAINNET_REGISTRY_BOOTSTRAP_APPLY: tool === 'registry' ? '1' : '0',
    });
  }

  it('flag baseline apply is atomic with versions; second run ALREADY_MATCHES', async () => {
    setProductionGates('flags');
    const client = await pool.connect();
    try {
      const first = await applyPhase21ProductionFlagBaseline(client, {
        reason: 'phase21-step3b-disposable-flag-baseline',
        ownerTrust: await mintOwnerTrust(client),
      });
      expect(first.applied).toBe(true);
      expect(first.createdCount).toBe(PHASE21_PRODUCTION_FLAG_BASELINE.length);

      const versions = await client.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM feature_flag_versions`,
      );
      expect(versions.rows[0]!.c).toBe(PHASE21_PRODUCTION_FLAG_BASELINE.length);

      const audits = await client.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM audit_logs
         WHERE action_type = 'phase21.production_flag_baseline.create'`,
      );
      expect(audits.rows[0]!.c).toBeGreaterThanOrEqual(PHASE21_PRODUCTION_FLAG_BASELINE.length);

      const second = await applyPhase21ProductionFlagBaseline(client, {
        reason: 'phase21-step3b-disposable-flag-baseline-retry',
        ownerTrust: await mintOwnerTrust(client),
      });
      expect(second.applied).toBe(true);
      expect(second.createdCount).toBe(0);
      expect(second.rows.every((r) => r.action === 'ALREADY_MATCHES')).toBe(true);
    } finally {
      client.release();
    }
  });

  it('flag baseline rolls back on mid-apply failure', async () => {
    setProductionGates('flags');
    const client = await pool.connect();
    try {
      // Pre-insert a conflicting row that will only be seen after lock/plan if we poison CREATE path:
      // Instead: create one matching row, then force a conflict by inserting wrong enabled mid-loop via trigger.
      await client.query(
        `CREATE OR REPLACE FUNCTION phase21_fail_second_flag() RETURNS trigger AS $$
         BEGIN
           IF (SELECT COUNT(*) FROM feature_flags WHERE environment = 'PRODUCTION') >= 1 THEN
             RAISE EXCEPTION 'phase21_injected_fail';
           END IF;
           RETURN NEW;
         END;
         $$ LANGUAGE plpgsql`,
      );
      await client.query(`DROP TRIGGER IF EXISTS trg_phase21_fail_second_flag ON feature_flags`);
      await client.query(
        `CREATE TRIGGER trg_phase21_fail_second_flag
         BEFORE INSERT ON feature_flags
         FOR EACH ROW EXECUTE FUNCTION phase21_fail_second_flag()`,
      );

      try {
        const result = await applyPhase21ProductionFlagBaseline(client, {
          reason: 'phase21-step3b-rollback',
          ownerTrust: await mintOwnerTrust(client),
        });
        expect(result.applied).toBe(false);
        expect(result.refuseCode).toBe('APPLY_EXCEPTION');

        const flags = await client.query<{ c: number }>(
          `SELECT COUNT(*)::int AS c FROM feature_flags WHERE environment = 'PRODUCTION'`,
        );
        expect(flags.rows[0]!.c).toBe(0);
      } finally {
        await client.query(`DROP TRIGGER IF EXISTS trg_phase21_fail_second_flag ON feature_flags`);
        await client.query(`DROP FUNCTION IF EXISTS phase21_fail_second_flag()`);
      }

    } finally {
      client.release();
    }
  });

  it('registry zero-to-complete in one apply; second run ALREADY_MATCHES', async () => {
    setProductionGates('registry');
    const client = await pool.connect();
    try {
      const planned = await planPhase21MainnetRegistryBootstrap(client, {
        usdtJettonMaster: USDT_MASTER,
      });
      expect(planned.filter((i) => i.action === 'CREATE').length).toBeGreaterThanOrEqual(5);

      const first = await applyPhase21MainnetRegistryBootstrap(client, {
        usdtJettonMaster: USDT_MASTER,
        ownerTrust: await mintOwnerTrust(client),
        reason: 'phase21-step3c-disposable-registry',
      });
      expect(first.applied).toBe(true);

      const regAudits = await client.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM audit_logs
         WHERE action_type = 'phase21.mainnet_registry.bootstrap'`,
      );
      expect(regAudits.rows[0]!.c).toBeGreaterThanOrEqual(1);

      const verified = await planPhase21MainnetRegistryBootstrap(client, {
        usdtJettonMaster: USDT_MASTER,
      });
      expect(
        verified.every(
          (i) => i.action === 'ALREADY_MATCHES' || i.action === 'DOCUMENTED_ONLY',
        ),
      ).toBe(true);

      const second = await applyPhase21MainnetRegistryBootstrap(client, {
        usdtJettonMaster: USDT_MASTER,
        ownerTrust: await mintOwnerTrust(client),
        reason: 'phase21-step3c-disposable-registry',
      });
      expect(second.applied).toBe(true);
      expect(
        second.items.every(
          (i) => i.action === 'ALREADY_MATCHES' || i.action === 'DOCUMENTED_ONLY',
        ),
      ).toBe(true);
    } finally {
      client.release();
    }
  });
});
