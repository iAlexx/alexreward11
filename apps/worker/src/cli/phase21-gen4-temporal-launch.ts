#!/usr/bin/env node
/**
 * Owner-operated Gen-4 one-shot Temporal launch for WD-000001 recovery attempt #4.
 *
 * --plan: read-only preflight (DB + signer + Temporal describe + chain recon + deploy SHA)
 * --execute --confirm I_AUTHORIZE_WD_000001_GEN4_TEMPORAL_ONE_SHOT: start exactly one workflow
 *
 * Requires --expected-gen3-run-id (or PHASE21_GEN4_EXPECTED_GEN3_RUN_ID): verified Gen-3
 * Temporal run identity. WorkflowNotFound fails closed (never assume COMPLETED) unless the
 * durable Gen-3 terminal evidence path validates in PLAN. Live describe runId must match
 * Gen-3; mismatch refuses sequential re-launch after Gen-4.
 *
 * Never enables global outbox relay. Never signs/broadcasts in this CLI.
 * Requires Gen-4 ARMED (from prior APPLY), Gen-1 + Gen-2 + Gen-3 CONSUMED, attempts #1-#3
 * FAILED_PRE with no evidence, Gen-2 launch claim preserved, Gen-3 launch claim BOUND
 * (payload/permit/attempt #3), Gen-4 claim absent.
 */
import { readFileSync } from 'node:fs';

import { Client, Connection, WorkflowNotFoundError } from '@temporalio/client';
import { Pool } from 'pg';
import { loadWorkerConfig } from '@alex-rewards/config';
import {
  SignerHttpClient,
  assertPhase21Ready,
  buildPhase21PayoutConfig,
  evaluatePhase21Gen4LiveDeployShaMatch,
  evaluatePhase21Gen4PriorWorkflowIdentity,
  executePhase21Gen4TemporalLaunch,
  isPhase21CanaryPriorWorkflowSafeToRestart,
  PHASE21_CANARY_FROZEN_JETTON_MASTER,
  PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
  PHASE21_GEN4_TEMPORAL_LAUNCH_ACK,
  planPhase21Gen4TemporalLaunch,
  type Phase21Gen4IndependentChainReconciliation,
} from '@alex-rewards/withdrawals';

function statusName(status: unknown): string {
  if (typeof status === 'string') return status.toUpperCase();
  if (typeof status === 'number') return String(status);
  if (status !== null && typeof status === 'object' && 'name' in status) {
    return String((status).name).toUpperCase();
  }
  return '';
}

function ensure(ok: unknown, label: string): void {
  if (!ok) throw new Error('PRECHECK_FAILED_' + label);
}

function readFlag(argv: ReadonlyArray<string>, name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx < 0) return undefined;
  return argv[idx + 1];
}

function loadChainRecon(path: string): Phase21Gen4IndependentChainReconciliation {
  return JSON.parse(readFileSync(path, 'utf8')) as Phase21Gen4IndependentChainReconciliation;
}

function resolveLiveDeploySha(env: NodeJS.ProcessEnv): string {
  return (
    env.RAILWAY_GIT_COMMIT_SHA?.trim() ||
    env.PHASE21_LIVE_DEPLOY_SHA?.trim() ||
    ''
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const planMode = argv[0] === '--plan';
  const executeMode =
    argv[0] === '--execute' &&
    argv[1] === '--confirm' &&
    argv[2] === PHASE21_GEN4_TEMPORAL_LAUNCH_ACK;
  ensure(planMode || executeMode, 'MODE_OR_CONFIRMATION');

  const chainReconPath = readFlag(argv, '--chain-recon-json');
  ensure(chainReconPath !== undefined && chainReconPath.trim() !== '', 'CHAIN_RECON_JSON');
  const expectedDeploySha =
    readFlag(argv, '--expected-deploy-sha') ??
    process.env.PHASE21_GEN4_EXPECTED_DEPLOY_SHA ??
    '';
  ensure(expectedDeploySha.trim() !== '', 'EXPECTED_DEPLOY_SHA');
  const expectedGen3RunId =
    readFlag(argv, '--expected-gen3-run-id') ??
    process.env.PHASE21_GEN4_EXPECTED_GEN3_RUN_ID ??
    '';
  ensure(expectedGen3RunId.trim() !== '', 'EXPECTED_GEN3_RUN_ID');

  const cfg = loadWorkerConfig();
  ensure(cfg.PHASE21_MAINNET_ENABLED === true, 'MAINNET_DISABLED');
  ensure(cfg.WITHDRAWAL_REAL_CHAIN_ENABLED === true, 'REAL_CHAIN_DISABLED');
  ensure(cfg.WITHDRAWAL_FAKE_CHAIN_ENABLED === false, 'FAKE_CHAIN_ENABLED');
  ensure(cfg.WITHDRAWAL_NETWORK_CODE === 'TON_MAINNET', 'NETWORK');
  ensure(cfg.WORKER_OUTBOX_RELAY_ENABLED === false, 'GLOBAL_RELAY_ENABLED');
  ensure(cfg.TON_MAINNET_USDT_JETTON_MASTER === PHASE21_CANARY_FROZEN_JETTON_MASTER, 'JETTON_MASTER');

  assertPhase21Ready(
    buildPhase21PayoutConfig({
      phase21MainnetEnabled: true,
      realChainEnabled: true,
      fakeChainEnabled: false,
      signerBaseUrl: cfg.SIGNER_BASE_URL,
      signerServiceToken: cfg.SIGNER_SERVICE_TOKEN ?? '',
      jettonMasterIdentity: cfg.TON_MAINNET_USDT_JETTON_MASTER ?? null,
      primaryProviderKind: cfg.TON_PRIMARY_PROVIDER_KIND,
      primaryProviderUrl: cfg.TON_PRIMARY_PROVIDER_URL,
      primaryProviderApiKey: cfg.TON_PRIMARY_PROVIDER_API_KEY,
      secondaryProviderKind: cfg.TON_SECONDARY_PROVIDER_KIND,
      secondaryProviderUrl: cfg.TON_SECONDARY_PROVIDER_URL,
      secondaryProviderApiKey: cfg.TON_SECONDARY_PROVIDER_API_KEY,
    }),
  );

  const liveDeploySha = resolveLiveDeploySha(process.env);
  const shaGate = evaluatePhase21Gen4LiveDeployShaMatch({
    expectedDeploySha,
    liveDeploySha,
  });
  ensure(shaGate.ok, 'DEPLOY_SHA_' + String(shaGate.reason).toUpperCase());

  const chainReconciliation = loadChainRecon(chainReconPath!);

  const signer = new SignerHttpClient({
    baseUrl: cfg.SIGNER_BASE_URL,
    serviceToken: cfg.SIGNER_SERVICE_TOKEN ?? '',
  });
  const identity = await signer.getSigningIdentity();
  const signerReady = identity.signingReady === true;
  const signerUnlocked = String(identity.custodyState).toUpperCase() === 'UNLOCKED';
  // PLAN is a non-executable preflight: a LOCKED Signer is acceptable (readyForExecute stays
  // false). EXECUTE requires signingReady + UNLOCKED before anything else happens.
  if (executeMode) {
    ensure(signerReady && signerUnlocked, 'SIGNER');
  }

  const connection = await Connection.connect({ address: cfg.TEMPORAL_ADDRESS });
  try {
    const temporal = new Client({
      connection,
      namespace: cfg.TEMPORAL_NAMESPACE,
    });
    const workflowId = 'withdrawal/' + PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID;
    // Fail closed: never assume COMPLETED when Temporal history is missing.
    let priorWorkflowFound = false;
    let priorWorkflowStatus = '';
    let observedPriorRunId: string | null = null;
    let workflowStillRunning = false;
    try {
      const prior = await temporal.workflow.getHandle(workflowId).describe();
      priorWorkflowFound = true;
      priorWorkflowStatus = statusName(prior.status);
      observedPriorRunId =
        typeof prior.runId === 'string' && prior.runId.trim() !== '' ? prior.runId.trim() : null;
      workflowStillRunning =
        priorWorkflowStatus.includes('RUNNING') ||
        priorWorkflowStatus === '1' ||
        priorWorkflowStatus.includes('CONTINUED_AS_NEW');
      ensure(
        isPhase21CanaryPriorWorkflowSafeToRestart(priorWorkflowStatus) || workflowStillRunning,
        'EXISTING_WORKFLOW_' + priorWorkflowStatus,
      );
    } catch (error) {
      if (!(error instanceof WorkflowNotFoundError)) throw error;
      priorWorkflowFound = false;
      priorWorkflowStatus = '';
      observedPriorRunId = null;
      workflowStillRunning = false;
    }

    // Live Temporal identity is enforced inside PLAN. When history is absent
    // (retention expiry), PLAN may accept durable Gen-3 terminal evidence —
    // never assume COMPLETED / no-payment from WorkflowNotFound alone.
    if (priorWorkflowFound) {
      const identity = evaluatePhase21Gen4PriorWorkflowIdentity({
        expectedGen3RunId,
        observation: {
          found: true,
          runId: observedPriorRunId,
          status: priorWorkflowStatus,
        },
      });
      ensure(identity.ok, 'PRIOR_IDENTITY_' + String(identity.reason).toUpperCase());
    }

    const pool = new Pool({ connectionString: cfg.DATABASE_URL });
    try {
      const db = await pool.connect();
      try {
        const plan = await planPhase21Gen4TemporalLaunch(db, {
          withdrawalId: PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
          chainReconciliation,
          expectedDeploySha,
          liveDeploySha,
          globalRelayEnabled: cfg.WORKER_OUTBOX_RELAY_ENABLED === true,
          signerReady,
          signerUnlocked,
          expectedGen3RunId,
          priorWorkflowFound,
          observedPriorRunId,
          priorWorkflowStatus,
          workflowStillRunning,
          taskQueue: cfg.TEMPORAL_TASK_QUEUE,
          deploymentEnvironment: 'PRODUCTION',
        });

        console.log(
          JSON.stringify(
            {
              command: 'phase21:gen4-temporal-launch',
              ...plan,
              mode: planMode ? 'PLAN' : 'EXECUTE_PREFLIGHT',
            },
            null,
            2,
          ),
        );
        console.log('PHASE21_GEN4_TEMPORAL_READY_FOR_EXECUTE=' + String(plan.readyForExecute));
        ensure(plan.ok, 'PLAN_FAILED');

        if (planMode) {
          console.log(
            plan.readyForExecute
              ? 'PHASE21_GEN4_TEMPORAL_PLAN=PASS_NO_ACTION_TAKEN'
              : 'PHASE21_GEN4_TEMPORAL_PLAN=PASS_SAFETY_ONLY_SIGNER_LOCKED_NOT_READY_FOR_EXECUTE',
          );
          return;
        }
        ensure(plan.readyForExecute, 'PLAN_NOT_READY_FOR_EXECUTE');

        const result = await executePhase21Gen4TemporalLaunch({
          confirmationPhrase: PHASE21_GEN4_TEMPORAL_LAUNCH_ACK,
          plan,
          temporal,
          claimClient: db,
          expectedGen3RunId,
          signerReady,
          signerUnlocked,
          chainReconciliation,
          deploymentEnvironment: 'PRODUCTION',
        });
        ensure(result.ok && result.started, result.refuseCode ?? 'EXECUTE_FAILED');
        console.log('PHASE21_GEN4_TEMPORAL_STARTED=YES');
        console.log('RUN_ID=' + result.runId);
        console.log('WORKFLOW_ID=' + result.workflowId);
        console.log('RELAY_ENABLED=false');
        console.log('IDENTITY_MODE=' + String(plan.priorWorkflowIdentityMode));
        console.log('DO_NOT_RETRY_OR_RESEND_WITHOUT_RECONCILIATION');
      } finally {
        db.release();
      }
    } finally {
      await pool.end();
    }
  } finally {
    await connection.close();
  }
}

main().catch((error: unknown) => {
  const code =
    error instanceof Error && error.message.startsWith('PRECHECK_FAILED_')
      ? error.message
      : error instanceof Error
        ? 'FAILED_' + error.name.replace(/[^A-Za-z0-9_]/g, '_')
        : 'FAILED_UNKNOWN';
  console.error('PHASE21_GEN4_TEMPORAL_LAUNCH=' + code);
  process.exitCode = 1;
});
