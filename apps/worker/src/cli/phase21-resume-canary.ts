#!/usr/bin/env node
/**
 * Owner-operated, exact WD-000001 Mainnet resumption. Not part of worker startup.
 * --plan performs read-only preflight, --execute requires exact Owner intent phrase.
 * No DB writes, signing, broadcasts, unpause, or automatic retry in this CLI.
 */
import { Client, Connection, WorkflowNotFoundError } from '@temporalio/client';
import { Pool } from 'pg';
import { loadWorkerConfig } from '@alex-rewards/config';
import {
  SignerHttpClient,
  assertPhase21Ready,
  buildPhase21PayoutConfig,
  evaluatePhase21ManualDispatchRestartSafety,
  PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
  PHASE21_CANARY_PAYOUT_PUBLIC_ID,
  PHASE21_CANARY_PAYOUT_EXPECTED_GROSS_ATOMIC,
  PHASE21_CANARY_PAYOUT_EXPECTED_FEE_ATOMIC,
  PHASE21_CANARY_PAYOUT_EXPECTED_NET_ATOMIC,
  PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_FRIENDLY,
  PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_RAW,
  PHASE21_CANARY_FROZEN_JETTON_MASTER,
} from '@alex-rewards/withdrawals';

const PERMIT = '1312217e-8b0f-464c-89a3-4856d1af9e20';
const OUTBOX = '01a11500-4ce9-7619-b7a1-12c75aef93c1';
const WORKFLOW = 'withdrawal/' + PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID;
const ACK = 'I_AUTHORIZE_WD_000001_MAINNET_ONE_SHOT';
const ensure = (ok: unknown, label: string): void => {
  if (!ok) throw new Error('PRECHECK_FAILED_' + label);
};
function statusName(status: unknown): string {
  if (typeof status === 'string') return status.toUpperCase();
  if (typeof status === 'number') return String(status);
  if (status !== null && typeof status === 'object' && 'name' in status)
    return String(status.name).toUpperCase();
  return '';
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const plan = argv.length === 1 && argv[0] === '--plan';
  const execute = argv.length === 3 && argv[0] === '--execute' &&
    argv[1] === '--confirm' && argv[2] === ACK;
  ensure(plan || execute, 'MODE_OR_CONFIRMATION');

  const cfg = loadWorkerConfig();
  ensure(cfg.PHASE21_MAINNET_ENABLED === true, 'MAINNET_DISABLED');
  ensure(cfg.WITHDRAWAL_REAL_CHAIN_ENABLED === true, 'REAL_CHAIN_DISABLED');
  ensure(cfg.WITHDRAWAL_FAKE_CHAIN_ENABLED === false, 'FAKE_CHAIN_ENABLED');
  ensure(cfg.WITHDRAWAL_NETWORK_CODE === 'TON_MAINNET', 'NETWORK');
  ensure(cfg.WORKER_OUTBOX_RELAY_ENABLED === false, 'GLOBAL_RELAY_ENABLED');
  ensure(cfg.TON_MAINNET_USDT_JETTON_MASTER === PHASE21_CANARY_FROZEN_JETTON_MASTER, 'JETTON_MASTER');

  assertPhase21Ready(buildPhase21PayoutConfig({
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
  }));

  const pool = new Pool({ connectionString: cfg.DATABASE_URL });
  try {
    const db = await pool.connect();
    try {
      await db.query('BEGIN READ ONLY');
      try {
        const sql = [
          'SELECT w.public_id, w.state::text AS state,',
          'w.requested_amount_atomic::text AS gross, w.fee_amount_atomic::text AS fee,',
          'w.net_amount_atomic::text AS net, uw.verified, uw.disabled_at,',
          'uw.friendly_address AS recipient, uw.raw_address AS raw_recipient,',
          'n.code AS network, ast.symbol AS symbol, ast.decimals,',
          'ast.contract_identity AS asset_master,',
          'p.id::text AS permit_id, p.status::text AS permit_status,',
          'p.consumed_attempt_id::text AS consumed_attempt_id,',
          'p.authorized_gross_atomic::text AS permit_gross,',
          'p.authorized_fee_atomic::text AS permit_fee,',
          'p.authorized_net_atomic::text AS permit_net,',
          'p.authorized_recipient_friendly AS permit_recipient,',
          'p.authorized_recipient_raw AS permit_raw_recipient,',
          'p.authorized_network_code AS permit_network,',
          'p.authorized_asset_symbol AS permit_symbol,',
          'p.authorized_jetton_master AS permit_master,',
          'o.id::text AS outbox_id, o.event_type, o.status::text AS outbox_status,',
          "o.payload->>'withdrawalId' AS event_withdrawal,",
          "o.payload->>'permitId' AS event_permit,",
          "o.payload->>'workflowId' AS event_workflow,",
          '(SELECT count(*)::int FROM withdrawal_attempts a WHERE a.withdrawal_id = w.id) AS attempts',
          'FROM withdrawals w',
          'JOIN user_wallets uw ON uw.id = w.wallet_id',
          'JOIN networks n ON n.id = w.network_id',
          'JOIN assets ast ON ast.id = w.asset_id',
          'JOIN phase21_manual_dispatch_permits p ON p.withdrawal_id = w.id',
          'JOIN outbox_events o ON o.id = $2::uuid',
          'WHERE w.id = $1::uuid'
        ].join(' ');
        const q = await db.query(sql, [PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID, OUTBOX]);
        ensure(q.rowCount === 1, 'EXACT_ROW');
        const x = q.rows[0];
        ensure(x.public_id === PHASE21_CANARY_PAYOUT_PUBLIC_ID && x.state === 'APPROVED', 'WITHDRAWAL_STATE');
        ensure(x.gross === PHASE21_CANARY_PAYOUT_EXPECTED_GROSS_ATOMIC.toString(), 'GROSS');
        ensure(x.fee === PHASE21_CANARY_PAYOUT_EXPECTED_FEE_ATOMIC.toString(), 'FEE');
        ensure(x.net === PHASE21_CANARY_PAYOUT_EXPECTED_NET_ATOMIC.toString(), 'NET');
        ensure(x.verified === true && x.disabled_at === null, 'WALLET');
        ensure(x.recipient === PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_FRIENDLY, 'RECIPIENT');
        ensure(x.raw_recipient === PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_RAW, 'RAW_RECIPIENT');
        ensure(x.network === 'TON_MAINNET' && x.symbol === 'USDT' && x.decimals === 6, 'ASSET');
        ensure(x.asset_master === PHASE21_CANARY_FROZEN_JETTON_MASTER, 'ASSET_MASTER');
        ensure(x.permit_id === PERMIT && x.permit_status === 'ARMED' &&
          x.consumed_attempt_id === null && x.attempts === 0, 'PERMIT_AND_ATTEMPTS');
        ensure(x.permit_gross === x.gross && x.permit_fee === x.fee &&
          x.permit_net === x.net && x.permit_recipient === x.recipient &&
          x.permit_raw_recipient === x.raw_recipient, 'PERMIT_BINDINGS');
        ensure(x.permit_network === 'TON_MAINNET' && x.permit_symbol === 'USDT' &&
          x.permit_master === PHASE21_CANARY_FROZEN_JETTON_MASTER, 'PERMIT_ASSET');
        ensure(x.outbox_id === OUTBOX && x.event_type === 'withdrawal.phase21_manual_dispatch' &&
          x.outbox_status === 'DISPATCHED' && x.event_withdrawal === PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID &&
          x.event_permit === PERMIT && x.event_workflow === WORKFLOW, 'OUTBOX');
        const safety = await evaluatePhase21ManualDispatchRestartSafety(
          db, PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID
        );
        ensure(safety.allowDuplicate === true && safety.permit?.status === 'ARMED', 'RESTART');
      } finally {
        await db.query('ROLLBACK');
      }
    } finally {
      db.release();
    }
  } finally {
    await pool.end();
  }
  console.log('PHASE21_DB_PREFLIGHT=PASS');

  const signer = new SignerHttpClient({
    baseUrl: cfg.SIGNER_BASE_URL,
    serviceToken: cfg.SIGNER_SERVICE_TOKEN ?? '',
  });
  const identity = await signer.getSigningIdentity();
  ensure(identity.signingReady === true && identity.custodyState === 'UNLOCKED', 'SIGNER');
  console.log('PHASE21_SIGNER_PREFLIGHT=PASS');

  const connection = await Connection.connect({ address: cfg.TEMPORAL_ADDRESS });
  try {
    const temporal = new Client({
      connection,
      namespace: cfg.TEMPORAL_NAMESPACE,
    });
    try {
      const prior = await temporal.workflow.getHandle(WORKFLOW).describe();
      const status = statusName(prior.status);
      ensure(status.includes('TERMINATED') || status === '5', 'EXISTING_WORKFLOW_' + status);
    } catch (error) {
      if (!(error instanceof WorkflowNotFoundError)) throw error;
    }
    console.log('PHASE21_TEMPORAL_PREFLIGHT=PASS');

    if (plan) {
      console.log('PHASE21_PLAN=PASS_NO_ACTION_TAKEN');
      return;
    }

    const handle = await temporal.workflow.start('withdrawalPayoutWorkflow', {
      taskQueue: cfg.TEMPORAL_TASK_QUEUE,
      workflowId: WORKFLOW,
      args: [{ withdrawalId: PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID, realChainEnabled: true }],
      workflowIdReusePolicy: 'ALLOW_DUPLICATE',
      workflowIdConflictPolicy: 'FAIL',
    });
    console.log('PHASE21_WORKFLOW_STARTED=YES');
    console.log('RUN_ID=' + handle.firstExecutionRunId);
    console.log('DO_NOT_RETRY_OR_RESEND_WITHOUT_RECONCILIATION');
  } finally {
    await connection.close();
  }
}

main().catch((error: unknown) => {
  const code = error instanceof Error && error.message.startsWith('PRECHECK_FAILED_')
    ? error.message
    : error instanceof Error ? 'FAILED_' + error.name.replace(/[^A-Za-z0-9_]/g, '_')
    : 'FAILED_UNKNOWN';
  console.error('PHASE21_RESUME=' + code);
  process.exitCode = 1;
});
