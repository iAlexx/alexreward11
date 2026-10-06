#!/usr/bin/env node
/**
 * Phase 21 Mainnet canary payout CLI.
 *
 * PLAN (default / --plan): read-only. Proves canary preconditions via ceremony
 * verified pool (verify_full TLS + TCP proxy). No Owner TTY auth for PLAN.
 * APPLY: designed but refused — not enabled in this source slice.
 *
 * Never unlocks signer, never signs, never broadcasts, never mutates flags/DB/Railway.
 * Never disables TLS verification.
 */
import {
  PHASE21_CANARY_PAYOUT_APPLY_ENABLED,
  PHASE21_CANARY_PAYOUT_FUTURE_APPLY_DESIGN,
  PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
  observePhase21CanaryPayoutEnv,
  planPhase21CanaryPayout,
  probePhase21CanarySignerLockedReadOnly,
  refusePhase21CanaryPayoutApply,
} from '../phase21-canary-payout-plan.js';
import {
  Phase21CanaryPlanDbError,
  openPhase21CanaryPlanVerifiedPool,
} from '../phase21-canary-payout-db.js';

function usage(exitCode = 2): never {
  console.error(
    JSON.stringify(
      {
        ok: false,
        message:
          'usage: phase21-canary-payout --plan --withdrawal-id <uuid> --ceremony-endpoint-profile <path>  |  phase21-canary-payout --apply (REFUSED)',
        soleAuthorizedWithdrawalId: PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
        applyEnabled: PHASE21_CANARY_PAYOUT_APPLY_ENABLED,
        requiresCeremonyEndpointProfile: true,
        requiresTcpProxyEnv:
          'PHASE21_CEREMONY_PROXY_HOST|RAILWAY_TCP_PROXY_HOST|RAILWAY_TCP_PROXY_DOMAIN + PORT',
        genericPoolRefused: true,
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

function readFlag(argv: ReadonlyArray<string>, name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx < 0) return undefined;
  return argv[idx + 1];
}

function hasSwitch(argv: ReadonlyArray<string>, name: string): boolean {
  return argv.includes(name);
}

function redactSecrets(text: string, secrets: ReadonlyArray<string>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    out = out.split(secret).join('[REDACTED]');
  }
  return out;
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

  const secretsToRedact: string[] = [];
  const dbUrl = process.env.DATABASE_URL;
  if (typeof dbUrl === 'string' && dbUrl.length > 0) secretsToRedact.push(dbUrl);
  try {
    if (typeof dbUrl === 'string') {
      const u = new URL(dbUrl);
      if (u.password) secretsToRedact.push(decodeURIComponent(u.password));
    }
  } catch {
    // ignore parse for redaction
  }

  let live;
  try {
    live = await openPhase21CanaryPlanVerifiedPool({ argv });
  } catch (error: unknown) {
    const code =
      error instanceof Phase21CanaryPlanDbError ? error.code : 'PLAN_VERIFIED_POOL_OPEN_FAILED';
    const message = error instanceof Error ? error.message : String(error);
    printJson({
      ok: false,
      command: 'phase21:canary-payout',
      refuseCode: code,
      message: redactSecrets(message, secretsToRedact),
      readyForLivePayout: false,
      applied: false,
      mutated: false,
      signed: false,
      broadcast: false,
      productionMutationOccurred: false,
      signerActionOccurred: false,
      broadcastOccurred: false,
      genericPoolRefused: true,
      details:
        error instanceof Phase21CanaryPlanDbError
          ? JSON.parse(redactSecrets(JSON.stringify(error.details), secretsToRedact))
          : undefined,
    });
    process.exitCode = 1;
    return;
  }

  const env = observePhase21CanaryPayoutEnv();
  const signerProbe = await probePhase21CanarySignerLockedReadOnly(env.signerBaseUrl);

  const client = await live.verified.pool.connect();
  try {
    const result = await planPhase21CanaryPayout(client, {
      withdrawalId: withdrawalId.trim(),
      env,
      signerProbe,
    });
    printJson({
      ...result,
      command: 'phase21:canary-payout',
      current_database: live.evidence.currentDatabase,
      dbVerification: live.evidence,
      productionMutationOccurred: false,
      signerActionOccurred: false,
      broadcastOccurred: false,
    });
    if (!result.ok) {
      process.exitCode = 1;
    }
  } finally {
    client.release();
    await live.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  printJson({
    ok: false,
    command: 'phase21:canary-payout',
    refuseCode: 'PLAN_UNEXPECTED_ERROR',
    message,
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
