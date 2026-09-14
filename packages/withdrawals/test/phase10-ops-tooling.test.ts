import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { FakeTonChainProvider } from '@alex-rewards/ton';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  WITHDRAWAL_APPROVED_OUTBOX_EVENT,
  acquireHotWalletDispatchLease,
  buildPhase10HotWalletMonitorReport,
  buildPhase10ProviderBackedChainHistoryEvidence,
  checkPhase10PayoutInvariants,
  claimPendingWithdrawalApprovedEvents,
  compactTep74EvidenceSummary,
  createWithdrawalAttempt,
  evaluatePhase10AcceptanceFromEvidence,
  evaluatePhase10AcceptanceGate,
  generateFinalCampaignEvidence,
  hotWalletDispatchOwnerIdentity,
  initCampaignManifest,
  isCompleteIntendedPayoutProof,
  persistIntendedPayoutProvenEvidence,
  planPhase10Campaign,
  PHASE10_FAILURE_SCENARIO_CATALOGUE,
  PHASE10_REAL_CAMPAIGN_CONFIRMATION_PHRASE,
  PHASE10_REQUIRED_REAL_FAILURE_SCENARIO_IDS,
  attachWithdrawal,
  attachWithdrawalIds,
  resumeCampaign,
  writeEvidenceFile,
  runPhase10Preflight,
  runPhase10Readiness,
  runPhase10RestoreReconcileScan,
  validateFailureInjectionEvidence,
  validateLiveReadinessEvidence,
  withWithdrawalTransaction,
} from '../src/index.js';
import {
  createApprovedWithdrawal,
  createTestUser,
  bindVerifiedPrimaryWallet,
  phase7DatabaseUrl,
  resetAndMigrate,
  seedPhase7Base,
  truncateWithdrawalTables,
} from './harness.js';

describe.skipIf(phase7DatabaseUrl === '')('phase10 ops tooling', () => {
  let pool: Pool;
  let assetId: string;
  let networkId: string;
  let adminUserId: string;
  let hotWalletId: string;

  beforeAll(async () => {
    await resetAndMigrate(phase7DatabaseUrl);
    pool = new Pool({ connectionString: phase7DatabaseUrl });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await truncateWithdrawalTables(pool);
    const base = await seedPhase7Base(pool);
    assetId = base.assetId;
    networkId = base.networkId;
    adminUserId = base.adminUserId;
    hotWalletId = base.hotWalletId;
  });

  it('readiness reports BLOCKED when real/fake both false; missing resources WARN/intentionally_safe_off', async () => {
    const report = await runPhase10Readiness(pool, {
      deploymentEnvironment: 'LOCAL',
      fakeChainEnabled: false,
      realChainEnabled: false,
      acceptedNetworkCode: 'TON_TESTNET',
      usdtSymbol: 'USDT',
      phase10: {
        realChainEnabled: false,
        jettonMasterIdentity: null,
        primaryProviderKind: null,
        primaryProviderUrl: null,
        secondaryProviderKind: null,
        secondaryProviderUrl: null,
        signerServiceToken: '',
      },
      signerServiceTokenConfigured: false,
    });

    expect(report.overall).toBe('BLOCKED');
    const chainMode = report.items.find((i) => i.code === 'CHAIN_MODE');
    expect(chainMode?.status).toBe('BLOCKED');
    expect(chainMode?.classification).toBe('intentionally_safe_off');

    const external = report.items.filter((i) => i.code === 'EXTERNAL_RESOURCE');
    expect(external.length).toBeGreaterThan(0);
    expect(external.every((i) => i.status === 'WARN')).toBe(true);
    expect(external.every((i) => i.classification === 'intentionally_safe_off')).toBe(true);

    expect(report.summary.feeRule).not.toBeNull();
    expect(report.summary.limitRule).not.toBeNull();
  });

  it('real mode: bad controlled user and locked signer are BLOCKED not WARN', async () => {
    const report = await runPhase10Readiness(pool, {
      deploymentEnvironment: 'LOCAL',
      fakeChainEnabled: false,
      realChainEnabled: true,
      acceptedNetworkCode: 'TON_TESTNET',
      usdtSymbol: 'USDT',
      controlledUserId: '00000000-0000-4000-8000-000000000099',
      signerLocked: true,
      phase10: {
        realChainEnabled: true,
        jettonMasterIdentity: null,
        primaryProviderKind: null,
        primaryProviderUrl: null,
        secondaryProviderKind: null,
        secondaryProviderUrl: null,
        signerServiceToken: 'local-signer-service-token-32chars!!',
      },
      signerBaseUrlConfigured: true,
      signerServiceTokenConfigured: true,
    });

    expect(report.overall).toBe('BLOCKED');
    const user = report.items.find((i) => i.code === 'CONTROLLED_USER');
    expect(user?.status).toBe('BLOCKED');
    const signer = report.items.find((i) => i.code === 'SIGNER_LOCKED');
    expect(signer?.status).toBe('BLOCKED');
  });

  it('restore scan finds nothing dangerous on empty withdrawal tables', async () => {
    const scan = await runPhase10RestoreReconcileScan(pool);
    expect(scan.autoResend).toBe(false);
    expect(scan.autoUnpause).toBe(false);
    expect(scan.dangerousCount).toBe(0);
    expect(scan.findings.filter((f) => f.severity === 'DANGER')).toEqual([]);
  });

  it('campaign dry-run creates no withdrawals and refuses real without gates', async () => {
    const before = await pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM withdrawals`);
    const plan = planPhase10Campaign({ mode: 'dry-run' });
    expect(plan.accepted).toBe(true);
    expect(plan.createsWithdrawals).toBe(false);
    expect(plan.flipsEnv).toBe(false);
    expect(plan.intendedMatrix.length).toBe(PHASE10_FAILURE_SCENARIO_CATALOGUE.length);
    expect(plan.localDeterministicCount).toBeGreaterThan(0);
    expect(plan.requiresRealTestnetCount).toBeGreaterThan(0);

    const refused = planPhase10Campaign({ mode: 'real' });
    expect(refused.accepted).toBe(false);
    expect(refused.refusalReason).toMatch(/gates/i);

    const after = await pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM withdrawals`);
    expect(after.rows[0]?.c).toBe(before.rows[0]?.c);
  });

  it('payout invariants report CHAIN_PROOF_REQUIRED on incomplete CONFIRMED', async () => {
    const userId = await createTestUser(pool, '9601');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const withdrawalId = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });

    await pool.query(
      `UPDATE withdrawals
       SET state = 'CONFIRMED', confirmed_at = now(), updated_at = now()
       WHERE id = $1::uuid`,
      [withdrawalId],
    );

    const report = await checkPhase10PayoutInvariants(pool, withdrawalId);
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.code === 'CHAIN_PROOF_REQUIRED')).toBe(true);
  });

  it('preflight BLOCKED when real chain disabled', async () => {
    const report = await runPhase10Preflight(pool, {
      readinessConfig: {
        deploymentEnvironment: 'LOCAL',
        fakeChainEnabled: true,
        realChainEnabled: false,
        acceptedNetworkCode: 'TON_TESTNET',
        usdtSymbol: 'USDT',
      },
      skipRestoreScan: false,
    });
    expect(report.verdict).toBe('BLOCKED');
    expect(report.intentionallySafeOff || report.blockers.length > 0).toBe(true);
    expect(
      report.blockers.some(
        (b) => b.includes('WITHDRAWAL_REAL_CHAIN_ENABLED') || b.includes('fake'),
      ),
    ).toBe(true);
  });

  it('approved outbox claim uses SKIP LOCKED (does not bump available_at fencing)', async () => {
    const userId = await createTestUser(pool, '9602');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const withdrawalId = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });

    await withWithdrawalTransaction(pool, async (client) => {
      const before = await client.query<{ available_at: Date }>(
        `SELECT available_at FROM outbox_events
         WHERE event_type = $1 AND aggregate_id = $2::uuid AND status = 'PENDING'`,
        [WITHDRAWAL_APPROVED_OUTBOX_EVENT, withdrawalId],
      );
      expect(before.rowCount).toBe(1);
      const beforeAt = before.rows[0]!.available_at.getTime();

      const claimed = await claimPendingWithdrawalApprovedEvents(client, 10);
      expect(claimed.some((e) => e.aggregateId === withdrawalId)).toBe(true);

      const after = await client.query<{ available_at: Date }>(
        `SELECT available_at FROM outbox_events
         WHERE event_type = $1 AND aggregate_id = $2::uuid AND status = 'PENDING'`,
        [WITHDRAWAL_APPROVED_OUTBOX_EVENT, withdrawalId],
      );
      // available_at is NOT a fencing bump for withdrawal.approved claims.
      expect(after.rows[0]!.available_at.getTime()).toBe(beforeAt);
    });
  });

  it('concurrent outbox claims serialize via SKIP LOCKED', async () => {
    const userId = await createTestUser(pool, '9603');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const withdrawalId = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });

    const clientA = await pool.connect();
    const clientB = await pool.connect();
    try {
      await clientA.query('BEGIN');
      const claimedA = await claimPendingWithdrawalApprovedEvents(clientA, 10);
      expect(claimedA.some((e) => e.aggregateId === withdrawalId)).toBe(true);

      await clientB.query('BEGIN');
      const claimedB = await claimPendingWithdrawalApprovedEvents(clientB, 10);
      expect(claimedB.some((e) => e.aggregateId === withdrawalId)).toBe(false);

      await clientA.query('COMMIT');
      await clientB.query('COMMIT');
    } finally {
      clientA.release();
      clientB.release();
    }
  });

  it('hot wallet monitor emits CHAIN_HISTORY_PROOF_REQUIRED (never silent PASS)', async () => {
    const report = await buildPhase10HotWalletMonitorReport(pool, {
      networkCode: 'TON_TESTNET',
      fakeChainEnabled: true,
      balanceObservations: { tonNanotons: '1000000000', jettonAtomic: '500000' },
      minGasReserveNanotons: '100000000',
      nextPayoutJettonAtomic: '100000',
      balanceBaseline: { tonNanotons: '1100000000', jettonAtomic: '600000' },
    });
    expect(report.chainHistoryProof.code).toBe('CHAIN_HISTORY_PROOF_REQUIRED');
    expect(report.notes.some((n) => n.includes('CHAIN_HISTORY_PROOF_REQUIRED'))).toBe(true);
    expect(report.gasReserve.sufficient).toBe(true);
    expect(report.jettonForNextPayout.sufficient).toBe(true);
    expect(report.balanceDelta.baselinePresent).toBe(true);
  });

  it('durable TEP-74 evidence insert is idempotent and readable for invariants', async () => {
    const userId = await createTestUser(pool, '9604');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const withdrawalId = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });

    const attempt = await withWithdrawalTransaction(pool, async (client) => {
      const owner = hotWalletDispatchOwnerIdentity(withdrawalId);
      const lease = await acquireHotWalletDispatchLease(client, hotWalletId, owner);
      if (lease.status !== 'ACQUIRED') throw new Error('lease');
      return createWithdrawalAttempt(client, {
        withdrawalId,
        hotWalletId,
        fencingToken: lease.fencingToken,
        signerKeyReference: 'TEST_ONLY_FAKE_HOT_1',
        leaseOwnerIdentity: owner,
      });
    });

    const summary = compactTep74EvidenceSummary({
      withdrawalId,
      attemptId: attempt.id,
      primary: {
        hotWallet: '0:hot',
        jettonMaster: '0:master',
        recipient: '0:recv',
        amountAtomic: '190000',
        queryId: attempt.queryId,
        success: true,
        bounced: false,
        transactionHash: 'primary-tx-1',
        providerKind: 'toncenter',
        proofStage: 'complete',
      },
      secondaryAgree: true,
      testPath: true,
    });

    await withWithdrawalTransaction(pool, async (client) => {
      const first = await persistIntendedPayoutProvenEvidence(client, {
        withdrawalId,
        attemptId: attempt.id,
        observedRecipient: '0:recv',
        observedAmountAtomic: '190000',
        observedQueryId: attempt.queryId,
        evidenceSummary: summary,
      });
      expect(first.created).toBe(true);
      const second = await persistIntendedPayoutProvenEvidence(client, {
        withdrawalId,
        attemptId: attempt.id,
        observedRecipient: '0:recv',
        observedAmountAtomic: '190000',
        observedQueryId: attempt.queryId,
        evidenceSummary: summary,
      });
      expect(second.created).toBe(false);
      expect(second.reconciliationId).toBe(first.reconciliationId);
    });

    const count = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM withdrawal_payout_reconciliations
       WHERE withdrawal_attempt_id = $1::uuid AND resolution = 'INTENDED_PAYOUT_PROVEN'`,
      [attempt.id],
    );
    expect(count.rows[0]?.c).toBe(1);
  });
});

describe('phase10 acceptance gate', () => {
  it('path-only sync gate never PASSes archive', () => {
    const refused = evaluatePhase10AcceptanceGate({
      campaignEvidencePath: null,
      failureInjectionEvidencePath: null,
      invariantResultsPath: null,
      readinessPassAtLiveWindow: false,
      controlledPayoutCountConfirmed: 0,
      duplicateEconomicPayouts: 0,
    });
    expect(refused.mayCreateFinalArchive).toBe(false);
    expect(refused.mayMarkPhase10Closed).toBe(false);
    expect(refused.verdict).toBe('REFUSED_MISSING_LIVE_EVIDENCE');

    const withPaths = evaluatePhase10AcceptanceGate({
      campaignEvidencePath: 'evidence/campaign.json',
      failureInjectionEvidencePath: 'evidence/failures.json',
      invariantResultsPath: 'evidence/invariants.json',
      readinessPassAtLiveWindow: true,
      controlledPayoutCountConfirmed: 100,
      duplicateEconomicPayouts: 0,
    });
    expect(withPaths.verdict).toBe('REFUSED_MISSING_LIVE_EVIDENCE');
    expect(withPaths.mayMarkPhase10Closed).toBe(false);
  });

  it('async DB-verifying gate refuses missing evidence files', async () => {
    if (phase7DatabaseUrl === '') return;
    const pool = new Pool({ connectionString: phase7DatabaseUrl });
    try {
      const result = await evaluatePhase10AcceptanceFromEvidence({
        db: pool,
        campaignEvidencePath: join(tmpdir(), 'missing-campaign.json'),
        failureInjectionEvidencePath: join(tmpdir(), 'missing-failures.json'),
        readinessEvidencePath: join(tmpdir(), 'missing-readiness.json'),
      });
      expect(result.mayCreateFinalArchive).toBe(false);
      expect(result.mayMarkPhase10Closed).toBe(false);
      expect(result.verdict).toBe('REFUSED_MISSING_LIVE_EVIDENCE');
    } finally {
      await pool.end();
    }
  });

  it('campaign manifest init is file-only and dry-run safe', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phase10-campaign-'));
    const path = join(dir, 'manifest.json');
    const manifest = await initCampaignManifest(path, {
      plannedCount: 100,
      controlledUserId: '00000000-0000-4000-8000-000000000001',
      mode: 'dry-run',
      amountPolicy: { grossAtomic: '200000', note: 'controlled' },
    });
    expect(manifest.createsWithdrawals).toBe(false);
    expect(manifest.flipsEnv).toBe(false);
    expect(manifest.networkCode).toBe('TON_TESTNET');
    expect(manifest.plannedPayoutCount).toBe(100);
    await writeFile(join(dir, 'note.txt'), 'ok', 'utf8');
  });
});

describe('FakeTonChainProvider sendBoc accepted:false', () => {
  it('returns accepted:false without throwing', async () => {
    const fake = new FakeTonChainProvider({ sendBocAcceptedFalse: true });
    const result = await fake.sendBoc('Ym9j');
    expect(result.accepted).toBe(false);
    expect(fake.getSendBocCallCount()).toBe(1);
  });
});

function baseIntendedProof(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    proofStage: 'COMPLETE',
    tep74Complete: true,
    withdrawalId: '11111111-1111-4111-8111-111111111111',
    attemptId: '22222222-2222-4222-8222-222222222222',
    queryId: '12345',
    recipient: '0:recv',
    amountAtomic: '190000',
    jettonMaster: '0:master',
    hotWallet: '0:hot',
    senderJettonWallet: '0:sjw',
    networkGlobalId: -3,
    success: true,
    bounced: false,
    nonBounce: true,
    txIdentity: 'primary-tx-1',
    testPath: false,
    secondaryAgree: true,
    primaryProviderKind: 'toncenter',
    secondaryProviderKind: 'tonapi',
    secondaryProofStage: 'COMPLETE',
    secondaryTxIdentity: 'secondary-tx-1',
    secondarySuccess: true,
    secondaryNonBounce: true,
    ...overrides,
  };
}

const baseExpected = {
  withdrawalId: '11111111-1111-4111-8111-111111111111',
  attemptId: '22222222-2222-4222-8222-222222222222',
  queryId: '12345',
  recipient: '0:recv',
  amountAtomic: '190000',
  jettonMaster: '0:master',
  hotWallet: '0:hot',
  senderJettonWallet: '0:sjw',
} as const;

describe('phase10 pre-commit blocker regressions', () => {
  it('missing TEP-74 network fails complete proof', () => {
    const proof = baseIntendedProof({ networkGlobalId: undefined });
    delete proof.networkGlobalId;
    expect(isCompleteIntendedPayoutProof(proof, baseExpected)).toBe(false);
  });

  it('missing attempt binding fails complete proof', () => {
    const proof = baseIntendedProof({ attemptId: undefined });
    delete proof.attemptId;
    expect(isCompleteIntendedPayoutProof(proof, baseExpected)).toBe(false);
  });

  it('missing Hot Wallet binding fails complete proof', () => {
    const proof = baseIntendedProof({ hotWallet: undefined });
    delete proof.hotWallet;
    expect(isCompleteIntendedPayoutProof(proof, baseExpected)).toBe(false);
  });

  it('missing sender Jetton wallet binding fails complete proof', () => {
    const proof = baseIntendedProof({ senderJettonWallet: undefined });
    delete proof.senderJettonWallet;
    expect(isCompleteIntendedPayoutProof(proof, baseExpected)).toBe(false);
  });

  it('local/testPath proof cannot satisfy live acceptance proof', () => {
    const proof = baseIntendedProof({ testPath: true });
    expect(isCompleteIntendedPayoutProof(proof, baseExpected)).toBe(true);
    expect(
      isCompleteIntendedPayoutProof(proof, baseExpected, { requireLiveAcceptanceProof: true }),
    ).toBe(false);
  });

  it('missing secondary evidence fails live acceptance proof', () => {
    const proof = baseIntendedProof({
      secondaryTxIdentity: undefined,
      secondaryProviderKind: undefined,
    });
    delete proof.secondaryTxIdentity;
    delete proof.secondaryProviderKind;
    expect(
      isCompleteIntendedPayoutProof(proof, baseExpected, { requireLiveAcceptanceProof: true }),
    ).toBe(false);
  });

  it('readiness JSON with only ok:true is REFUSED', () => {
    const errors = validateLiveReadinessEvidence({ ok: true });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('liveAuthorizationWindow') || e.includes('verdict'))).toBe(
      true,
    );
  });

  it('readiness without liveAuthorizationWindow:true is REFUSED', () => {
    const errors = validateLiveReadinessEvidence({
      verdict: 'READY_FOR_CONTROLLED_LIVE_TESTNET',
      realChainEnabled: true,
      fakeChainEnabled: false,
      networkCode: 'TON_TESTNET',
      assetSymbol: 'USDT',
      controlledUserId: '00000000-0000-4000-8000-000000000001',
      recordedAt: new Date().toISOString(),
      signerProbed: true,
      signerUnlocked: true,
      liveAuthorizationWindow: false,
    });
    expect(errors.some((e) => e.includes('liveAuthorizationWindow'))).toBe(true);
  });

  it('missing required failure scenario is REFUSED', () => {
    const required = PHASE10_REQUIRED_REAL_FAILURE_SCENARIO_IDS;
    expect(required.length).toBeGreaterThan(0);
    const partial = required.slice(0, -1).map((id) => ({
      id,
      present: true,
      executed: true,
      classification: 'REQUIRES_REAL_TESTNET',
      status: 'COMPLETED',
      result: { ok: true },
    }));
    const errors = validateFailureInjectionEvidence({
      scenarios: partial,
      requiredScenarioIds: required,
    });
    expect(errors.some((e) => e.includes('required failure scenario missing'))).toBe(true);
  });

  it('single requiredScenarioId cannot reduce authoritative REAL set', () => {
    const required = PHASE10_REQUIRED_REAL_FAILURE_SCENARIO_IDS;
    expect(required.length).toBeGreaterThan(1);
    const onlyOne = required[0]!;
    const errors = validateFailureInjectionEvidence({
      requiredScenarioIds: [onlyOne],
      scenarios: [
        {
          id: onlyOne,
          present: true,
          executed: true,
          classification: 'REQUIRES_REAL_TESTNET',
          status: 'COMPLETED',
          result: { ok: true },
        },
      ],
    });
    expect(errors.some((e) => e.includes('omits authoritative') || e.includes('missing'))).toBe(
      true,
    );
  });

  it('present:true alone is REFUSED for failure evidence', () => {
    const errors = validateFailureInjectionEvidence({ present: true, ok: true });
    expect(errors.some((e) => e.includes('alone') || e.includes('scenarios'))).toBe(true);
  });

  it('missing classification on REAL scenario is REFUSED', () => {
    const required = PHASE10_REQUIRED_REAL_FAILURE_SCENARIO_IDS;
    const errors = validateFailureInjectionEvidence({
      scenarios: required.map((id) => ({
        id,
        present: true,
        executed: true,
        status: 'COMPLETED',
        result: { ok: true },
      })),
    });
    expect(errors.some((e) => e.includes('missing classification'))).toBe(true);
  });

  it('invalid classification on REAL scenario is REFUSED', () => {
    const required = PHASE10_REQUIRED_REAL_FAILURE_SCENARIO_IDS;
    for (const classification of ['NOT_A_REAL_CLASS', 'LOCAL_DETERMINISTIC'] as const) {
      const errors = validateFailureInjectionEvidence({
        scenarios: required.map((id) => ({
          id,
          present: true,
          executed: true,
          classification,
          status: 'COMPLETED',
          result: { ok: true },
        })),
      });
      expect(errors.some((e) => e.includes('must be REQUIRES_REAL_TESTNET'))).toBe(true);
    }
  });

  it('status COMPLETED without result/evidence is REFUSED', () => {
    const required = PHASE10_REQUIRED_REAL_FAILURE_SCENARIO_IDS;
    const errors = validateFailureInjectionEvidence({
      scenarios: required.map((id) => ({
        id,
        present: true,
        executed: true,
        classification: 'REQUIRES_REAL_TESTNET',
        status: 'COMPLETED',
      })),
    });
    expect(errors.some((e) => e.includes('missing evidence/result'))).toBe(true);
  });

  it('campaign cannot become COMPLETED merely by calling final evidence generator early', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phase10-final-'));
    const path = join(dir, 'manifest.json');
    await initCampaignManifest(path, {
      plannedCount: 100,
      controlledUserId: '00000000-0000-4000-8000-000000000099',
      mode: 'dry-run',
      amountPolicy: { grossAtomic: '200000', note: 'early' },
    });
    if (phase7DatabaseUrl === '') {
      // File-only path still must not claim COMPLETED without DB-backed completion.
      const { resumeCampaign } = await import('../src/index.js');
      const before = await resumeCampaign(path);
      expect(before.status).not.toBe('COMPLETED');
      return;
    }
    const pool = new Pool({ connectionString: phase7DatabaseUrl });
    try {
      const after = await generateFinalCampaignEvidence(path, pool);
      expect(after.status).not.toBe('COMPLETED');
    } finally {
      await pool.end();
    }
  });
});

describe.skipIf(phase7DatabaseUrl === '')('phase10 pre-commit blocker DB regressions', () => {
  let pool: Pool;
  let assetId: string;
  let networkId: string;
  let adminUserId: string;
  let hotWalletId: string;

  beforeAll(async () => {
    await resetAndMigrate(phase7DatabaseUrl);
    pool = new Pool({ connectionString: phase7DatabaseUrl });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await truncateWithdrawalTables(pool);
    const base = await seedPhase7Base(pool);
    assetId = base.assetId;
    networkId = base.networkId;
    adminUserId = base.adminUserId;
    hotWalletId = base.hotWalletId;
  });

  it('duplicate reservation rows/effects → invariant report ok=false', async () => {
    const userId = await createTestUser(pool, '9801');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const withdrawalId = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });

    await pool.query(
      `ALTER TABLE ledger_transactions DROP CONSTRAINT IF EXISTS ledger_transactions_business_reference_key`,
    );
    let duplicateId: string | null = null;
    try {
      const existing = await pool.query<{
        reservation_ledger_tx_id: string;
      }>(
        `SELECT reservation_ledger_tx_id::text AS reservation_ledger_tx_id
         FROM withdrawals WHERE id = $1::uuid`,
        [withdrawalId],
      );
      expect(existing.rows[0]?.reservation_ledger_tx_id).toBeTruthy();
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO ledger_transactions (
           transaction_type, business_reference_type, business_reference_id,
           idempotency_scope, idempotency_key, asset_id, created_by_type
         ) VALUES (
           'WITHDRAWAL_RESERVATION', 'withdrawal', $1::uuid,
           $2, 'reservation-dup', $3::uuid, 'SYSTEM'
         )
         RETURNING id::text AS id`,
        [withdrawalId, `withdrawal-reservation-dup:${withdrawalId}:${randomUUID()}`, assetId],
      );
      duplicateId = inserted.rows[0]!.id;

      const report = await checkPhase10PayoutInvariants(pool, withdrawalId);
      expect(report.ok).toBe(false);
      expect(report.findings.some((f) => f.code === 'DUPLICATE_RESERVATION')).toBe(true);
    } finally {
      if (duplicateId !== null) {
        await pool.query(`SET session_replication_role = replica`);
        await pool.query(`DELETE FROM ledger_transactions WHERE id = $1::uuid`, [duplicateId]);
        await pool.query(`SET session_replication_role = DEFAULT`);
      }
      await pool.query(
        `ALTER TABLE ledger_transactions
         ADD CONSTRAINT ledger_transactions_business_reference_key
         UNIQUE NULLS NOT DISTINCT (transaction_type, business_reference_type, business_reference_id)`,
      );
    }
  });

  async function insertIncompleteConfirmedProof(
    withdrawalId: string,
    summaryOverrides: Record<string, unknown>,
  ): Promise<void> {
    const attempt = await withWithdrawalTransaction(pool, async (client) => {
      const owner = hotWalletDispatchOwnerIdentity(withdrawalId);
      const lease = await acquireHotWalletDispatchLease(client, hotWalletId, owner);
      if (lease.status !== 'ACQUIRED') throw new Error('lease');
      return createWithdrawalAttempt(client, {
        withdrawalId,
        hotWalletId,
        fencingToken: lease.fencingToken,
        signerKeyReference: 'TEST_ONLY_FAKE_HOT_1',
        leaseOwnerIdentity: owner,
      });
    });

    const hot = await pool.query<{ address: string; payout_jetton_wallet_address: string | null }>(
      `SELECT address, payout_jetton_wallet_address FROM hot_wallets WHERE id = $1::uuid`,
      [hotWalletId],
    );
    const wallet = await pool.query<{ recipient: string }>(
      `SELECT COALESCE(uw.raw_address, uw.friendly_address) AS recipient
       FROM withdrawals w JOIN user_wallets uw ON uw.id = w.wallet_id WHERE w.id = $1::uuid`,
      [withdrawalId],
    );
    const asset = await pool.query<{ contract_identity: string | null }>(
      `SELECT contract_identity FROM assets WHERE id = $1::uuid`,
      [assetId],
    );

    const summary = {
      proofStage: 'COMPLETE',
      tep74Complete: true,
      withdrawalId,
      attemptId: attempt.id,
      queryId: attempt.queryId,
      recipient: wallet.rows[0]!.recipient,
      amountAtomic: '190000',
      jettonMaster: asset.rows[0]!.contract_identity ?? '0:master',
      hotWallet: hot.rows[0]!.address,
      senderJettonWallet: hot.rows[0]!.payout_jetton_wallet_address ?? '0:sjw',
      networkGlobalId: -3,
      success: true,
      bounced: false,
      nonBounce: true,
      txIdentity: 'tx-incomplete-case',
      testPath: false,
      secondaryAgree: true,
      primaryProviderKind: 'toncenter',
      secondaryProviderKind: 'tonapi',
      secondaryProofStage: 'COMPLETE',
      secondaryTxIdentity: 'sec-tx',
      secondarySuccess: true,
      secondaryNonBounce: true,
      ...summaryOverrides,
    };
    for (const [k, v] of Object.entries(summaryOverrides)) {
      if (v === undefined) delete (summary as Record<string, unknown>)[k];
    }

    await withWithdrawalTransaction(pool, async (client) => {
      await persistIntendedPayoutProvenEvidence(client, {
        withdrawalId,
        attemptId: attempt.id,
        observedRecipient: String(summary.recipient),
        observedAmountAtomic: String(summary.amountAtomic),
        observedQueryId: String(summary.queryId),
        evidenceSummary: summary,
      });
    });

    await pool.query(
      `UPDATE withdrawals
       SET state = 'CONFIRMED', confirmed_at = now(), updated_at = now()
       WHERE id = $1::uuid`,
      [withdrawalId],
    );
  }

  it('missing TEP-74 network → CHAIN_PROOF_REQUIRED', async () => {
    const userId = await createTestUser(pool, '9802');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const withdrawalId = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    await insertIncompleteConfirmedProof(withdrawalId, { networkGlobalId: undefined });
    const report = await checkPhase10PayoutInvariants(pool, withdrawalId);
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.code === 'CHAIN_PROOF_REQUIRED')).toBe(true);
  });

  it('missing attempt binding → CHAIN_PROOF_REQUIRED', async () => {
    const userId = await createTestUser(pool, '9803');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const withdrawalId = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    await insertIncompleteConfirmedProof(withdrawalId, { attemptId: undefined });
    const report = await checkPhase10PayoutInvariants(pool, withdrawalId);
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.code === 'CHAIN_PROOF_REQUIRED')).toBe(true);
  });

  it('missing Hot Wallet binding → CHAIN_PROOF_REQUIRED', async () => {
    const userId = await createTestUser(pool, '9804');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const withdrawalId = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    await insertIncompleteConfirmedProof(withdrawalId, { hotWallet: undefined });
    const report = await checkPhase10PayoutInvariants(pool, withdrawalId);
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.code === 'CHAIN_PROOF_REQUIRED')).toBe(true);
  });

  it('missing sender Jetton wallet binding → CHAIN_PROOF_REQUIRED', async () => {
    const userId = await createTestUser(pool, '9805');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await pool.query(
      `UPDATE hot_wallets
       SET payout_jetton_wallet_address = '0:forced-sender-jetton'
       WHERE id = $1::uuid`,
      [hotWalletId],
    );
    const withdrawalId = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    await insertIncompleteConfirmedProof(withdrawalId, { senderJettonWallet: undefined });
    const report = await checkPhase10PayoutInvariants(pool, withdrawalId);
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.code === 'CHAIN_PROOF_REQUIRED')).toBe(true);
  });

  it('testPath proof fails live acceptance chain proof', async () => {
    const userId = await createTestUser(pool, '9806');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const withdrawalId = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    await insertIncompleteConfirmedProof(withdrawalId, { testPath: true });
    const report = await checkPhase10PayoutInvariants(pool, withdrawalId, {
      requireLiveAcceptanceProof: true,
    });
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.code === 'CHAIN_PROOF_REQUIRED')).toBe(true);
  });

  it('missing secondary evidence → CHAIN_PROOF_REQUIRED under live acceptance', async () => {
    const userId = await createTestUser(pool, '9807');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const withdrawalId = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    await insertIncompleteConfirmedProof(withdrawalId, {
      secondaryTxIdentity: undefined,
      secondaryProviderKind: undefined,
      secondaryProofStage: undefined,
    });
    const report = await checkPhase10PayoutInvariants(pool, withdrawalId, {
      requireLiveAcceptanceProof: true,
    });
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.code === 'CHAIN_PROOF_REQUIRED')).toBe(true);
  });

  it('arbitrary unrelated confirmed withdrawal cannot count toward campaign 100', async () => {
    const controlled = await createTestUser(pool, '9810');
    const outsider = await createTestUser(pool, '9811');
    await bindVerifiedPrimaryWallet(pool, controlled, networkId);
    await bindVerifiedPrimaryWallet(pool, outsider, networkId);
    const outsiderWd = await createApprovedWithdrawal(pool, {
      userId: outsider,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    await pool.query(
      `UPDATE withdrawals SET state = 'CONFIRMED', confirmed_at = now(),
         settlement_ledger_tx_id = reservation_ledger_tx_id WHERE id = $1::uuid`,
      [outsiderWd],
    );

    const dir = await mkdtemp(join(tmpdir(), 'phase10-camp-'));
    const campaignPath = join(dir, 'campaign.json');
    const failurePath = join(dir, 'failures.json');
    const readinessPath = join(dir, 'readiness.json');

    await writeFile(
      campaignPath,
      JSON.stringify({
        campaignId: randomUUID(),
        networkCode: 'TON_TESTNET',
        assetSymbol: 'USDT',
        acceptanceCampaign: true,
        mode: 'real',
        controlledUserId: controlled,
        plannedCount: 100,
        withdrawals: [outsiderWd],
      }),
      'utf8',
    );
    await writeFile(
      failurePath,
      JSON.stringify({
        requiredScenarioIds: PHASE10_REQUIRED_REAL_FAILURE_SCENARIO_IDS,
        scenarios: PHASE10_REQUIRED_REAL_FAILURE_SCENARIO_IDS.map((id) => ({
          id,
          present: true,
          executed: true,
          classification: 'REQUIRES_REAL_TESTNET',
          status: 'COMPLETED',
          result: { ok: true },
        })),
      }),
      'utf8',
    );
    await writeFile(
      readinessPath,
      JSON.stringify({
        liveAuthorizationWindow: true,
        verdict: 'READY_FOR_CONTROLLED_LIVE_TESTNET',
        realChainEnabled: true,
        fakeChainEnabled: false,
        networkCode: 'TON_TESTNET',
        assetSymbol: 'USDT',
        controlledUserId: controlled,
        recordedAt: new Date().toISOString(),
        signerProbed: true,
        signerUnlocked: true,
      }),
      'utf8',
    );

    const result = await evaluatePhase10AcceptanceFromEvidence({
      db: pool,
      campaignEvidencePath: campaignPath,
      failureInjectionEvidencePath: failurePath,
      readinessEvidencePath: readinessPath,
    });
    expect(result.mayCreateFinalArchive).toBe(false);
    expect(result.confirmedCount).toBe(0);
    expect(
      result.verdict === 'REFUSED_CAMPAIGN_BINDING' ||
        result.verdict === 'REFUSED_INSUFFICIENT_CONFIRMED_COUNT' ||
        result.verdict === 'REFUSED_INVARIANT_FAILURE' ||
        result.verdict === 'REFUSED_CHAIN_PROOF_REQUIRED' ||
        result.verdict === 'REFUSED_MISSING_LIVE_EVIDENCE',
    ).toBe(true);
  });

  it('wrong controlled user → REFUSED', async () => {
    const controlled = await createTestUser(pool, '9812');
    const other = await createTestUser(pool, '9813');
    await bindVerifiedPrimaryWallet(pool, other, networkId);
    const wd = await createApprovedWithdrawal(pool, {
      userId: other,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    const dir = await mkdtemp(join(tmpdir(), 'phase10-user-'));
    const campaignPath = join(dir, 'campaign.json');
    const failurePath = join(dir, 'failures.json');
    const readinessPath = join(dir, 'readiness.json');
    await writeFile(
      campaignPath,
      JSON.stringify({
        campaignId: randomUUID(),
        networkCode: 'TON_TESTNET',
        assetSymbol: 'USDT',
        acceptanceCampaign: true,
        mode: 'real',
        controlledUserId: controlled,
        plannedCount: 100,
        withdrawals: [wd],
      }),
      'utf8',
    );
    await writeFile(
      failurePath,
      JSON.stringify({
        requiredScenarioIds: PHASE10_REQUIRED_REAL_FAILURE_SCENARIO_IDS,
        scenarios: PHASE10_REQUIRED_REAL_FAILURE_SCENARIO_IDS.map((id) => ({
          id,
          present: true,
          executed: true,
          classification: 'REQUIRES_REAL_TESTNET',
          status: 'COMPLETED',
          result: { ok: true },
        })),
      }),
      'utf8',
    );
    await writeFile(
      readinessPath,
      JSON.stringify({
        liveAuthorizationWindow: true,
        verdict: 'READY_FOR_CONTROLLED_LIVE_TESTNET',
        realChainEnabled: true,
        fakeChainEnabled: false,
        networkCode: 'TON_TESTNET',
        assetSymbol: 'USDT',
        controlledUserId: controlled,
        recordedAt: new Date().toISOString(),
        signerProbed: true,
        signerUnlocked: true,
      }),
      'utf8',
    );
    const result = await evaluatePhase10AcceptanceFromEvidence({
      db: pool,
      campaignEvidencePath: campaignPath,
      failureInjectionEvidencePath: failurePath,
      readinessEvidencePath: readinessPath,
    });
    expect(result.verdict).toBe('REFUSED_CAMPAIGN_BINDING');
    expect(result.mayCreateFinalArchive).toBe(false);
  });

  it('wrong network/asset in campaign evidence → REFUSED', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phase10-net-'));
    const campaignPath = join(dir, 'campaign.json');
    const failurePath = join(dir, 'failures.json');
    const readinessPath = join(dir, 'readiness.json');
    await writeFile(
      campaignPath,
      JSON.stringify({
        campaignId: randomUUID(),
        networkCode: 'TON_MAINNET',
        assetSymbol: 'USDT',
        acceptanceCampaign: true,
        mode: 'real',
        controlledUserId: '00000000-0000-4000-8000-000000000012',
        plannedCount: 100,
        withdrawals: [randomUUID()],
      }),
      'utf8',
    );
    await writeFile(failurePath, JSON.stringify({ scenarios: [] }), 'utf8');
    await writeFile(readinessPath, JSON.stringify({ ok: true }), 'utf8');
    const result = await evaluatePhase10AcceptanceFromEvidence({
      db: pool,
      campaignEvidencePath: campaignPath,
      failureInjectionEvidencePath: failurePath,
      readinessEvidencePath: readinessPath,
    });
    expect(result.verdict).toBe('REFUSED_CAMPAIGN_BINDING');
    expect(result.reasons.some((r) => r.includes('TON_TESTNET'))).toBe(true);
  });

  it('duplicate campaign withdrawal ids do not increase confirmed count', async () => {
    const userId = await createTestUser(pool, '9814');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const wd = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    await insertIncompleteConfirmedProof(wd, {});
    const campaignId = randomUUID();
    const dir = await mkdtemp(join(tmpdir(), 'phase10-dupids-'));
    const campaignPath = join(dir, 'campaign.json');
    const failurePath = join(dir, 'failures.json');
    const readinessPath = join(dir, 'readiness.json');
    await writeFile(
      campaignPath,
      JSON.stringify({
        campaignId,
        networkCode: 'TON_TESTNET',
        assetSymbol: 'USDT',
        acceptanceCampaign: true,
        mode: 'real',
        controlledUserId: userId,
        plannedCount: 100,
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        withdrawals: Array.from({ length: 100 }, () => wd),
        evidence: Array.from({ length: 100 }, (_, i) => ({
          campaignId,
          withdrawalId: wd,
          ordinal: i + 1,
        })),
      }),
      'utf8',
    );
    await writeFile(
      failurePath,
      JSON.stringify({
        requiredScenarioIds: PHASE10_REQUIRED_REAL_FAILURE_SCENARIO_IDS,
        scenarios: PHASE10_REQUIRED_REAL_FAILURE_SCENARIO_IDS.map((id) => ({
          id,
          present: true,
          executed: true,
          classification: 'REQUIRES_REAL_TESTNET',
          status: 'COMPLETED',
          result: { ok: true },
        })),
      }),
      'utf8',
    );
    await writeFile(
      readinessPath,
      JSON.stringify({
        liveAuthorizationWindow: true,
        verdict: 'READY_FOR_CONTROLLED_LIVE_TESTNET',
        realChainEnabled: true,
        fakeChainEnabled: false,
        networkCode: 'TON_TESTNET',
        assetSymbol: 'USDT',
        controlledUserId: userId,
        recordedAt: new Date().toISOString(),
        signerProbed: true,
        signerUnlocked: true,
      }),
      'utf8',
    );
    const result = await evaluatePhase10AcceptanceFromEvidence({
      db: pool,
      campaignEvidencePath: campaignPath,
      failureInjectionEvidencePath: failurePath,
      readinessEvidencePath: readinessPath,
    });
    expect(result.verdict).toBe('REFUSED_CAMPAIGN_BINDING');
    expect(result.confirmedCount).toBe(0);
    expect(result.mayCreateFinalArchive).toBe(false);
  });

  async function writeValidFailureAndReadiness(
    failurePath: string,
    readinessPath: string,
    controlledUserId: string,
  ): Promise<string> {
    await writeFile(
      failurePath,
      JSON.stringify({
        requiredScenarioIds: PHASE10_REQUIRED_REAL_FAILURE_SCENARIO_IDS,
        scenarios: PHASE10_REQUIRED_REAL_FAILURE_SCENARIO_IDS.map((id) => ({
          id,
          present: true,
          executed: true,
          classification: 'REQUIRES_REAL_TESTNET',
          status: 'COMPLETED',
          result: { ok: true },
        })),
      }),
      'utf8',
    );
    const recordedAt = new Date().toISOString();
    await writeFile(
      readinessPath,
      JSON.stringify({
        schemaVersion: 1,
        liveAuthorizationWindow: true,
        verdict: 'READY_FOR_CONTROLLED_LIVE_TESTNET',
        realChainEnabled: true,
        fakeChainEnabled: false,
        networkCode: 'TON_TESTNET',
        assetSymbol: 'USDT',
        controlledUserId,
        recordedAt,
        signerProbed: true,
        signerReady: true,
        signerUnlocked: true,
        signerLockState: 'UNLOCKED',
        signerCustodyState: 'UNLOCKED',
        preflightBlockers: [],
        preflightWarnings: [],
        restoreScanSummary: {
          dangerousCount: 0,
          warnCount: 0,
          scannedAt: recordedAt,
          historicalIsolatedBaselineCount: 0,
        },
        providers: {
          primary: {
            kind: 'toncenter',
            endpointFingerprint: 'https://toncenter.test:443',
            healthy: true,
            observedNetworkGlobalId: -3,
          },
          secondary: {
            kind: 'tonapi',
            endpointFingerprint: 'https://tonapi.test:443',
            healthy: true,
            observedNetworkGlobalId: -3,
          },
          independenceProven: true,
          independenceCode: null,
        },
        externalProbes: {
          schemaVersion: 1,
          observedAt: recordedAt,
          primary: {
            kind: 'toncenter',
            endpointFingerprint: 'https://toncenter.test:443',
            reachable: true,
            healthy: true,
            observedNetworkGlobalId: -3,
            latencyMs: 1,
            detail: null,
            observedAt: recordedAt,
          },
          secondary: {
            kind: 'tonapi',
            endpointFingerprint: 'https://tonapi.test:443',
            reachable: true,
            healthy: true,
            observedNetworkGlobalId: -3,
            latencyMs: 1,
            detail: null,
            observedAt: recordedAt,
          },
          providerIndependence: {
            proven: true,
            code: null,
            reason: null,
            primaryFingerprint: 'https://toncenter.test:443',
            secondaryFingerprint: 'https://tonapi.test:443',
          },
          signer: {
            probePerformed: true,
            healthReachable: true,
            custodyState: 'UNLOCKED',
            signingReady: true,
            expectedCustodyMode: 'self_hosted_encrypted',
            identityProbed: true,
            publicKeyFingerprint: 'aa'.repeat(32),
            walletAddressRaw: '0:hot',
            identityMatchesExpected: true,
            walletAddressMatchesExpected: true,
            expectedPublicKeyFingerprintPresent: true,
            expectedWalletAddressPresent: true,
            httpStatus: 200,
            detail: null,
            observedAt: recordedAt,
          },
          overallBlocked: false,
          blockers: [],
        },
        preflight: {
          verdict: 'READY_FOR_CONTROLLED_LIVE_TESTNET',
          liveAuthorizationWindow: true,
          realChainEnabled: true,
          fakeChainEnabled: false,
          networkCode: 'TON_TESTNET',
          assetSymbol: 'USDT',
          controlledUserId,
          recordedAt,
          signerProbed: true,
          signerReady: true,
          signerUnlocked: true,
          signerLockState: 'UNLOCKED',
        },
      }),
      'utf8',
    );
    const chainHistoryPath = join(dirname(readinessPath), 'chain-history.json');
    const artifact = buildPhase10ProviderBackedChainHistoryEvidence({
      hotWalletAddress: '0:hot',
      hotWalletJettonWallet: '0:jetton',
      jettonMaster: '0:master',
      networkGlobalId: -3,
      observationWindow: {
        start: new Date(Date.now() - 3600_000).toISOString(),
        end: new Date().toISOString(),
      },
      providerIdentity: {
        primaryKind: 'toncenter',
        primaryEndpointFingerprint: 'https://toncenter.test:443',
        secondaryKind: 'tonapi',
        secondaryEndpointFingerprint: 'https://tonapi.test:443',
        independenceProven: true,
      },
      providerEnumeratedOutgoingTransfers: [],
      expectedCampaignPayoutIdentities: [],
    });
    await writeFile(chainHistoryPath, JSON.stringify(artifact), 'utf8');
    return chainHistoryPath;
  }

  it('readiness controlled user A vs campaign user B → REFUSED_CAMPAIGN_BINDING', async () => {
    const userA = await createTestUser(pool, '9820');
    const userB = await createTestUser(pool, '9821');
    await bindVerifiedPrimaryWallet(pool, userB, networkId);
    const wd = await createApprovedWithdrawal(pool, {
      userId: userB,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    const campaignId = randomUUID();
    const dir = await mkdtemp(join(tmpdir(), 'phase10-userbind-'));
    const campaignPath = join(dir, 'campaign.json');
    const failurePath = join(dir, 'failures.json');
    const readinessPath = join(dir, 'readiness.json');
    await writeFile(
      campaignPath,
      JSON.stringify({
        campaignId,
        networkCode: 'TON_TESTNET',
        assetSymbol: 'USDT',
        acceptanceCampaign: true,
        mode: 'real',
        controlledUserId: userB,
        plannedCount: 100,
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        withdrawals: [wd],
        evidence: [{ campaignId, withdrawalId: wd, ordinal: 1 }],
      }),
      'utf8',
    );
    const chainHistoryPath = await writeValidFailureAndReadiness(failurePath, readinessPath, userA);
    const result = await evaluatePhase10AcceptanceFromEvidence({
      db: pool,
      campaignEvidencePath: campaignPath,
      failureInjectionEvidencePath: failurePath,
      readinessEvidencePath: readinessPath,
      chainHistoryEvidencePath: chainHistoryPath,
    });
    expect(result.verdict).toBe('REFUSED_CAMPAIGN_BINDING');
    expect(result.reasons.some((r) => r.includes('controlledUserId'))).toBe(true);
  });

  it('old CONFIRMED withdrawal before campaign.createdAt → REFUSED_CAMPAIGN_BINDING', async () => {
    const userId = await createTestUser(pool, '9822');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const wd = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    await insertIncompleteConfirmedProof(wd, {});
    // Campaign createdAt is after the withdrawal's requested_at.
    const campaignCreatedAt = new Date(Date.now() + 60_000).toISOString();
    const campaignId = randomUUID();
    const dir = await mkdtemp(join(tmpdir(), 'phase10-oldwd-'));
    const campaignPath = join(dir, 'campaign.json');
    const failurePath = join(dir, 'failures.json');
    const readinessPath = join(dir, 'readiness.json');
    await writeFile(
      campaignPath,
      JSON.stringify({
        campaignId,
        networkCode: 'TON_TESTNET',
        assetSymbol: 'USDT',
        acceptanceCampaign: true,
        mode: 'real',
        controlledUserId: userId,
        plannedCount: 100,
        createdAt: campaignCreatedAt,
        withdrawals: [wd],
        evidence: [{ campaignId, withdrawalId: wd, ordinal: 1 }],
      }),
      'utf8',
    );
    const chainHistoryPath = await writeValidFailureAndReadiness(
      failurePath,
      readinessPath,
      userId,
    );
    const result = await evaluatePhase10AcceptanceFromEvidence({
      db: pool,
      campaignEvidencePath: campaignPath,
      failureInjectionEvidencePath: failurePath,
      readinessEvidencePath: readinessPath,
      chainHistoryEvidencePath: chainHistoryPath,
    });
    expect(result.verdict).toBe('REFUSED_CAMPAIGN_BINDING');
    expect(result.confirmedCount).toBe(0);
    expect(result.reasons.some((r) => r.includes('before campaign.createdAt'))).toBe(true);
  });

  it('counted withdrawal missing evidence record → REFUSED', async () => {
    const userId = await createTestUser(pool, '9823');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const wd = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    const campaignId = randomUUID();
    const dir = await mkdtemp(join(tmpdir(), 'phase10-noev-'));
    const campaignPath = join(dir, 'campaign.json');
    const failurePath = join(dir, 'failures.json');
    const readinessPath = join(dir, 'readiness.json');
    await writeFile(
      campaignPath,
      JSON.stringify({
        campaignId,
        networkCode: 'TON_TESTNET',
        assetSymbol: 'USDT',
        acceptanceCampaign: true,
        mode: 'real',
        controlledUserId: userId,
        plannedCount: 100,
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        withdrawals: [wd],
        evidence: [],
      }),
      'utf8',
    );
    const chainHistoryPath = await writeValidFailureAndReadiness(
      failurePath,
      readinessPath,
      userId,
    );
    const result = await evaluatePhase10AcceptanceFromEvidence({
      db: pool,
      campaignEvidencePath: campaignPath,
      failureInjectionEvidencePath: failurePath,
      readinessEvidencePath: readinessPath,
      chainHistoryEvidencePath: chainHistoryPath,
    });
    expect(result.verdict).toBe('REFUSED_CAMPAIGN_BINDING');
    expect(result.reasons.some((r) => r.includes('missing evidence record'))).toBe(true);
  });

  it('evidence record missing campaignId → REFUSED', async () => {
    const userId = await createTestUser(pool, '9824');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const wd = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    const campaignId = randomUUID();
    const dir = await mkdtemp(join(tmpdir(), 'phase10-nocid-'));
    const campaignPath = join(dir, 'campaign.json');
    const failurePath = join(dir, 'failures.json');
    const readinessPath = join(dir, 'readiness.json');
    await writeFile(
      campaignPath,
      JSON.stringify({
        campaignId,
        networkCode: 'TON_TESTNET',
        assetSymbol: 'USDT',
        acceptanceCampaign: true,
        mode: 'real',
        controlledUserId: userId,
        plannedCount: 100,
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        withdrawals: [wd],
        evidence: [{ withdrawalId: wd, ordinal: 1 }],
      }),
      'utf8',
    );
    const chainHistoryPath = await writeValidFailureAndReadiness(
      failurePath,
      readinessPath,
      userId,
    );
    const result = await evaluatePhase10AcceptanceFromEvidence({
      db: pool,
      campaignEvidencePath: campaignPath,
      failureInjectionEvidencePath: failurePath,
      readinessEvidencePath: readinessPath,
      chainHistoryEvidencePath: chainHistoryPath,
    });
    expect(result.verdict).toBe('REFUSED_CAMPAIGN_BINDING');
    expect(result.reasons.some((r) => r.includes('missing campaignId'))).toBe(true);
  });

  it('duplicate ordinal → REFUSED', async () => {
    const userId = await createTestUser(pool, '9825');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const a = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    const b = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    const campaignId = randomUUID();
    const dir = await mkdtemp(join(tmpdir(), 'phase10-dupord-'));
    const campaignPath = join(dir, 'campaign.json');
    const failurePath = join(dir, 'failures.json');
    const readinessPath = join(dir, 'readiness.json');
    await writeFile(
      campaignPath,
      JSON.stringify({
        campaignId,
        networkCode: 'TON_TESTNET',
        assetSymbol: 'USDT',
        acceptanceCampaign: true,
        mode: 'real',
        controlledUserId: userId,
        plannedCount: 100,
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        withdrawals: [a, b],
        evidence: [
          { campaignId, withdrawalId: a, ordinal: 1 },
          { campaignId, withdrawalId: b, ordinal: 1 },
        ],
      }),
      'utf8',
    );
    const chainHistoryPath = await writeValidFailureAndReadiness(
      failurePath,
      readinessPath,
      userId,
    );
    const result = await evaluatePhase10AcceptanceFromEvidence({
      db: pool,
      campaignEvidencePath: campaignPath,
      failureInjectionEvidencePath: failurePath,
      readinessEvidencePath: readinessPath,
      chainHistoryEvidencePath: chainHistoryPath,
    });
    expect(result.verdict).toBe('REFUSED_CAMPAIGN_BINDING');
    expect(result.reasons.some((r) => r.includes('duplicate evidence ordinal'))).toBe(true);
  });

  it('evidence campaignId mismatch → REFUSED', async () => {
    const userId = await createTestUser(pool, '9826');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const wd = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    const campaignId = randomUUID();
    const dir = await mkdtemp(join(tmpdir(), 'phase10-cidmm-'));
    const campaignPath = join(dir, 'campaign.json');
    const failurePath = join(dir, 'failures.json');
    const readinessPath = join(dir, 'readiness.json');
    await writeFile(
      campaignPath,
      JSON.stringify({
        campaignId,
        networkCode: 'TON_TESTNET',
        assetSymbol: 'USDT',
        acceptanceCampaign: true,
        mode: 'real',
        controlledUserId: userId,
        plannedCount: 100,
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        withdrawals: [wd],
        evidence: [{ campaignId: randomUUID(), withdrawalId: wd, ordinal: 1 }],
      }),
      'utf8',
    );
    const chainHistoryPath = await writeValidFailureAndReadiness(
      failurePath,
      readinessPath,
      userId,
    );
    const result = await evaluatePhase10AcceptanceFromEvidence({
      db: pool,
      campaignEvidencePath: campaignPath,
      failureInjectionEvidencePath: failurePath,
      readinessEvidencePath: readinessPath,
      chainHistoryEvidencePath: chainHistoryPath,
    });
    expect(result.verdict).toBe('REFUSED_CAMPAIGN_BINDING');
    expect(result.reasons.some((r) => r.includes('campaignId mismatch'))).toBe(true);
  });

  const realCampaignGates = {
    ownerApprovedRealTestnet: true,
    realChainEnabledExplicit: true,
    fakeChainDisabledExplicit: true,
    controlledUserAllowlisted: true,
    fundingComplete: true,
    pauseAcknowledged: true,
  } as const;

  const realExecutionGates = {
    campaignIdProvided: true,
    maxCountProvided: true,
    controlledUserProvided: true,
    networkIsTonTestnet: true,
    realChainEnabledTrue: true,
    fakeChainEnabledFalse: true,
    readinessPass: true,
    signerUnlockedExternally: true,
    confirmationPhraseMatches: true,
  } as const;

  it('canonical generated manifest round-trips into acceptance gate (no hand-crafted withdrawals)', async () => {
    const userId = await createTestUser(pool, '9830');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);

    const dir = await mkdtemp(join(tmpdir(), 'phase10-roundtrip-'));
    const manifestPath = join(dir, 'manifest.json');
    const failurePath = join(dir, 'failures.json');
    const readinessPath = join(dir, 'readiness.json');

    await initCampaignManifest(manifestPath, {
      plannedCount: 100,
      controlledUserId: userId,
      mode: 'real',
      acceptanceCampaign: true,
      gates: realCampaignGates,
      realExecutionGates,
      confirmationPhrase: PHASE10_REAL_CAMPAIGN_CONFIRMATION_PHRASE,
      amountPolicy: { grossAtomic: '200000', note: 'roundtrip' },
    });
    const wd = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    await attachWithdrawal(manifestPath, wd);
    const generated = await generateFinalCampaignEvidence(manifestPath, pool);
    expect(generated.withdrawalIds).toContain(wd);
    expect(Array.isArray((generated as { withdrawals?: unknown }).withdrawals)).toBe(false);

    const chainHistoryPath = await writeValidFailureAndReadiness(
      failurePath,
      readinessPath,
      userId,
    );
    const result = await evaluatePhase10AcceptanceFromEvidence({
      db: pool,
      campaignEvidencePath: manifestPath,
      failureInjectionEvidencePath: failurePath,
      readinessEvidencePath: readinessPath,
      chainHistoryEvidencePath: chainHistoryPath,
    });
    // Structurally accepted: must not refuse for missing canonical withdrawalIds / withdrawals array.
    expect(result.reasons.every((r) => !r.includes('missing non-empty withdrawalIds'))).toBe(true);
    expect(result.reasons.every((r) => !r.includes('missing non-empty withdrawals'))).toBe(true);
    expect(result.verdict).not.toBe('REFUSED_CAMPAIGN_BINDING');
    expect(result.mayCreateFinalArchive).toBe(false);
    expect(result.verdict).not.toBe('PASS_EVIDENCE_PRESENT_OWNER_REVIEW_REQUIRED');
  }, 120_000);

  it('local/testPath proofs cannot COMPLETE a real acceptance campaign', async () => {
    const userId = await createTestUser(pool, '9831');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);

    const dir = await mkdtemp(join(tmpdir(), 'phase10-testpath-complete-'));
    const manifestPath = join(dir, 'manifest.json');
    await initCampaignManifest(manifestPath, {
      plannedCount: 100,
      controlledUserId: userId,
      mode: 'real',
      acceptanceCampaign: true,
      gates: realCampaignGates,
      realExecutionGates,
      confirmationPhrase: PHASE10_REAL_CAMPAIGN_CONFIRMATION_PHRASE,
    });

    const ids: string[] = [];
    for (let i = 0; i < 100; i += 1) {
      ids.push(randomUUID());
    }
    await attachWithdrawalIds(manifestPath, ids);
    const before = await resumeCampaign(manifestPath);
    // Synthesize local-grade PASS records (would wrongly look complete without live rescan).
    await writeEvidenceFile(
      manifestPath,
      ids.map((withdrawalId, i) => ({
        campaignId: before.campaignId,
        ordinal: i + 1,
        withdrawalId,
        publicId: null,
        userId,
        quoteId: null,
        grossAmountAtomic: '200000',
        netAmountAtomic: '190000',
        feeAmountAtomic: '10000',
        attemptId: null,
        attemptNumber: null,
        workflowId: null,
        queryId: null,
        hashes: {
          canonicalMessageHash: null,
          signedMessageHash: null,
          chainReference: null,
          intentHash: null,
        },
        providerProofIds: [],
        primaryProviderProofIdentity: 'local-primary',
        secondaryProviderProofIdentity: null,
        chainTxId: `local-tx-${i}`,
        recipient: '0:recv',
        jettonMaster: '0:master',
        finalState: 'CONFIRMED',
        settlementLedgerTxId: null,
        invariantResult: 'PASS',
        duplicateEconomicTransferResult: 'NONE',
        scenarioId: 'P10-LOCAL-CONFIRMED_SUCCESS',
        timing: {
          requestedAt: new Date().toISOString(),
          approvedAt: null,
          broadcastedAt: null,
          confirmedAt: new Date().toISOString(),
          settledAt: null,
        },
        broadcastResultState: null,
        ambiguityClass: null,
        confirmed: true,
        settled: false,
        notes: 'local/testPath semantics',
        recordedAt: new Date().toISOString(),
      })),
    );

    const final = await generateFinalCampaignEvidence(manifestPath, pool);
    expect(final.status).not.toBe('COMPLETED');
    // Live rescan must clear synthetic local PASS for missing/non-live withdrawals.
    expect(final.evidence.every((e) => e.invariantResult !== 'PASS')).toBe(true);
  }, 120_000);

  it('generated real-campaign shape with live-grade evidence is structurally gate-compatible', async () => {
    const userId = await createTestUser(pool, '9832');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);

    const dir = await mkdtemp(join(tmpdir(), 'phase10-live-struct-'));
    const manifestPath = join(dir, 'manifest.json');
    const failurePath = join(dir, 'failures.json');
    const readinessPath = join(dir, 'readiness.json');
    // Init campaign BEFORE creating the withdrawal so requested_at >= campaign.createdAt.
    await initCampaignManifest(manifestPath, {
      plannedCount: 100,
      controlledUserId: userId,
      mode: 'real',
      acceptanceCampaign: true,
      gates: realCampaignGates,
      realExecutionGates,
      confirmationPhrase: PHASE10_REAL_CAMPAIGN_CONFIRMATION_PHRASE,
    });

    const wd = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    // Live-grade proof fields (still may fail settlement/fee invariants — structural gate path only).
    await insertIncompleteConfirmedProof(wd, {
      testPath: false,
      secondaryAgree: true,
      primaryProviderKind: 'toncenter',
      secondaryProviderKind: 'tonapi',
      secondaryProofStage: 'COMPLETE',
      secondaryTxIdentity: 'sec-live',
      secondarySuccess: true,
      secondaryNonBounce: true,
      networkGlobalId: -3,
    });

    await attachWithdrawal(manifestPath, wd);
    const generated = await generateFinalCampaignEvidence(manifestPath, pool);
    expect(generated.withdrawalIds).toEqual([wd]);
    expect(
      generated.evidence.some(
        (e) => e.withdrawalId === wd && e.campaignId === generated.campaignId,
      ),
    ).toBe(true);

    const chainHistoryPath = await writeValidFailureAndReadiness(
      failurePath,
      readinessPath,
      userId,
    );
    const result = await evaluatePhase10AcceptanceFromEvidence({
      db: pool,
      campaignEvidencePath: manifestPath,
      failureInjectionEvidencePath: failurePath,
      readinessEvidencePath: readinessPath,
      chainHistoryEvidencePath: chainHistoryPath,
    });
    expect(result.reasons.every((r) => !r.includes('missing non-empty withdrawalIds'))).toBe(true);
    expect(result.reasons.every((r) => !r.includes('missing non-empty withdrawals'))).toBe(true);
    // Structural acceptance of generated shape: content/evidence refusals OK;
    // binding refusals would mean the generated campaign is not gate-compatible.
    expect(result.verdict).not.toBe('REFUSED_CAMPAIGN_BINDING');
    expect(result.mayCreateFinalArchive).toBe(false);
    expect(result.verdict).not.toBe('PASS_EVIDENCE_PRESENT_OWNER_REVIEW_REQUIRED');
    expect([
      'REFUSED_INVARIANT_FAILURE',
      'REFUSED_CHAIN_PROOF_REQUIRED',
      'REFUSED_INSUFFICIENT_CONFIRMED_COUNT',
      'REFUSED_MISSING_LIVE_EVIDENCE',
      'REFUSED_UNRESOLVED_CAMPAIGN',
      'REFUSED_DUPLICATE_ECONOMIC_PAYOUT',
      'REFUSED_DUPLICATE_SETTLEMENT',
    ]).toContain(result.verdict);
  }, 120_000);
});
