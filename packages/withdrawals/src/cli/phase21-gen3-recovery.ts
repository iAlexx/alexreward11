#!/usr/bin/env node
/**
 * Phase 21 Gen-3 Owner-authorized recovery CLI.
 *
 * PLAN (default / --plan): read-only. Requires --chain-recon-json with fresh
 * independent dual-provider HIGH-confidence no-payment evidence.
 * APPLY (--apply): arms Gen-3 one-shot permit only after interactive Owner phrase.
 * Never broadcasts, signs, unlocks signer, enables relay, or globally unpauses dispatch.
 * Gen-1 / Gen-2 CONSUMED permits, attempts #1 / #2 and the Gen-2 launch claim are preserved.
 */
import { readFileSync } from 'node:fs';

import {
  PHASE21_GEN3_AUTHORIZATION_GENERATION,
  PHASE21_GEN3_RECOVERY_WITHDRAWAL_ID,
  planPhase21Gen3Recovery,
  type Phase21Gen3IndependentChainReconciliation,
} from '../phase21-gen3-recovery-plan.js';
import {
  PHASE21_GEN3_RECOVERY_APPLY_ENABLED,
  applyPhase21Gen3Recovery,
} from '../phase21-gen3-recovery-apply.js';
import {
  Phase21CanaryPlanDbError,
  openPhase21CanaryPlanVerifiedPool,
} from '../phase21-canary-payout-db.js';
import { openPhase21ApplyVerifiedPool } from '../phase21-ceremony-apply-cli.js';
import { confirmPhase21Gen3RecoveryApplyInteractive } from '../phase21-ceremony-confirmations.js';
import { stringifyPhase21CanaryPayoutJson } from '../phase21-canary-payout-json.js';

function usage(exitCode = 2): never {
  console.error(
    stringifyPhase21CanaryPayoutJson(
      {
        ok: false,
        message:
          'usage: phase21-gen3-recovery --plan|--apply --withdrawal-id <uuid> --ceremony-endpoint-profile <path> --chain-recon-json <path>',
        soleAuthorizedWithdrawalId: PHASE21_GEN3_RECOVERY_WITHDRAWAL_ID,
        authorizationGeneration: PHASE21_GEN3_AUTHORIZATION_GENERATION,
        applyEnabled: PHASE21_GEN3_RECOVERY_APPLY_ENABLED,
        applyArmsPermitOnly: true,
        requiresFreshIndependentChainRecon: true,
        requiresPriorAttemptCount: 2,
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

function loadChainRecon(path: string): Phase21Gen3IndependentChainReconciliation {
  return JSON.parse(readFileSync(path, 'utf8')) as Phase21Gen3IndependentChainReconciliation;
}

async function runPlan(argv: string[]): Promise<void> {
  const withdrawalId = readFlag(argv, '--withdrawal-id');
  const chainReconPath = readFlag(argv, '--chain-recon-json');
  if (withdrawalId === undefined || chainReconPath === undefined) usage();

  const chainReconciliation = loadChainRecon(chainReconPath);
  let live;
  try {
    live = await openPhase21CanaryPlanVerifiedPool({ argv });
  } catch (error: unknown) {
    const code =
      error instanceof Phase21CanaryPlanDbError ? error.code : 'PLAN_VERIFIED_POOL_OPEN_FAILED';
    printJson({
      ok: false,
      command: 'phase21:gen3-recovery',
      mode: 'PLAN',
      refuseCode: code,
      message: error instanceof Error ? error.message : String(error),
      mutated: false,
      broadcastPerformed: false,
      signed: false,
    });
    process.exitCode = 1;
    return;
  }

  const client = await live.verified.pool.connect();
  try {
    const plan = await planPhase21Gen3Recovery(client, {
      withdrawalId: withdrawalId.trim(),
      chainReconciliation,
      deploymentEnvironment: 'PRODUCTION',
    });
    printJson({
      command: 'phase21:gen3-recovery',
      ...plan,
    });
    process.exitCode = plan.ok ? 0 : 1;
  } finally {
    client.release();
    await live.close();
  }
}

async function runApply(argv: string[]): Promise<void> {
  if (!PHASE21_GEN3_RECOVERY_APPLY_ENABLED) {
    printJson({
      ok: false,
      mode: 'APPLY',
      refuseCode: 'PHASE21_GEN3_RECOVERY_APPLY_NOT_ENABLED',
      applied: false,
      broadcastPerformed: false,
      signed: false,
    });
    process.exitCode = 1;
    return;
  }

  const withdrawalId = readFlag(argv, '--withdrawal-id');
  const chainReconPath = readFlag(argv, '--chain-recon-json');
  if (withdrawalId === undefined || chainReconPath === undefined) usage();

  const chainReconciliation = loadChainRecon(chainReconPath);
  let verifiedClose: (() => Promise<void>) | null = null;
  try {
    const { verified, trust } = await openPhase21ApplyVerifiedPool(argv);
    verifiedClose = verified.close;
    const confirmation = await confirmPhase21Gen3RecoveryApplyInteractive();
    const client = await verified.pool.connect();
    try {
      const result = await applyPhase21Gen3Recovery(client, {
        withdrawalId: withdrawalId.trim(),
        ownerTrust: trust,
        applyConfirmation: confirmation,
        chainReconciliation,
        deploymentEnvironment: 'PRODUCTION',
      });
      printJson({
        command: 'phase21:gen3-recovery',
        ...result,
      });
      process.exitCode = result.ok ? 0 : 1;
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    printJson({
      ok: false,
      command: 'phase21:gen3-recovery',
      mode: 'APPLY',
      refuseCode: 'GEN3_APPLY_FAILED',
      message: error instanceof Error ? error.message : String(error),
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
  if (!wantsPlan) usage();
  await runPlan(argv);
}

main().catch((error: unknown) => {
  printJson({
    ok: false,
    command: 'phase21:gen3-recovery',
    refuseCode: 'UNEXPECTED_ERROR',
    message: error instanceof Error ? error.message : String(error),
    broadcastPerformed: false,
    signed: false,
  });
  process.exitCode = 1;
});
