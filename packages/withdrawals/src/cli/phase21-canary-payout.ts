#!/usr/bin/env node
/**
 * Phase 21 Mainnet canary payout CLI.
 *
 * PLAN (default / --plan): read-only. Proves canary preconditions.
 * APPLY: designed but refused — not enabled in this source slice.
 *
 * Never unlocks signer, never signs, never broadcasts, never mutates flags/DB/Railway.
 */
import { Pool } from 'pg';

import {
  PHASE21_CANARY_PAYOUT_APPLY_ENABLED,
  PHASE21_CANARY_PAYOUT_FUTURE_APPLY_DESIGN,
  PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
  observePhase21CanaryPayoutEnv,
  planPhase21CanaryPayout,
  probePhase21CanarySignerLockedReadOnly,
  refusePhase21CanaryPayoutApply,
} from '../phase21-canary-payout-plan.js';

function usage(exitCode = 2): never {
  console.error(
    JSON.stringify(
      {
        ok: false,
        message:
          'usage: phase21-canary-payout --plan --withdrawal-id <uuid>  |  phase21-canary-payout --apply (REFUSED)',
        soleAuthorizedWithdrawalId: PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
        applyEnabled: PHASE21_CANARY_PAYOUT_APPLY_ENABLED,
        readyForLivePayout: false,
      },
      null,
      2,
    ),
  );
  process.exit(exitCode);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function envNonEmpty(name: string): string | null {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

function readFlag(argv: ReadonlyArray<string>, name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx < 0) return undefined;
  return argv[idx + 1];
}

function hasSwitch(argv: ReadonlyArray<string>, name: string): boolean {
  return argv.includes(name);
}

async function assertLivePlanDatabaseOrRefuse(
  command: string,
): Promise<{ pool: Pool; currentDatabase: string } | null> {
  const url = envNonEmpty('DATABASE_URL');
  if (url === null) {
    printJson({
      ok: false,
      command,
      refuseCode: 'LIVE_DATABASE_REQUIRED_FOR_PLAN',
      message: 'DATABASE_URL required for live PLAN (no silent mock empty-DB plan)',
      readyForLivePayout: false,
      applied: false,
      mutated: false,
      signed: false,
      broadcast: false,
    });
    process.exitCode = 1;
    return null;
  }
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    const row = await client.query<{ name: string }>(`SELECT current_database() AS name`);
    const currentDatabase = row.rows[0]?.name ?? '';
    const requiredDatabase = envNonEmpty('PHASE21_CEREMONY_REQUIRED_DATABASE_NAME');
    if (requiredDatabase !== null && currentDatabase !== requiredDatabase) {
      printJson({
        ok: false,
        command,
        refuseCode: 'PLAN_DATABASE_IDENTITY_MISMATCH',
        message: 'current_database does not match PHASE21_CEREMONY_REQUIRED_DATABASE_NAME',
        current_database: currentDatabase,
        required_database: requiredDatabase,
        readyForLivePayout: false,
        applied: false,
        mutated: false,
        signed: false,
        broadcast: false,
      });
      process.exitCode = 1;
      await pool.end();
      return null;
    }
    return { pool, currentDatabase };
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || hasSwitch(argv, '--help')) {
    usage(argv.length === 0 ? 2 : 0);
  }

  const wantsApply = hasSwitch(argv, '--apply');
  const wantsPlan = hasSwitch(argv, '--plan') || !wantsApply;

  if (wantsApply) {
    printJson({
      ...refusePhase21CanaryPayoutApply(),
      command: 'phase21:canary-payout',
      futureApplyDesign: PHASE21_CANARY_PAYOUT_FUTURE_APPLY_DESIGN,
    });
    process.exitCode = 1;
    return;
  }

  if (!wantsPlan) {
    usage();
  }

  const withdrawalId = readFlag(argv, '--withdrawal-id');
  if (withdrawalId === undefined || withdrawalId.trim() === '') {
    usage();
  }

  const live = await assertLivePlanDatabaseOrRefuse('phase21:canary-payout');
  if (live === null) return;

  const env = observePhase21CanaryPayoutEnv();
  const signerProbe = await probePhase21CanarySignerLockedReadOnly(env.signerBaseUrl);

  const client = await live.pool.connect();
  try {
    const result = await planPhase21CanaryPayout(client, {
      withdrawalId: withdrawalId.trim(),
      env,
      signerProbe,
    });
    printJson({
      ...result,
      command: 'phase21:canary-payout',
      current_database: live.currentDatabase,
      productionMutationOccurred: false,
      signerActionOccurred: false,
      broadcastOccurred: false,
    });
    if (!result.ok) {
      process.exitCode = 1;
    }
  } finally {
    client.release();
    await live.pool.end();
  }
}

main().catch((error: unknown) => {
  printJson({
    ok: false,
    command: 'phase21:canary-payout',
    refuseCode: 'PLAN_UNEXPECTED_ERROR',
    message: error instanceof Error ? error.message : String(error),
    readyForLivePayout: false,
    applied: false,
    mutated: false,
    signed: false,
    broadcast: false,
    productionMutationOccurred: false,
    signerActionOccurred: false,
    broadcastOccurred: false,
  });
  process.exitCode = 1;
});
