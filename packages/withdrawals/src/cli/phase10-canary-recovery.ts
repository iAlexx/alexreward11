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
 *   Owner session token via interactive non-echoing TTY prompt only
 *     (never CLI args, env, logs, or error output)
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
  phase10CanaryRecoveryArgvExposesSessionToken,
  planPhase10CanarySigningZeroAttemptsRecovery,
} from '../phase10-canary-signing-recovery.js';

function usage(exitCode = 2): never {
  console.error(
    JSON.stringify(
      {
        ok: false,
        message:
          'usage: phase10-canary-recovery --withdrawal-id <uuid> [--mode dry-run|mutate] [--confirmation-phrase <phrase>] --owner-admin-user-id <uuid> [--expected-fencing-token <n>] [--temporal-terminated-confirmed] [--payout-worker-stopped-confirmed]',
        soleAuthorizedWithdrawalId: PHASE10_CANARY_RECOVERY_WITHDRAWAL_ID,
        confirmationPhrase: PHASE10_CANARY_RECOVERY_CONFIRMATION_PHRASE,
        confirmationIsNotAuthentication: true,
        ownerAdminUserIdRequiredForMutate: true,
        ownerSessionTokenInput: 'interactive-non-echoing-tty-only',
        ownerSessionTokenForbiddenOnArgv: true,
        ownerSessionTokenForbiddenOnEnv: true,
        ownerRoleBindingRequired: 'OWNER',
        recentReauthenticationRequiredOnExactSession: true,
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

/**
 * Read Owner session token from an interactive TTY without echoing characters.
 * Mirrors apps/signer local-unlock passphrase input — never accepts argv/env.
 */
async function readOwnerSessionTokenFromTty(): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      'owner session token requires an interactive TTY (refusing non-interactive stdin; never pass via argv/env)',
    );
  }
  return await new Promise<string>((resolve, reject) => {
    process.stdout.write('Owner session token (input hidden): ');
    let buf = '';
    const onData = (chunk: Buffer) => {
      const s = chunk.toString('utf8');
      for (const ch of s) {
        if (ch === '\n' || ch === '\r') {
          process.stdin.off('data', onData);
          process.stdin.setRawMode?.(false);
          process.stdout.write('\n');
          resolve(buf);
          return;
        }
        if (ch === '\u0003') {
          process.stdin.off('data', onData);
          process.stdin.setRawMode?.(false);
          process.stdout.write('\n');
          reject(new Error('cancelled'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
    };
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

/** Redact known secrets from any string before writing to stdout/stderr. */
function redactSecrets(text: string, secrets: ReadonlyArray<string>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

function printJson(value: unknown, secrets: ReadonlyArray<string>): void {
  console.log(redactSecrets(JSON.stringify(value, null, 2), secrets));
}

function printErrorJson(value: unknown, secrets: ReadonlyArray<string>): void {
  console.error(redactSecrets(JSON.stringify(value, null, 2), secrets));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || hasSwitch(argv, '--help')) usage(argv.length === 0 ? 2 : 0);

  if (phase10CanaryRecoveryArgvExposesSessionToken(argv)) {
    printErrorJson(
      {
        ok: false,
        error:
          'owner session token must not be passed via CLI arguments (use interactive non-echoing TTY prompt)',
      },
      [],
    );
    process.exit(1);
  }

  if (
    typeof process.env.PHASE10_CANARY_RECOVERY_OWNER_SESSION_TOKEN === 'string' &&
    process.env.PHASE10_CANARY_RECOVERY_OWNER_SESSION_TOKEN.length > 0
  ) {
    printErrorJson(
      {
        ok: false,
        error:
          'owner session token must not be supplied via environment variables (use interactive non-echoing TTY prompt)',
      },
      [],
    );
    process.exit(1);
  }

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
  const expectedTokenRaw = readFlag(argv, '--expected-fencing-token');
  const expectedFencingToken =
    expectedTokenRaw !== undefined && expectedTokenRaw.trim() !== ''
      ? BigInt(expectedTokenRaw)
      : null;
  const operationalMutationConfirm =
    process.env.PHASE10_CANARY_RECOVERY_OPERATIONAL_MUTATION_CONFIRM ?? null;

  if (mode === 'mutate' && isPhase10CanaryRecoveryCiEnvironment()) {
    printErrorJson({ ok: false, error: 'mutate refused in CI/GitHub Actions' }, []);
    process.exit(1);
  }

  let ownerSessionToken: string | null = null;
  if (mode === 'mutate') {
    ownerSessionToken = await readOwnerSessionTokenFromTty();
    if (ownerSessionToken.trim() === '') {
      printErrorJson({ ok: false, error: 'owner session token is required for mutate' }, []);
      process.exit(1);
    }
  }

  const secrets = ownerSessionToken !== null ? [ownerSessionToken] : [];
  const worker = loadWorkerConfig();
  const pool = createDatabasePool(worker.DATABASE_URL);

  try {
    const input = {
      withdrawalId,
      mode,
      confirmationPhrase,
      ownerAdminUserId,
      ...(ownerSessionToken !== null ? { ownerSessionToken } : {}),
      temporalTerminatedConfirmed: hasSwitch(argv, '--temporal-terminated-confirmed'),
      payoutWorkerStoppedConfirmed: hasSwitch(argv, '--payout-worker-stopped-confirmed'),
      ...(expectedFencingToken !== null ? { expectedFencingToken } : {}),
      ...(operationalMutationConfirm !== null ? { operationalMutationConfirm } : {}),
    };

    if (mode === 'dry-run') {
      const plan = await planPhase10CanarySigningZeroAttemptsRecovery(pool, input);
      printJson({ ok: plan.accepted, command: 'plan', ...plan }, secrets);
      process.exitCode = plan.accepted ? 0 : 1;
      return;
    }

    const result = await executePhase10CanarySigningZeroAttemptsRecovery(pool, {
      ...input,
      mode: 'mutate',
    });
    printJson({ ok: result.accepted, command: 'execute', ...result }, secrets);
    process.exitCode = result.accepted ? 0 : 1;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  printErrorJson(
    {
      ok: false,
      error: error instanceof Error ? error.message : 'unexpected error',
    },
    [],
  );
  process.exit(1);
});
