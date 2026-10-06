#!/usr/bin/env node
/**
 * Phase 21 Mainnet canary payout CLI.
 *
 * PLAN (default / --plan): read-only. Proves canary preconditions via ceremony
 * verified pool (verify_full TLS + TCP proxy). No Owner TTY auth for PLAN.
 * APPLY (--apply): arms one-shot Phase21 manual dispatch permit for WD-000001 only.
 * Never broadcasts, never signs, never unlocks signer, never globally unpauses dispatch.
 */
import {
  PHASE21_CANARY_PAYOUT_APPLY_ENABLED,
  PHASE21_CANARY_PAYOUT_FUTURE_APPLY_DESIGN,
  PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
  observePhase21CanaryPayoutEnv,
  planPhase21CanaryPayout,
  probePhase21CanarySignerLockedReadOnly,
} from '../phase21-canary-payout-plan.js';
import { applyPhase21CanaryPayout } from '../phase21-canary-payout-apply.js';
import {
  Phase21CanaryPlanDbError,
  openPhase21CanaryPlanVerifiedPool,
} from '../phase21-canary-payout-db.js';
import { openPhase21ApplyVerifiedPool } from '../phase21-ceremony-apply-cli.js';
import { confirmPhase21CanaryPayoutApplyInteractive } from '../phase21-ceremony-confirmations.js';
import { stringifyPhase21CanaryPayoutJson } from '../phase21-canary-payout-json.js';

function usage(exitCode = 2): never {
  console.error(
    stringifyPhase21CanaryPayoutJson(
      {
        ok: false,
        message:
          'usage: phase21-canary-payout --plan --withdrawal-id <uuid> --ceremony-endpoint-profile <path>  |  phase21-canary-payout --apply --withdrawal-id <uuid> --ceremony-endpoint-profile <path>',
        soleAuthorizedWithdrawalId: PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
        applyEnabled: PHASE21_CANARY_PAYOUT_APPLY_ENABLED,
        applyArmsPermitOnly: true,
        requiresCeremonyEndpointProfile: true,
        requiresTcpProxyEnv:
          'PHASE21_CEREMONY_PROXY_HOST|RAILWAY_TCP_PROXY_HOST|RAILWAY_TCP_PROXY_DOMAIN + PORT',
        genericPoolRefused: true,
        readyForLivePayout: false,
        broadcastPerformed: false,
      },
      2,
    ),
  );
  process.exit(exitCode);
}

function printJson(value: unknown): void {
  console.log(stringifyPhase21CanaryPayoutJson(value, 2));
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

async function runPlan(argv: string[]): Promise<void> {
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
      broadcastPerformed: false,
      productionMutationOccurred: false,
      signerActionOccurred: false,
      broadcastOccurred: false,
      genericPoolRefused: true,
      details:
        error instanceof Phase21CanaryPlanDbError
          ? JSON.parse(
              redactSecrets(stringifyPhase21CanaryPayoutJson(error.details, undefined), secretsToRedact),
            )
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
      broadcastPerformed: false,
    });
    if (!result.ok) {
      process.exitCode = 1;
    }
  } finally {
    client.release();
    await live.close();
  }
}

async function runApply(argv: string[]): Promise<void> {
  if (!PHASE21_CANARY_PAYOUT_APPLY_ENABLED) {
    printJson({
      ok: false,
      mode: 'APPLY_REFUSED',
      command: 'phase21:canary-payout',
      refuseCode: 'PHASE21_CANARY_PAYOUT_APPLY_NOT_ENABLED',
      applyEnabled: false,
      futureApplyDesign: PHASE21_CANARY_PAYOUT_FUTURE_APPLY_DESIGN,
      broadcastPerformed: false,
      signed: false,
      readyForLivePayout: false,
    });
    process.exitCode = 1;
    return;
  }

  const withdrawalId = readFlag(argv, '--withdrawal-id');
  if (withdrawalId === undefined || withdrawalId.trim() === '') {
    usage();
  }

  let verifiedClose: (() => Promise<void>) | null = null;
  try {
    const { verified, trust } = await openPhase21ApplyVerifiedPool(argv);
    verifiedClose = verified.close;
    const env = observePhase21CanaryPayoutEnv();
    const signerProbe = await probePhase21CanarySignerLockedReadOnly(env.signerBaseUrl);

    const client = await verified.pool.connect();
    try {
      const plan = await planPhase21CanaryPayout(client, {
        withdrawalId: withdrawalId.trim(),
        env,
        signerProbe,
      });
      printJson({
        ok: plan.ok,
        command: 'phase21:canary-payout',
        mode: 'FRESH_PLAN_BEFORE_APPLY',
        plan,
        notes: [
          'Fresh PLAN before confirmation',
          'APPLY will arm one-shot permit only',
          'No broadcast / no sign / no global unpause',
        ],
        readyForLivePayout: false,
        broadcastPerformed: false,
        signed: false,
      });
      if (!plan.ok) {
        process.exitCode = 1;
        return;
      }

      const applyConfirmation = await confirmPhase21CanaryPayoutApplyInteractive();
      const result = await applyPhase21CanaryPayout(client, {
        withdrawalId: withdrawalId.trim(),
        ownerTrust: trust,
        applyConfirmation,
        env,
        signerProbe,
      });
      printJson({
        ...result,
        command: 'phase21:canary-payout',
        productionMutationOccurred: result.applied,
        signerActionOccurred: false,
        broadcastOccurred: false,
        broadcastPerformed: false,
        signed: false,
      });
      if (!result.ok) {
        process.exitCode = 1;
      }
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    printJson({
      ok: false,
      command: 'phase21:canary-payout',
      mode: 'APPLY',
      refuseCode: 'CANARY_APPLY_FAILED',
      message: error instanceof Error ? error.message : String(error),
      readyForLivePayout: false,
      applied: false,
      broadcastPerformed: false,
      signed: false,
    });
    process.exitCode = 1;
  } finally {
    if (verifiedClose !== null) await verifiedClose();
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
    await runApply(argv);
    return;
  }
  if (!wantsPlan) {
    usage();
  }
  await runPlan(argv);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  printJson({
    ok: false,
    command: 'phase21:canary-payout',
    refuseCode: 'UNEXPECTED_ERROR',
    message,
    readyForLivePayout: false,
    applied: false,
    mutated: false,
    signed: false,
    broadcast: false,
    broadcastPerformed: false,
    productionMutationOccurred: false,
    signerActionOccurred: false,
    broadcastOccurred: false,
  });
  process.exitCode = 1;
});
