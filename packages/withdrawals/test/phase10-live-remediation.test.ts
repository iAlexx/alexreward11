import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  PHASE10_PROVIDER_INDEPENDENCE_UNPROVEN,
  PHASE10_REAL_CAMPAIGN_CONFIRMATION_PHRASE,
  PHASE10_REQUIRED_REAL_FAILURE_SCENARIO_IDS,
  acquireHotWalletDispatchLease,
  attachWithdrawal,
  buildPhase10HotWalletMonitorReport,
  createWithdrawalAttempt,
  evaluatePhase10AcceptanceFromEvidence,
  evaluateProviderIndependence,
  fingerprintProviderEndpoint,
  generateFinalCampaignEvidence,
  hotWalletDispatchOwnerIdentity,
  initializeCampaign,
  parseLiveReadinessEvidence,
  resumeCampaign,
  runPhase10LiveExternalProbes,
  runPhase10Preflight,
  runPhase10RestoreReconcileScan,
  updateAttemptBroadcastState,
  withWithdrawalTransaction,
  writePhase10ChainHistoryEvidence,
  writePhase10LivePreflightEvidence,
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

describe.skipIf(phase7DatabaseUrl === '')('phase10 live remediation', () => {
  let pool: Pool;
  let networkId: string;
  let assetId: string;
  let adminUserId: string;
  let hotWalletId: string;

  beforeAll(async () => {
    await resetAndMigrate(phase7DatabaseUrl);
    pool = new Pool({ connectionString: phase7DatabaseUrl });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await truncateWithdrawalTables(pool);
    const base = await seedPhase7Base(pool);
    networkId = base.networkId;
    assetId = base.assetId;
    adminUserId = base.adminUserId;
    hotWalletId = base.hotWalletId;
  });

  const healthyInject = {
    primaryHealth: async () => ({ ok: true, networkGlobalId: -3, latencyMs: 1 }),
    secondaryHealth: async () => ({ ok: true, networkGlobalId: -3, latencyMs: 2 }),
    signerReady: async () => ({
      reachable: true,
      httpStatus: 200,
      signingReady: true,
      custodyState: 'UNLOCKED',
    }),
    signerIdentity: async () => null,
  };

  it('fingerprint treats same host with different paths as same effective backend', () => {
    expect(fingerprintProviderEndpoint('https://toncenter.example/api/v2')).toBe(
      fingerprintProviderEndpoint('https://toncenter.example/api/v3'),
    );
    const indep = evaluateProviderIndependence({
      primaryKind: 'toncenter',
      secondaryKind: 'toncenter',
      primaryUrl: 'https://same.example/a',
      secondaryUrl: 'https://same.example/b',
    });
    expect(indep.proven).toBe(false);
    expect(indep.code).toBe(PHASE10_PROVIDER_INDEPENDENCE_UNPROVEN);
  });

  it('injected signer unlocked without actual probe → BLOCKED', async () => {
    const report = await runPhase10Preflight(pool, {
      readinessConfig: {
        deploymentEnvironment: 'LOCAL',
        fakeChainEnabled: false,
        realChainEnabled: true,
        acceptedNetworkCode: 'TON_TESTNET',
        usdtSymbol: 'USDT',
        controlledUserId: randomUUID(),
        signerLocked: false,
        signerBaseUrlConfigured: true,
        signerServiceTokenConfigured: true,
        phase10: {
          realChainEnabled: true,
          jettonMasterIdentity: '0:master',
          primaryProviderKind: 'toncenter',
          primaryProviderUrl: 'https://primary.example',
          secondaryProviderKind: 'tonapi',
          secondaryProviderUrl: 'https://secondary.example',
          signerServiceToken: 'local-signer-service-token-32chars!!',
        },
      },
      skipRestoreScan: true,
      externalProbes: null,
    });
    expect(report.verdict).toBe('BLOCKED');
    expect(report.blockers.some((b) => b.includes('EXTERNAL_PROBES_REQUIRED'))).toBe(true);
  });

  it('primary provider unavailable → BLOCKED', async () => {
    const probes = await runPhase10LiveExternalProbes({
      primary: { kind: 'toncenter', baseUrl: 'https://primary.example' },
      secondary: { kind: 'tonapi', baseUrl: 'https://secondary.example' },
      signerBaseUrl: 'http://127.0.0.1:3005',
      inject: {
        ...healthyInject,
        primaryHealth: async () => ({ ok: false, networkGlobalId: -3, detail: 'down' }),
      },
    });
    expect(probes.overallBlocked).toBe(true);
    expect(probes.blockers.some((b) => b.includes('PRIMARY_PROVIDER'))).toBe(true);
  });

  it('secondary provider unavailable → BLOCKED', async () => {
    const probes = await runPhase10LiveExternalProbes({
      primary: { kind: 'toncenter', baseUrl: 'https://primary.example' },
      secondary: { kind: 'tonapi', baseUrl: 'https://secondary.example' },
      signerBaseUrl: 'http://127.0.0.1:3005',
      inject: {
        ...healthyInject,
        secondaryHealth: async () => ({ ok: false, networkGlobalId: -3, detail: 'down' }),
      },
    });
    expect(probes.overallBlocked).toBe(true);
    expect(probes.blockers.some((b) => b.includes('SECONDARY_PROVIDER'))).toBe(true);
  });

  it('same effective provider backend → BLOCKED', async () => {
    const probes = await runPhase10LiveExternalProbes({
      primary: { kind: 'toncenter', baseUrl: 'https://same.example/v2' },
      secondary: { kind: 'tonapi', baseUrl: 'https://same.example/v3' },
      signerBaseUrl: 'http://127.0.0.1:3005',
      inject: healthyInject,
    });
    expect(probes.providerIndependence.proven).toBe(false);
    expect(probes.overallBlocked).toBe(true);
    expect(probes.blockers.some((b) => b.includes(PHASE10_PROVIDER_INDEPENDENCE_UNPROVEN))).toBe(
      true,
    );
  });

  it('healthy independent providers + ready signer may clear probe blockers', async () => {
    const probes = await runPhase10LiveExternalProbes({
      primary: { kind: 'toncenter', baseUrl: 'https://primary.example' },
      secondary: { kind: 'tonapi', baseUrl: 'https://secondary.example' },
      signerBaseUrl: 'http://127.0.0.1:3005',
      inject: healthyInject,
    });
    expect(probes.overallBlocked).toBe(false);
    expect(probes.providerIndependence.proven).toBe(true);
    expect(probes.signer.signingReady).toBe(true);
  });

  it('authoritative isolated historical baseline does NOT block; pending outbox / new attempt do', async () => {
    const userId = await createTestUser(pool, '9901');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const wd = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });

    // Approval creates PENDING outbox — clear it so baseline isolation can apply.
    await pool.query(
      `UPDATE outbox_events SET status = 'DISPATCHED', dispatched_at = now()
       WHERE aggregate_id = $1::uuid AND status = 'PENDING'`,
      [wd],
    );

    let attemptId = '';
    await withWithdrawalTransaction(pool, async (client) => {
      const owner = hotWalletDispatchOwnerIdentity(wd);
      const lease = await acquireHotWalletDispatchLease(client, hotWalletId, owner);
      expect(lease.status).toBe('ACQUIRED');
      if (lease.status !== 'ACQUIRED') return;
      const attempt = await createWithdrawalAttempt(client, {
        withdrawalId: wd,
        hotWalletId,
        fencingToken: lease.fencingToken,
        signerKeyReference: 'TEST_ONLY_FAKE_HOT_1',
        leaseOwnerIdentity: owner,
      });
      attemptId = attempt.id;
      await updateAttemptBroadcastState(client, {
        attemptId: attempt.id,
        broadcastResultState: 'UNKNOWN',
        markBroadcastStarted: true,
      });
      await client.query(
        `UPDATE withdrawal_attempts
         SET broadcast_submitted_at = now() - interval '1 day'
         WHERE id = $1::uuid`,
        [attempt.id],
      );
    });

    // Window starts in the future so the attempt authoritatively predates it.
    const windowStart = new Date(Date.now() + 3_600_000).toISOString();
    const baseline = {
      attemptIds: [attemptId],
      capturedAt: new Date().toISOString(),
      attemptStates: { [attemptId]: { broadcastResultState: 'UNKNOWN' } },
    };

    const isolated = await runPhase10RestoreReconcileScan(pool, {
      historicalBaseline: baseline,
      liveAuthorizationWindowStartedAt: windowStart,
    });
    expect(
      isolated.findings.some(
        (f) =>
          f.attemptId === attemptId &&
          f.category === 'historical_isolated_baseline' &&
          f.severity !== 'DANGER',
      ),
    ).toBe(true);
    expect(
      isolated.findings.some((f) => f.attemptId === attemptId && f.severity === 'DANGER'),
    ).toBe(false);
    // Isolation must be keyed by authoritative attempt UUID, not hardcoded public IDs.
    expect(
      isolated.findings.some(
        (f) =>
          f.category === 'historical_isolated_baseline' &&
          f.attemptId === attemptId &&
          typeof f.attemptId === 'string' &&
          f.attemptId.includes('-'),
      ),
    ).toBe(true);

    // Pending approved outbox → blocks (DANGER).
    await pool.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, status)
       VALUES ('withdrawal', $1::uuid, $2, $3::jsonb, 'PENDING')`,
      [wd, 'withdrawal.approved', JSON.stringify({ withdrawalId: wd })],
    );
    const withOutbox = await runPhase10RestoreReconcileScan(pool, {
      historicalBaseline: baseline,
      liveAuthorizationWindowStartedAt: windowStart,
    });
    expect(
      withOutbox.findings.some((f) => f.attemptId === attemptId && f.severity === 'DANGER'),
    ).toBe(true);

    await pool.query(
      `UPDATE outbox_events SET status = 'DISPATCHED', dispatched_at = now()
       WHERE aggregate_id = $1::uuid AND status = 'PENDING'`,
      [wd],
    );

    // Same ambiguous attempt without authoritative baseline membership → DANGER.
    const withoutBaseline = await runPhase10RestoreReconcileScan(pool, {
      liveAuthorizationWindowStartedAt: windowStart,
    });
    expect(
      withoutBaseline.findings.some((f) => f.attemptId === attemptId && f.severity === 'DANGER'),
    ).toBe(true);
  }, 120_000);

  it('canonical live preflight evidence writer round-trips into acceptance parser', async () => {
    const userId = await createTestUser(pool, '9902');
    const probes = await runPhase10LiveExternalProbes({
      primary: { kind: 'toncenter', baseUrl: 'https://primary.example' },
      secondary: { kind: 'tonapi', baseUrl: 'https://secondary.example' },
      signerBaseUrl: 'http://127.0.0.1:3005',
      inject: healthyInject,
    });
    const readinessConfig = {
      deploymentEnvironment: 'LOCAL' as const,
      fakeChainEnabled: false,
      realChainEnabled: true,
      acceptedNetworkCode: 'TON_TESTNET',
      usdtSymbol: 'USDT',
      controlledUserId: userId,
      signerLocked: false as boolean | null,
      signerBaseUrlConfigured: true,
      signerServiceTokenConfigured: true,
      phase10: {
        realChainEnabled: true,
        jettonMasterIdentity: '0:master',
        primaryProviderKind: 'toncenter',
        primaryProviderUrl: 'https://primary.example',
        secondaryProviderKind: 'tonapi',
        secondaryProviderUrl: 'https://secondary.example',
        signerServiceToken: 'local-signer-service-token-32chars!!',
      },
    };
    const preflight = await runPhase10Preflight(pool, {
      readinessConfig,
      skipRestoreScan: true,
      externalProbes: probes,
    });
    // Remaining DB gates may still block READY; evidence writer still emits canonical shape.
    const dir = await mkdtemp(join(tmpdir(), 'phase10-evidence-'));
    const evidencePath = join(dir, 'live-preflight.json');
    const artifact = await writePhase10LivePreflightEvidence(evidencePath, {
      preflight: {
        ...preflight,
        verdict: 'READY_FOR_CONTROLLED_LIVE_TESTNET',
        blockers: [],
      },
      readinessConfig,
      externalProbes: probes,
      liveAuthorizationWindow: true,
    });
    expect(artifact.schemaVersion).toBe(1);
    expect(artifact.signerProbed).toBe(true);
    expect(artifact.signerReady).toBe(true);
    const parsed = parseLiveReadinessEvidence(artifact);
    expect(parsed.errors).toEqual([]);
    expect(parsed.parsed?.verdict).toBe('READY_FOR_CONTROLLED_LIVE_TESTNET');

    // Integration: generated artifact consumed by acceptance gate (structurally).
    const campaignPath = join(dir, 'campaign.json');
    const failurePath = join(dir, 'failures.json');
    const chainPath = join(dir, 'chain.json');
    await writeFile(
      campaignPath,
      JSON.stringify({
        campaignId: randomUUID(),
        networkCode: 'TON_TESTNET',
        assetSymbol: 'USDT',
        acceptanceCampaign: true,
        mode: 'real',
        controlledUserId: userId,
        plannedCount: 100,
        createdAt: new Date().toISOString(),
        withdrawalIds: [randomUUID()],
        evidence: [],
      }),
      'utf8',
    );
    await writeFile(
      failurePath,
      JSON.stringify({
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
    await writePhase10ChainHistoryEvidence(chainPath, {
      hotWalletAddress: '0:hot',
      jettonMaster: '0:master',
      observationWindow: {
        start: new Date(Date.now() - 1000).toISOString(),
        end: new Date().toISOString(),
      },
      providerIdentity: {
        primaryKind: 'toncenter',
        primaryEndpointFingerprint: 'https://primary.example:443',
        secondaryKind: 'tonapi',
        secondaryEndpointFingerprint: 'https://secondary.example:443',
        independenceProven: true,
      },
      enumeratedOutgoingTransfers: [],
      expectedCampaignPayoutIdentities: [],
    });
    const result = await evaluatePhase10AcceptanceFromEvidence({
      db: pool,
      campaignEvidencePath: campaignPath,
      failureInjectionEvidencePath: failurePath,
      readinessEvidencePath: evidencePath,
      chainHistoryEvidencePath: chainPath,
    });
    expect(result.reasons.every((r) => !r.includes('liveAuthorizationWindow'))).toBe(true);
    expect(result.reasons.every((r) => !r.includes('signer must be explicitly probed'))).toBe(true);
    expect(result.mayMarkPhase10Closed).toBe(false);
  }, 120_000);

  it('campaign real init: missing gates refuse; explicit gates initialize; finalize not falsely COMPLETED', async () => {
    const userId = await createTestUser(pool, '9903');
    const dir = await mkdtemp(join(tmpdir(), 'phase10-camp-'));
    const missingPath = join(dir, 'missing.json');
    const refused = await initializeCampaign({
      campaignDirOrManifestPath: missingPath,
      controlledUserId: userId,
      plannedPayoutCount: 100,
      mode: 'real',
    });
    expect(refused.accepted).toBe(false);
    expect(refused.refusalReason).toMatch(/gate/i);

    const okPath = join(dir, 'ok.json');
    const gates = {
      ownerApprovedRealTestnet: true,
      realChainEnabledExplicit: true,
      fakeChainDisabledExplicit: true,
      controlledUserAllowlisted: true,
      fundingComplete: true,
      pauseAcknowledged: true,
    };
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
    };
    const ok = await initializeCampaign({
      campaignDirOrManifestPath: okPath,
      controlledUserId: userId,
      plannedPayoutCount: 100,
      mode: 'real',
      gates,
      realExecutionGates,
      confirmationPhrase: PHASE10_REAL_CAMPAIGN_CONFIRMATION_PHRASE,
    });
    expect(ok.accepted).toBe(true);
    expect(ok.manifest).not.toBeNull();
    expect(ok.createsWithdrawals).toBe(false);
    expect(ok.unlocksSigner).toBe(false);

    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const wd = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    await attachWithdrawal(okPath, wd);
    const final = await generateFinalCampaignEvidence(okPath, pool);
    expect(final.status).not.toBe('COMPLETED');
    const resumed = await resumeCampaign(okPath);
    expect(resumed.withdrawalIds).toEqual([wd]);
  }, 120_000);

  it('chain-history: no artifact / boolean / malformed / unexpected refuse; zero-unexpected continues', async () => {
    const userId = await createTestUser(pool, '9904');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const wd = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    const dir = await mkdtemp(join(tmpdir(), 'phase10-hist-'));
    const campaignPath = join(dir, 'campaign.json');
    const failurePath = join(dir, 'failures.json');
    const readinessPath = join(dir, 'readiness.json');
    const campaignId = randomUUID();
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
        withdrawalIds: [wd],
        evidence: [{ campaignId, withdrawalId: wd, ordinal: 1 }],
      }),
      'utf8',
    );
    await writeFile(
      failurePath,
      JSON.stringify({
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

    const noArtifact = await evaluatePhase10AcceptanceFromEvidence({
      db: pool,
      campaignEvidencePath: campaignPath,
      failureInjectionEvidencePath: failurePath,
      readinessEvidencePath: readinessPath,
    });
    expect(noArtifact.verdict).toBe('REFUSED_MISSING_LIVE_EVIDENCE');
    expect(noArtifact.reasons.some((r) => r.includes('chain-history'))).toBe(true);

    const boolPath = join(dir, 'bool.json');
    await writeFile(
      boolPath,
      JSON.stringify({ unexpectedOutgoingHistoryProven: true, provenByOperator: true }),
      'utf8',
    );
    const boolOnly = await evaluatePhase10AcceptanceFromEvidence({
      db: pool,
      campaignEvidencePath: campaignPath,
      failureInjectionEvidencePath: failurePath,
      readinessEvidencePath: readinessPath,
      chainHistoryEvidencePath: boolPath,
    });
    expect(boolOnly.verdict).toBe('REFUSED_MISSING_LIVE_EVIDENCE');

    const malformedPath = join(dir, 'malformed.json');
    await writeFile(malformedPath, JSON.stringify({ schemaVersion: 99 }), 'utf8');
    const malformed = await evaluatePhase10AcceptanceFromEvidence({
      db: pool,
      campaignEvidencePath: campaignPath,
      failureInjectionEvidencePath: failurePath,
      readinessEvidencePath: readinessPath,
      chainHistoryEvidencePath: malformedPath,
    });
    expect(malformed.verdict).toBe('REFUSED_MISSING_LIVE_EVIDENCE');

    const unexpectedPath = join(dir, 'unexpected.json');
    await writePhase10ChainHistoryEvidence(unexpectedPath, {
      hotWalletAddress: '0:hot',
      jettonMaster: '0:master',
      observationWindow: {
        start: new Date(Date.now() - 1000).toISOString(),
        end: new Date().toISOString(),
      },
      providerIdentity: {
        primaryKind: 'toncenter',
        primaryEndpointFingerprint: 'https://primary.example:443',
        secondaryKind: 'tonapi',
        secondaryEndpointFingerprint: 'https://secondary.example:443',
        independenceProven: true,
      },
      enumeratedOutgoingTransfers: [
        {
          transferIdentity: 'unexpected-1',
          transactionHash: 'abc',
          queryId: null,
          amountAtomic: '1',
          recipient: '0:x',
          observedAt: new Date().toISOString(),
          providerKind: 'toncenter',
        },
      ],
      expectedCampaignPayoutIdentities: [],
    });
    const unexpected = await evaluatePhase10AcceptanceFromEvidence({
      db: pool,
      campaignEvidencePath: campaignPath,
      failureInjectionEvidencePath: failurePath,
      readinessEvidencePath: readinessPath,
      chainHistoryEvidencePath: unexpectedPath,
    });
    expect(unexpected.verdict).toBe('REFUSED_DUPLICATE_ECONOMIC_PAYOUT');

    const zeroPath = join(dir, 'zero.json');
    await writePhase10ChainHistoryEvidence(zeroPath, {
      hotWalletAddress: '0:hot',
      jettonMaster: '0:master',
      observationWindow: {
        start: new Date(Date.now() - 1000).toISOString(),
        end: new Date().toISOString(),
      },
      providerIdentity: {
        primaryKind: 'toncenter',
        primaryEndpointFingerprint: 'https://primary.example:443',
        secondaryKind: 'tonapi',
        secondaryEndpointFingerprint: 'https://secondary.example:443',
        independenceProven: true,
      },
      enumeratedOutgoingTransfers: [],
      expectedCampaignPayoutIdentities: [],
    });
    const zero = await evaluatePhase10AcceptanceFromEvidence({
      db: pool,
      campaignEvidencePath: campaignPath,
      failureInjectionEvidencePath: failurePath,
      readinessEvidencePath: readinessPath,
      chainHistoryEvidencePath: zeroPath,
    });
    expect(zero.reasons.every((r) => !r.includes('chain-history evidence path missing'))).toBe(
      true,
    );
    expect(zero.reasons.every((r) => !r.includes('CHAIN_HISTORY_PROOF_REQUIRED'))).toBe(true);
    expect(zero.verdict).not.toBe('PASS_EVIDENCE_PRESENT_OWNER_REVIEW_REQUIRED');

    const monitor = await buildPhase10HotWalletMonitorReport(pool, {
      networkCode: 'TON_TESTNET',
      unexpectedOutgoingHistoryProven: true,
    });
    expect(monitor.chainHistoryProof.status).toBe('PROOF_REQUIRED');
    expect(monitor.notes.some((n) => n.includes('ignored unexpectedOutgoingHistoryProven'))).toBe(
      true,
    );
  }, 120_000);
});
