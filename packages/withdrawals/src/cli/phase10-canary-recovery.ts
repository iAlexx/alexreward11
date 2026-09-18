#!/usr/bin/env node
/**
 * Narrow Owner-gated Phase 10 canary recovery CLI.
 *
 * Default: dry-run (plan/inspect only).
 *
 * Mutate requires:
 *   --mode mutate
 *   --confirmation-phrase PHASE10_OWNER_RECOVERY_SIGNING_ZERO_ATTEMPTS
 *     (intent confirmation ONLY — not authentication)
 *   --owner-admin-user-id <ACTIVE admin_users.id with unrevoked OWNER binding>
 *   --owner-session-token <raw admin_sessions secret for that Owner>
 *     (trusted authenticated session + recent reauthentication)
 *   --temporal-terminated-confirmed
 *   --payout-worker-stopped-confirmed
 *   --withdrawal-id 01a0afbd-2550-742b-967d-5aec6ee75a83
 *   For operational DB alex_rewards also:
 *     PHASE10_CANARY_RECOVERY_OPERATIONAL_MUTATION_CONFIRM=I_CONFIRM_OPERATIONAL_ALEX_REWARDS_CANARY_RECOVERY
 *
 * CI/GitHub Actions cannot mutate operational recovery. Never unlocks Signer, never
 * enables real/fake chain, never broadcasts, never terminates Temporal, never starts
 * a workflow.
 */
import { createDatabasePool } from '@alex-rewards/db';
import { loadWorkerConfig } from '@alex-rewards/config';

import {
  PHASE10_CANARY_RECOVERY_CONFIRMATION_PHRASE,
  PHASE10_CANARY_RECOVERY_OPERATIONAL_MUTATION_CONFIRM,
  PHASE10_CANARY_RECOVERY_WITHDRAWAL_ID,
  executePhase10CanarySigningZeroAttemptsRecovery,
  isPhase10CanaryRecoveryCiEnvironment,
  planPhase10CanarySigningZeroAttemptsRecovery,
} from '../phase10-canary-signing-recovery.js';

function usage(exitCode = 2): never {
  console.error(
    JSON.stringify(
      {
        ok: false,
        message:
          'usage: phase10-canary-recovery --withdrawal-id <uuid> [--mode dry-run|mutate] [--confirmation-phrase <phrase>] --owner-admin-user-id <uuid> --owner-session-token <secret> [--expected-fencing-token <n>] [--temporal-terminated-confirmed] [--payout-worker-stopped-confirmed]',
        soleAuthorizedWithdrawalId: PHASE10_CANARY_RECOVERY_WITHDRAWAL_ID,
        confirmationPhrase: PHASE10_CANARY_RECOVERY_CONFIRMATION_PHRASE,
        confirmationIsNotAuthentication: true,
        ownerAdminUserIdRequiredForMutate: true,
        ownerSessionTokenRequiredForMutate: true,
        ownerRoleBindingRequired: 'OWNER',
        recentReauthenticationRequired: true,
        operationalMutationConfirm: PHASE10_CANARY_RECOVERY_OPERATIONAL_MUTATION_CONFIRM,
        defaultMode: 'dry-run',
        ciCannotMutateOperationalRecovery: true,
      },
      null,
      2,
    ),
  );
  process.exit(exitCode);
}

function readFlag(argv: ReadonlyArray<string>, name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx < 0) return undefined;
  return argv[idx + 1];
}

function hasSwitch(argv: ReadonlyArray<string>, name: string): boolean {
  return argv.includes(name);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || hasSwitch(argv, '--help')) usage(argv.length === 0 ? 2 : 0);

  const withdrawalId = readFlag(argv, '--withdrawal-id');
  if (withdrawalId === undefined || withdrawalId.trim() === '') usage();

  const modeRaw = readFlag(argv, '--mode') ?? 'dry-run';
  if (modeRaw !== 'dry-run' && modeRaw !== 'mutate') usage();
  const mode: 'dry-run' | 'mutate' = modeRaw;

  const confirmationPhrase =
    readFlag(argv, '--confirmation-phrase') ??
    readFlag(argv, '--authorize-phrase') ??
    process.env.PHASE10_CANARY_RECOVERY_CONFIRMATION_PHRASE ??
    null;
  const ownerAdminUserId =
    readFlag(argv, '--owner-admin-user-id') ??
    readFlag(argv, '--operator-admin-user-id') ??
    process.env.PHASE10_CANARY_RECOVERY_OWNER_ADMIN_USER_ID ??
    process.env.PHASE10_CANARY_RECOVERY_OPERATOR_ADMIN_USER_ID ??
    null;
  const ownerSessionToken =
    readFlag(argv, '--owner-session-token') ??
    process.env.PHASE10_CANARY_RECOVERY_OWNER_SESSION_TOKEN ??
    null;
  const expectedTokenRaw = readFlag(argv, '--expected-fencing-token');
  const expectedFencingToken =
    expectedTokenRaw !== undefined && expectedTokenRaw.trim() !== ''
      ? BigInt(expectedTokenRaw)
      : null;
  const operationalMutationConfirm =
    process.env.PHASE10_CANARY_RECOVERY_OPERATIONAL_MUTATION_CONFIRM ?? null;

  if (mode === 'mutate' && isPhase10CanaryRecoveryCiEnvironment()) {
    console.error(
      JSON.stringify({
        ok: false,
        error: 'mutate refused in CI/GitHub Actions',
      }),
    );
    process.exit(1);
  }

  const worker = loadWorkerConfig();
  const pool = createDatabasePool(worker.DATABASE_URL);

  try {
    const input = {
      withdrawalId,
      mode,
      confirmationPhrase,
      ownerAdminUserId,
      ownerSessionToken,
      temporalTerminatedConfirmed: hasSwitch(argv, '--temporal-terminated-confirmed'),
      payoutWorkerStoppedConfirmed: hasSwitch(argv, '--payout-worker-stopped-confirmed'),
      ...(expectedFencingToken !== null ? { expectedFencingToken } : {}),
      ...(operationalMutationConfirm !== null ? { operationalMutationConfirm } : {}),
    };

    if (mode === 'dry-run') {
      const plan = await planPhase10CanarySigningZeroAttemptsRecovery(pool, input);
      console.log(JSON.stringify({ ok: plan.accepted, command: 'plan', ...plan }, null, 2));
      process.exitCode = plan.accepted ? 0 : 1;
      return;
    }

    const result = await executePhase10CanarySigningZeroAttemptsRecovery(pool, {
      ...input,
      mode: 'mutate',
    });
    console.log(JSON.stringify({ ok: result.accepted, command: 'execute', ...result }, null, 2));
    process.exitCode = result.accepted ? 0 : 1;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
});
