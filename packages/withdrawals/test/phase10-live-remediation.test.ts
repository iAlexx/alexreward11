import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  PHASE10_CHAIN_HISTORY_PROOF_REQUIRED,
  PHASE10_PROVIDER_INDEPENDENCE_UNPROVEN,
  PHASE10_REAL_CAMPAIGN_CONFIRMATION_PHRASE,
  PHASE10_REQUIRED_REAL_FAILURE_SCENARIO_IDS,
  PRIMARY_PROVIDER_WRONG_NETWORK,
  SECONDARY_PROVIDER_WRONG_NETWORK,
  acquireHotWalletDispatchLease,
  attachWithdrawal,
  buildPhase10ChainHistoryEvidence,
  buildPhase10HotWalletMonitorReport,
  capturePhase10HistoricalBaseline,
  createWithdrawalAttempt,
  evaluateChainHistoryForAcceptance,
  evaluatePhase10AcceptanceFromEvidence,
  evaluateProviderIndependence,
  fingerprintProviderEndpoint,
  generateFinalCampaignEvidence,
  historicalBaselineInputFromArtifact,
  hotWalletDispatchOwnerIdentity,
  initializeCampaign,
  isPhase10CampaignCompletionSatisfied,
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
import { buildPhase10ProviderBackedChainHistoryEvidenceForTests } from '../src/phase10-chain-history-evidence.js';
import {
  capturePhase10HistoricalBaselineForTests,
  digestPhase10HistoricalBaseline,
  parsePhase10HistoricalBaseline,
} from '../src/phase10-historical-baseline.js';
import {
  createApprovedWithdrawal,
  createTestUser,
  bindVerifiedPrimaryWallet,
  phase7DatabaseUrl,
  resetAndMigrate,
  seedPhase7Base,
  truncateWithdrawalTables,
} from './harness.js';

const EXPECTED_FP = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const EXPECTED_WALLET = '0:hotwalletrawaddress0000000000000000000000000000000000000001';

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

  const liveEligibleInject = {
    primaryHealth: async () => ({ ok: true, networkGlobalId: -3, latencyMs: 1 }),
    secondaryHealth: async () => ({ ok: true, networkGlobalId: -3, latencyMs: 2 }),
    signerReady: async () => ({
      reachable: true,
      httpStatus: 200,
      signingReady: true,
      custodyState: 'UNLOCKED',
    }),
    signerIdentity: async () => ({
      publicKeyHex: '11'.repeat(32),
      publicKeyFingerprint: EXPECTED_FP,
      walletAddressRaw: EXPECTED_WALLET,
      signingReady: true,
      custodyState: 'UNLOCKED',
    }),
    walletSeqnoAdmission: async () => ({
      probePerformed: true,
      admitted: true,
      seqno: 0,
      accountStatus: 'uninit',
      requiresStateInit: true,
      code: null,
      message: null,
      hotWalletAddress: EXPECTED_WALLET,
      networkGlobalId: -3,
      publicKeyFingerprint: EXPECTED_FP,
      observedAt: new Date().toISOString(),
    }),
  };

  const liveProbeBase = {
    primary: { kind: 'toncenter', baseUrl: 'https://primary.example' },
    secondary: { kind: 'tonapi', baseUrl: 'https://secondary.example' },
    signerBaseUrl: 'http://127.0.0.1:3005',
    expectedPublicKeyFingerprint: EXPECTED_FP,
    expectedWalletAddressRaw: EXPECTED_WALLET,
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
      ...liveProbeBase,
      inject: {
        ...liveEligibleInject,
        primaryHealth: async () => ({ ok: false, networkGlobalId: -3, detail: 'down' }),
      },
    });
    expect(probes.overallBlocked).toBe(true);
    expect(probes.blockers.some((b) => b.includes('PRIMARY_PROVIDER'))).toBe(true);
  });

  it('secondary provider unavailable → BLOCKED', async () => {
    const probes = await runPhase10LiveExternalProbes({
      ...liveProbeBase,
      inject: {
        ...liveEligibleInject,
        secondaryHealth: async () => ({ ok: false, networkGlobalId: -3, detail: 'down' }),
      },
    });
    expect(probes.overallBlocked).toBe(true);
    expect(probes.blockers.some((b) => b.includes('SECONDARY_PROVIDER'))).toBe(true);
  });

  it('primary reports Mainnet -239 → BLOCKED', async () => {
    const probes = await runPhase10LiveExternalProbes({
      ...liveProbeBase,
      inject: {
        ...liveEligibleInject,
        primaryHealth: async () => ({ ok: true, networkGlobalId: -239 }),
      },
    });
    expect(probes.overallBlocked).toBe(true);
    expect(probes.blockers.some((b) => b.includes(PRIMARY_PROVIDER_WRONG_NETWORK))).toBe(true);
  });

  it('secondary reports Mainnet -239 → BLOCKED', async () => {
    const probes = await runPhase10LiveExternalProbes({
      ...liveProbeBase,
      inject: {
        ...liveEligibleInject,
        secondaryHealth: async () => ({ ok: true, networkGlobalId: -239 }),
      },
    });
    expect(probes.overallBlocked).toBe(true);
    expect(probes.blockers.some((b) => b.includes(SECONDARY_PROVIDER_WRONG_NETWORK))).toBe(true);
  });

  it('provider reports unsupported/unknown network → BLOCKED', async () => {
    const probes = await runPhase10LiveExternalProbes({
      ...liveProbeBase,
      inject: {
        ...liveEligibleInject,
        primaryHealth: async () => ({ ok: true, networkGlobalId: Number.NaN }),
      },
    });
    expect(probes.overallBlocked).toBe(true);
    expect(probes.blockers.some((b) => b.includes(PRIMARY_PROVIDER_WRONG_NETWORK))).toBe(true);
  });

  it('same effective provider backend → BLOCKED', async () => {
    const probes = await runPhase10LiveExternalProbes({
      primary: { kind: 'toncenter', baseUrl: 'https://same.example/v2' },
      secondary: { kind: 'tonapi', baseUrl: 'https://same.example/v3' },
      signerBaseUrl: 'http://127.0.0.1:3005',
      expectedPublicKeyFingerprint: EXPECTED_FP,
      expectedWalletAddressRaw: EXPECTED_WALLET,
      inject: liveEligibleInject,
    });
    expect(probes.providerIndependence.proven).toBe(false);
    expect(probes.overallBlocked).toBe(true);
    expect(probes.blockers.some((b) => b.includes(PHASE10_PROVIDER_INDEPENDENCE_UNPROVEN))).toBe(
      true,
    );
  });

  it('local_ephemeral / custodyState=n/a → BLOCKED', async () => {
    const probes = await runPhase10LiveExternalProbes({
      ...liveProbeBase,
      inject: {
        ...liveEligibleInject,
        signerReady: async () => ({
          reachable: true,
          httpStatus: 200,
          signingReady: true,
          custodyState: 'n/a',
        }),
        signerIdentity: async () => ({
          publicKeyHex: '11'.repeat(32),
          publicKeyFingerprint: EXPECTED_FP,
          walletAddressRaw: EXPECTED_WALLET,
          signingReady: true,
          custodyState: 'n/a',
        }),
      },
    });
    expect(probes.overallBlocked).toBe(true);
    expect(probes.blockers.some((b) => b.includes('SIGNER_CUSTODY_NOT_UNLOCKED'))).toBe(true);
  });

  it('missing expected fingerprint → BLOCKED', async () => {
    const probes = await runPhase10LiveExternalProbes({
      ...liveProbeBase,
      expectedPublicKeyFingerprint: null,
      inject: liveEligibleInject,
    });
    expect(probes.overallBlocked).toBe(true);
    expect(probes.blockers.some((b) => b.includes('SIGNER_EXPECTED_FINGERPRINT_MISSING'))).toBe(
      true,
    );
  });

  it('identity not probed → BLOCKED', async () => {
    const probes = await runPhase10LiveExternalProbes({
      ...liveProbeBase,
      inject: {
        ...liveEligibleInject,
        signerIdentity: async () => null,
      },
    });
    expect(probes.overallBlocked).toBe(true);
    expect(probes.blockers.some((b) => b.includes('SIGNER_IDENTITY_NOT_PROBED'))).toBe(true);
  });

  it('wrong fingerprint → BLOCKED', async () => {
    const probes = await runPhase10LiveExternalProbes({
      ...liveProbeBase,
      inject: {
        ...liveEligibleInject,
        signerIdentity: async () => ({
          publicKeyHex: '11'.repeat(32),
          publicKeyFingerprint: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          walletAddressRaw: EXPECTED_WALLET,
          signingReady: true,
          custodyState: 'UNLOCKED',
        }),
      },
    });
    expect(probes.overallBlocked).toBe(true);
    expect(probes.blockers.some((b) => b.includes('SIGNER_IDENTITY_MISMATCH'))).toBe(true);
  });

  it('wrong wallet address → BLOCKED', async () => {
    const probes = await runPhase10LiveExternalProbes({
      ...liveProbeBase,
      inject: {
        ...liveEligibleInject,
        signerIdentity: async () => ({
          publicKeyHex: '11'.repeat(32),
          publicKeyFingerprint: EXPECTED_FP,
          walletAddressRaw: '0:wrong',
          signingReady: true,
          custodyState: 'UNLOCKED',
        }),
      },
    });
    expect(probes.overallBlocked).toBe(true);
    expect(probes.blockers.some((b) => b.includes('SIGNER_WALLET_ADDRESS_MISMATCH'))).toBe(true);
  });

  it('exact encrypted/UNLOCKED identity match → eligible', async () => {
    const probes = await runPhase10LiveExternalProbes({
      ...liveProbeBase,
      inject: liveEligibleInject,
    });
    expect(probes.overallBlocked).toBe(false);
    expect(probes.providerIndependence.proven).toBe(true);
    expect(probes.signer.signingReady).toBe(true);
    expect(probes.signer.custodyState).toBe('UNLOCKED');
    expect(probes.signer.identityMatchesExpected).toBe(true);
    expect(probes.signer.walletAddressMatchesExpected).toBe(true);
  });

  it('generated historical isolated snapshot tolerated; mutations remain DANGER', async () => {
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

    const capturedAt = new Date().toISOString();
    const artifact = await capturePhase10HistoricalBaselineForTests(pool, capturedAt);
    expect(artifact.attempts.some((a) => a.attemptId === attemptId)).toBe(true);
    const baseline = historicalBaselineInputFromArtifact(artifact);
    const windowStart = new Date(Date.now() + 3_600_000).toISOString();
    const capturedAttemptState = baseline.attemptStates![attemptId]!;

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

    // Manually added ID not in captured artifact → DANGER.
    const foreignId = randomUUID();
    const withForeign = await runPhase10RestoreReconcileScan(pool, {
      historicalBaseline: {
        ...baseline,
        attemptIds: [...baseline.attemptIds, foreignId],
      },
      liveAuthorizationWindowStartedAt: windowStart,
    });
    expect(
      withForeign.findings.some((f) => f.attemptId === attemptId && f.severity !== 'DANGER'),
    ).toBe(true);

    // Modified captured state → DANGER.
    const modifiedState = await runPhase10RestoreReconcileScan(pool, {
      historicalBaseline: {
        ...baseline,
        attemptStates: {
          [attemptId]: { ...capturedAttemptState, broadcastResultState: 'BROADCASTED' },
        },
      },
      liveAuthorizationWindowStartedAt: windowStart,
    });
    expect(
      modifiedState.findings.some((f) => f.attemptId === attemptId && f.severity === 'DANGER'),
    ).toBe(true);

    // Pending outbox → DANGER.
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

    // Post-capture attempt → DANGER (not in artifact).
    const withoutBaseline = await runPhase10RestoreReconcileScan(pool, {
      liveAuthorizationWindowStartedAt: windowStart,
    });
    expect(
      withoutBaseline.findings.some((f) => f.attemptId === attemptId && f.severity === 'DANGER'),
    ).toBe(true);
  }, 120_000);

  it('canonical live preflight evidence required; hand-authored flags refuse', async () => {
    const userId = await createTestUser(pool, '9902');
    const probes = await runPhase10LiveExternalProbes({
      ...liveProbeBase,
      inject: liveEligibleInject,
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
    const dir = await mkdtemp(join(tmpdir(), 'phase10-evidence-'));
    const evidencePath = join(dir, 'live-preflight.json');
    const artifact = await writePhase10LivePreflightEvidence(evidencePath, {
      preflight: {
        ...preflight,
        verdict: 'READY_FOR_CONTROLLED_LIVE_TESTNET',
        blockers: [],
        restore: { ...preflight.restore, dangerousCount: 0 },
      },
      readinessConfig,
      externalProbes: probes,
      liveAuthorizationWindow: true,
    });
    // Integration must use writer output without replacing verdict/blockers/signer fields.
    expect(artifact.schemaVersion).toBe(2);
    expect(artifact.externalProbes?.signer.custodyState).toBe('UNLOCKED');
    const parsed = parseLiveReadinessEvidence(artifact);
    // DB readiness may still leave blockers; if writer verdict is BLOCKED, parser must refuse.
    if (artifact.verdict === 'READY_FOR_CONTROLLED_LIVE_TESTNET') {
      expect(parsed.errors).toEqual([]);
      expect(parsed.parsed?.verdict).toBe('READY_FOR_CONTROLLED_LIVE_TESTNET');
    }

    const handAuthored = parseLiveReadinessEvidence({
      liveAuthorizationWindow: true,
      verdict: 'READY_FOR_CONTROLLED_LIVE_TESTNET',
      signerProbed: true,
      signerUnlocked: true,
    });
    expect(handAuthored.parsed).toBeNull();
    expect(
      handAuthored.errors.some((e) => e.includes('hand-authored') || e.includes('schemaVersion')),
    ).toBe(true);

    const schemaV1WithoutAdmission = parseLiveReadinessEvidence({
      schemaVersion: 1,
      liveAuthorizationWindow: true,
      verdict: 'READY_FOR_CONTROLLED_LIVE_TESTNET',
      realChainEnabled: true,
      fakeChainEnabled: false,
      networkCode: 'TON_TESTNET',
      assetSymbol: 'USDT',
      controlledUserId: 'user',
      recordedAt: new Date().toISOString(),
      preflightBlockers: [],
      restoreScanSummary: { dangerousCount: 0, warnCount: 0, scannedAt: new Date().toISOString() },
      providers: {
        primary: {
          kind: 'toncenter',
          endpointFingerprint: 'https://a.example:443',
          healthy: true,
          observedNetworkGlobalId: -3,
        },
        secondary: {
          kind: 'tonapi',
          endpointFingerprint: 'https://b.example:443',
          healthy: true,
          observedNetworkGlobalId: -3,
        },
        independenceProven: true,
      },
      externalProbes: {
        schemaVersion: 1,
        signer: {
          probePerformed: true,
          identityProbed: true,
          custodyState: 'UNLOCKED',
          signingReady: true,
          identityMatchesExpected: true,
          walletAddressMatchesExpected: true,
        },
      },
    });
    expect(schemaV1WithoutAdmission.parsed).toBeNull();
    expect(
      schemaV1WithoutAdmission.errors.some(
        (e) => e.includes('schemaVersion') || e.includes('walletSeqnoAdmission'),
      ),
    ).toBe(true);

    // Schema-v2 without verified walletSeqnoAdmission must also refuse (no hand-authored bypass).
    const schemaV2WithoutAdmission = parseLiveReadinessEvidence({
      schemaVersion: 2,
      liveAuthorizationWindow: true,
      verdict: 'READY_FOR_CONTROLLED_LIVE_TESTNET',
      realChainEnabled: true,
      fakeChainEnabled: false,
      networkCode: 'TON_TESTNET',
      assetSymbol: 'USDT',
      controlledUserId: 'user',
      recordedAt: new Date().toISOString(),
      preflightBlockers: [],
      restoreScanSummary: { dangerousCount: 0, warnCount: 0, scannedAt: new Date().toISOString() },
      providers: {
        primary: {
          kind: 'toncenter',
          endpointFingerprint: 'https://a.example:443',
          healthy: true,
          observedNetworkGlobalId: -3,
        },
        secondary: {
          kind: 'tonapi',
          endpointFingerprint: 'https://b.example:443',
          healthy: true,
          observedNetworkGlobalId: -3,
        },
        independenceProven: true,
      },
      externalProbes: {
        schemaVersion: 2,
        signer: {
          probePerformed: true,
          identityProbed: true,
          custodyState: 'UNLOCKED',
          signingReady: true,
          identityMatchesExpected: true,
          walletAddressMatchesExpected: true,
        },
      },
    });
    expect(schemaV2WithoutAdmission.parsed).toBeNull();
    expect(schemaV2WithoutAdmission.errors.some((e) => e.includes('walletSeqnoAdmission'))).toBe(
      true,
    );

    const campaignPath = join(dir, 'campaign.json');
    const failurePath = join(dir, 'failures.json');
    const chainPath = join(dir, 'chain.json');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const wd = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    const binding = await pool.query<{
      address: string;
      payout_jetton_wallet_address: string | null;
      contract_identity: string | null;
    }>(
      `SELECT hw.address, hw.payout_jetton_wallet_address, a.contract_identity
       FROM hot_wallets hw
       JOIN assets a ON a.id = $2::uuid
       WHERE hw.id = $1::uuid`,
      [hotWalletId, assetId],
    );
    const campaignCreatedAt = new Date(Date.now() - 60_000).toISOString();
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
        createdAt: campaignCreatedAt,
        withdrawalIds: [wd],
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
      hotWalletAddress: binding.rows[0]!.address,
      hotWalletJettonWallet: binding.rows[0]!.payout_jetton_wallet_address,
      jettonMaster: binding.rows[0]!.contract_identity ?? '0:master',
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
    expect(result.reasons.some((r) => r.includes(PHASE10_CHAIN_HISTORY_PROOF_REQUIRED))).toBe(true);
    expect(result.mayMarkPhase10Closed).toBe(false);
    expect(result.verdict).not.toBe('PASS_EVIDENCE_PRESENT_OWNER_REVIEW_REQUIRED');
  }, 120_000);

  it('campaign Owner checkpoint: AWAITING_OWNER_APPROVAL never COMPLETED', async () => {
    const userId = await createTestUser(pool, '9903');
    const dir = await mkdtemp(join(tmpdir(), 'phase10-camp-'));
    const gates = {
      ownerApprovedRealTestnet: true,
      realChainEnabledExplicit: true,
      fakeChainDisabledExplicit: true,
      controlledUserAllowlisted: true,
      fundingComplete: true,
      pauseAcknowledged: true,
    };
    // Incomplete realExecutionGates → AWAITING_OWNER_APPROVAL
    const awaitingPath = join(dir, 'awaiting.json');
    const awaiting = await initializeCampaign({
      campaignDirOrManifestPath: awaitingPath,
      controlledUserId: userId,
      plannedPayoutCount: 100,
      mode: 'real',
      gates,
      realExecutionGates: {
        campaignIdProvided: true,
        maxCountProvided: true,
        controlledUserProvided: true,
        networkIsTonTestnet: true,
        realChainEnabledTrue: true,
        fakeChainEnabledFalse: true,
        readinessPass: false,
        signerUnlockedExternally: false,
        confirmationPhraseMatches: false,
      },
      confirmationPhrase: 'WRONG',
    });
    expect(awaiting.manifest?.status).toBe('AWAITING_OWNER_APPROVAL');
    expect(awaiting.manifest?.realModeCheckpoint).toBe('OWNER_APPROVAL_REQUIRED');

    const fakeEvidence = Array.from({ length: 100 }, (_, i) => {
      const withdrawalId = randomUUID();
      return {
        campaignId: awaiting.manifest!.campaignId,
        withdrawalId,
        ordinal: i + 1,
        confirmed: true as const,
        finalState: 'CONFIRMED',
        invariantResult: 'PASS',
      };
    });
    const fakeManifest = {
      ...awaiting.manifest!,
      withdrawalIds: fakeEvidence.map((e) => e.withdrawalId),
      evidence: fakeEvidence,
    } as unknown as Parameters<typeof isPhase10CampaignCompletionSatisfied>[0];
    expect(isPhase10CampaignCompletionSatisfied(fakeManifest)).toBe(false);

    const final = await generateFinalCampaignEvidence(awaitingPath, pool);
    expect(final.status).toBe('AWAITING_OWNER_APPROVAL');
    expect(final.status).not.toBe('COMPLETED');
  }, 120_000);

  it('campaign real init: missing gates refuse; explicit gates initialize; finalize not falsely COMPLETED', async () => {
    const userId = await createTestUser(pool, '9905');
    const dir = await mkdtemp(join(tmpdir(), 'phase10-camp-ok-'));
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

  it('chain-history: caller [] / hand-built ZERO_UNEXPECTED / wrong bindings refuse', async () => {
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

    const callerEmpty = buildPhase10ChainHistoryEvidence({
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
    expect(callerEmpty.reconciliationResult).toBe(PHASE10_CHAIN_HISTORY_PROOF_REQUIRED);
    const emptyEval = evaluateChainHistoryForAcceptance(callerEmpty);
    expect(emptyEval.ok).toBe(false);
    expect(emptyEval.reasons.some((r) => r.includes(PHASE10_CHAIN_HISTORY_PROOF_REQUIRED))).toBe(
      true,
    );

    const handBuilt = {
      ...callerEmpty,
      reconciliationResult: 'ZERO_UNEXPECTED',
      enumerationAuthority: 'CALLER_SUPPLIED_UNTRUSTED',
    };
    expect(evaluateChainHistoryForAcceptance(handBuilt).ok).toBe(false);

    const providerBacked = buildPhase10ProviderBackedChainHistoryEvidenceForTests({
      hotWalletAddress: '0:hot',
      hotWalletJettonWallet: '0:jetton',
      jettonMaster: '0:master',
      networkGlobalId: -3,
      observationWindow: {
        start: new Date(Date.now() - 120_000).toISOString(),
        end: new Date().toISOString(),
      },
      providerIdentity: {
        primaryKind: 'toncenter',
        primaryEndpointFingerprint: 'https://primary.example:443',
        secondaryKind: 'tonapi',
        secondaryEndpointFingerprint: 'https://secondary.example:443',
        independenceProven: true,
      },
      providerEnumeratedOutgoingTransfers: [],
      expectedCampaignPayoutIdentities: [],
    });
    expect(providerBacked.reconciliationResult).toBe('ZERO_UNEXPECTED');
    // Collector unavailable → claimed PROVIDER_BACKED never acceptance-ok.
    const providerEval = evaluateChainHistoryForAcceptance(providerBacked);
    expect(providerEval.ok).toBe(false);
    expect(providerEval.reasons.some((r) => r.includes(PHASE10_CHAIN_HISTORY_PROOF_REQUIRED))).toBe(
      true,
    );

    const wrongHot = evaluateChainHistoryForAcceptance(providerBacked, {
      hotWalletAddress: '0:wrong',
      jettonMaster: '0:master',
    });
    expect(wrongHot.ok).toBe(false);
    expect(wrongHot.reasons.some((r) => r.includes('hotWalletAddress'))).toBe(true);

    const wrongMaster = evaluateChainHistoryForAcceptance(providerBacked, {
      hotWalletAddress: '0:hot',
      jettonMaster: '0:wrong',
    });
    expect(wrongMaster.ok).toBe(false);
    expect(wrongMaster.reasons.some((r) => r.includes('jettonMaster'))).toBe(true);

    const wrongNetwork = evaluateChainHistoryForAcceptance(
      { ...providerBacked, networkGlobalId: -239 },
      { hotWalletAddress: '0:hot', jettonMaster: '0:master', networkGlobalId: -3 },
    );
    expect(wrongNetwork.ok).toBe(false);
    expect(wrongNetwork.reasons.some((r) => r.includes('networkGlobalId'))).toBe(true);

    const incompleteWindow = evaluateChainHistoryForAcceptance(providerBacked, {
      hotWalletAddress: '0:hot',
      jettonMaster: '0:master',
      campaignWindowStart: new Date(Date.now() - 3600_000).toISOString(),
    });
    expect(incompleteWindow.ok).toBe(false);
    expect(incompleteWindow.reasons.some((r) => r.includes('observationWindow'))).toBe(true);

    const badDigest = evaluateChainHistoryForAcceptance(
      { ...providerBacked, evidenceDigest: 'deadbeef' },
      { hotWalletAddress: '0:hot', jettonMaster: '0:master' },
    );
    expect(badDigest.ok).toBe(false);
    expect(badDigest.reasons.some((r) => r.includes('evidenceDigest'))).toBe(true);

    const wrongFp = evaluateChainHistoryForAcceptance(providerBacked, {
      hotWalletAddress: '0:hot',
      jettonMaster: '0:master',
      primaryEndpointFingerprint: 'https://other.example:443',
    });
    expect(wrongFp.ok).toBe(false);
    expect(wrongFp.reasons.some((r) => r.includes('fingerprint'))).toBe(true);

    const unexpected = buildPhase10ProviderBackedChainHistoryEvidenceForTests({
      hotWalletAddress: '0:hot',
      jettonMaster: '0:master',
      networkGlobalId: -3,
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
      providerEnumeratedOutgoingTransfers: [
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
    expect(unexpected.reconciliationResult).toBe('UNEXPECTED_OUTGOING');
    expect(evaluateChainHistoryForAcceptance(unexpected).ok).toBe(false);

    const zeroPath = join(dir, 'zero.json');
    await writeFile(zeroPath, JSON.stringify(callerEmpty), 'utf8');
    const zero = await evaluatePhase10AcceptanceFromEvidence({
      db: pool,
      campaignEvidencePath: campaignPath,
      failureInjectionEvidencePath: failurePath,
      readinessEvidencePath: readinessPath,
      chainHistoryEvidencePath: zeroPath,
    });
    expect(zero.reasons.some((r) => r.includes(PHASE10_CHAIN_HISTORY_PROOF_REQUIRED))).toBe(true);
    expect(zero.verdict).not.toBe('PASS_EVIDENCE_PRESENT_OWNER_REVIEW_REQUIRED');

    const monitor = await buildPhase10HotWalletMonitorReport(pool, {
      networkCode: 'TON_TESTNET',
      unexpectedOutgoingHistoryProven: true,
    });
    expect(monitor.chainHistoryProof.status).toBe('PROOF_REQUIRED');
  }, 120_000);

  async function createAmbiguousSubmittedAttempt(telegramUserId: string): Promise<{
    readonly userId: string;
    readonly withdrawalId: string;
    readonly attemptId: string;
  }> {
    const userId = await createTestUser(pool, telegramUserId);
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
      `UPDATE outbox_events SET status = 'DISPATCHED', dispatched_at = now()
       WHERE aggregate_id = $1::uuid AND status = 'PENDING'`,
      [withdrawalId],
    );
    let attemptId = '';
    await withWithdrawalTransaction(pool, async (client) => {
      const owner = hotWalletDispatchOwnerIdentity(withdrawalId);
      const lease = await acquireHotWalletDispatchLease(client, hotWalletId, owner);
      expect(lease.status).toBe('ACQUIRED');
      if (lease.status !== 'ACQUIRED') return;
      const attempt = await createWithdrawalAttempt(client, {
        withdrawalId,
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
    return { userId, withdrawalId, attemptId };
  }

  async function loadAuthoritativeHotWalletBinding(): Promise<{
    readonly hotWalletAddress: string;
    readonly hotWalletJettonWallet: string;
    readonly jettonMaster: string;
  }> {
    const hot = await pool.query<{
      address: string;
      payout_jetton_wallet_address: string | null;
    }>(`SELECT address, payout_jetton_wallet_address FROM hot_wallets WHERE id = $1::uuid`, [
      hotWalletId,
    ]);
    const asset = await pool.query<{ contract_identity: string | null }>(
      `SELECT contract_identity FROM assets WHERE id = $1::uuid`,
      [assetId],
    );
    const hotWalletAddress = hot.rows[0]!.address;
    const hotWalletJettonWallet = hot.rows[0]!.payout_jetton_wallet_address;
    const jettonMaster = asset.rows[0]!.contract_identity;
    expect(hotWalletJettonWallet).toBeTruthy();
    expect(jettonMaster).toBeTruthy();
    return {
      hotWalletAddress,
      hotWalletJettonWallet: hotWalletJettonWallet!,
      jettonMaster: jettonMaster!,
    };
  }

  async function writeCanonicalAcceptanceScaffold(input: {
    readonly dir: string;
    readonly userId: string;
    readonly withdrawalId: string;
    readonly campaignCreatedAt?: string;
  }): Promise<{
    readonly campaignPath: string;
    readonly failurePath: string;
    readonly readinessPath: string;
  }> {
    const campaignPath = join(input.dir, 'campaign.json');
    const failurePath = join(input.dir, 'failures.json');
    const readinessPath = join(input.dir, 'readiness.json');
    const campaignId = randomUUID();
    const createdAt = input.campaignCreatedAt ?? new Date(Date.now() - 60_000).toISOString();
    const recordedAt = new Date().toISOString();
    await writeFile(
      campaignPath,
      JSON.stringify({
        campaignId,
        networkCode: 'TON_TESTNET',
        assetSymbol: 'USDT',
        acceptanceCampaign: true,
        mode: 'real',
        controlledUserId: input.userId,
        plannedCount: 100,
        createdAt,
        withdrawalIds: [input.withdrawalId],
        evidence: [{ campaignId, withdrawalId: input.withdrawalId, ordinal: 1 }],
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
        schemaVersion: 2,
        liveAuthorizationWindow: true,
        verdict: 'READY_FOR_CONTROLLED_LIVE_TESTNET',
        realChainEnabled: true,
        fakeChainEnabled: false,
        networkCode: 'TON_TESTNET',
        assetSymbol: 'USDT',
        controlledUserId: input.userId,
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
            endpointFingerprint: 'https://primary.example:443',
            healthy: true,
            observedNetworkGlobalId: -3,
          },
          secondary: {
            kind: 'tonapi',
            endpointFingerprint: 'https://secondary.example:443',
            healthy: true,
            observedNetworkGlobalId: -3,
          },
          independenceProven: true,
          independenceCode: null,
        },
        externalProbes: {
          schemaVersion: 2,
          observedAt: recordedAt,
          primary: {
            kind: 'toncenter',
            endpointFingerprint: 'https://primary.example:443',
            reachable: true,
            healthy: true,
            observedNetworkGlobalId: -3,
            latencyMs: 1,
            detail: null,
            observedAt: recordedAt,
          },
          secondary: {
            kind: 'tonapi',
            endpointFingerprint: 'https://secondary.example:443',
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
            primaryFingerprint: 'https://primary.example:443',
            secondaryFingerprint: 'https://secondary.example:443',
          },
          signer: {
            probePerformed: true,
            healthReachable: true,
            custodyState: 'UNLOCKED',
            signingReady: true,
            expectedCustodyMode: 'self_hosted_encrypted',
            identityProbed: true,
            publicKeyFingerprint: 'aa'.repeat(32),
            walletAddressRaw: EXPECTED_WALLET,
            identityMatchesExpected: true,
            walletAddressMatchesExpected: true,
            expectedPublicKeyFingerprintPresent: true,
            expectedWalletAddressPresent: true,
            httpStatus: 200,
            detail: null,
            observedAt: recordedAt,
          },
          walletSeqnoAdmission: {
            probePerformed: true,
            admitted: true,
            seqno: 0,
            accountStatus: 'uninit',
            requiresStateInit: true,
            code: null,
            message: null,
            hotWalletAddress: '0:test',
            networkGlobalId: -3,
            publicKeyFingerprint: 'fp',
            observedAt: recordedAt,
          },

          overallBlocked: false,
          blockers: [],
        },
      }),
      'utf8',
    );
    return { campaignPath, failurePath, readinessPath };
  }

  it('acceptance entrypoint: forged PROVIDER_BACKED JSON is REFUSED with PROOF_REQUIRED', async () => {
    const userId = await createTestUser(pool, '9910');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const wd = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    const binding = await loadAuthoritativeHotWalletBinding();
    const dir = await mkdtemp(join(tmpdir(), 'phase10-forge-prov-'));
    const scaffold = await writeCanonicalAcceptanceScaffold({
      dir,
      userId,
      withdrawalId: wd,
    });
    const chainPath = join(dir, 'chain.json');
    const forged = buildPhase10ProviderBackedChainHistoryEvidenceForTests({
      hotWalletAddress: binding.hotWalletAddress,
      hotWalletJettonWallet: binding.hotWalletJettonWallet,
      jettonMaster: binding.jettonMaster,
      networkGlobalId: -3,
      observationWindow: {
        start: new Date(Date.now() - 3600_000).toISOString(),
        end: new Date().toISOString(),
      },
      providerIdentity: {
        primaryKind: 'toncenter',
        primaryEndpointFingerprint: 'https://primary.example:443',
        secondaryKind: 'tonapi',
        secondaryEndpointFingerprint: 'https://secondary.example:443',
        independenceProven: true,
      },
      providerEnumeratedOutgoingTransfers: [],
      expectedCampaignPayoutIdentities: [],
    });
    expect(forged.enumerationAuthority).toBe('PROVIDER_BACKED');
    await writeFile(chainPath, JSON.stringify(forged), 'utf8');
    const result = await evaluatePhase10AcceptanceFromEvidence({
      db: pool,
      campaignEvidencePath: scaffold.campaignPath,
      failureInjectionEvidencePath: scaffold.failurePath,
      readinessEvidencePath: scaffold.readinessPath,
      chainHistoryEvidencePath: chainPath,
    });
    expect(result.verdict).not.toBe('PASS_EVIDENCE_PRESENT_OWNER_REVIEW_REQUIRED');
    expect(result.reasons.some((r) => r.includes(PHASE10_CHAIN_HISTORY_PROOF_REQUIRED))).toBe(true);
  }, 120_000);

  it('acceptance entrypoint: provider-backed-looking artifact with wrong Hot Wallet is REFUSED', async () => {
    const userId = await createTestUser(pool, '9911');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const wd = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    const binding = await loadAuthoritativeHotWalletBinding();
    const dir = await mkdtemp(join(tmpdir(), 'phase10-forge-hot-'));
    const scaffold = await writeCanonicalAcceptanceScaffold({
      dir,
      userId,
      withdrawalId: wd,
    });
    const chainPath = join(dir, 'chain.json');
    const forged = {
      ...buildPhase10ProviderBackedChainHistoryEvidenceForTests({
        hotWalletAddress: binding.hotWalletAddress,
        hotWalletJettonWallet: binding.hotWalletJettonWallet,
        jettonMaster: binding.jettonMaster,
        networkGlobalId: -3,
        observationWindow: {
          start: new Date(Date.now() - 3600_000).toISOString(),
          end: new Date().toISOString(),
        },
        providerIdentity: {
          primaryKind: 'toncenter',
          primaryEndpointFingerprint: 'https://primary.example:443',
          secondaryKind: 'tonapi',
          secondaryEndpointFingerprint: 'https://secondary.example:443',
          independenceProven: true,
        },
        providerEnumeratedOutgoingTransfers: [],
        expectedCampaignPayoutIdentities: [],
      }),
      hotWalletAddress: '0:wrong-hot-wallet-address',
    };
    await writeFile(chainPath, JSON.stringify(forged), 'utf8');
    const result = await evaluatePhase10AcceptanceFromEvidence({
      db: pool,
      campaignEvidencePath: scaffold.campaignPath,
      failureInjectionEvidencePath: scaffold.failurePath,
      readinessEvidencePath: scaffold.readinessPath,
      chainHistoryEvidencePath: chainPath,
    });
    expect(result.verdict).not.toBe('PASS_EVIDENCE_PRESENT_OWNER_REVIEW_REQUIRED');
    expect(result.reasons.some((r) => r.includes('hotWalletAddress'))).toBe(true);
  }, 120_000);

  it('acceptance entrypoint: wrong jetton wallet / master / fingerprints / network / window refuse', async () => {
    const userId = await createTestUser(pool, '9912');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const wd = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    const binding = await loadAuthoritativeHotWalletBinding();
    const dir = await mkdtemp(join(tmpdir(), 'phase10-forge-bind-'));
    const scaffold = await writeCanonicalAcceptanceScaffold({
      dir,
      userId,
      withdrawalId: wd,
    });

    const base = buildPhase10ProviderBackedChainHistoryEvidenceForTests({
      hotWalletAddress: binding.hotWalletAddress,
      hotWalletJettonWallet: binding.hotWalletJettonWallet,
      jettonMaster: binding.jettonMaster,
      networkGlobalId: -3,
      observationWindow: {
        start: new Date(Date.now() - 3600_000).toISOString(),
        end: new Date().toISOString(),
      },
      providerIdentity: {
        primaryKind: 'toncenter',
        primaryEndpointFingerprint: 'https://primary.example:443',
        secondaryKind: 'tonapi',
        secondaryEndpointFingerprint: 'https://secondary.example:443',
        independenceProven: true,
      },
      providerEnumeratedOutgoingTransfers: [],
      expectedCampaignPayoutIdentities: [],
    });

    const cases: Array<{ label: string; artifact: unknown; reasonNeedle: string }> = [
      {
        label: 'wrong-jetton-wallet',
        artifact: { ...base, hotWalletJettonWallet: '0:wrong-jetton-wallet' },
        reasonNeedle: 'hotWalletJettonWallet',
      },
      {
        label: 'wrong-master',
        artifact: { ...base, jettonMaster: '0:wrong-jetton-master' },
        reasonNeedle: 'jettonMaster',
      },
      {
        label: 'wrong-primary-fp',
        artifact: {
          ...base,
          providerIdentity: {
            ...base.providerIdentity,
            primaryEndpointFingerprint: 'https://other-primary.example:443',
          },
        },
        reasonNeedle: 'fingerprint',
      },
      {
        label: 'wrong-network',
        artifact: { ...base, networkGlobalId: -239 },
        reasonNeedle: 'networkGlobalId',
      },
      {
        label: 'incomplete-window',
        artifact: {
          ...base,
          observationWindow: {
            start: new Date().toISOString(),
            end: new Date(Date.now() + 1000).toISOString(),
          },
        },
        reasonNeedle: 'observationWindow',
      },
    ];

    for (const c of cases) {
      const chainPath = join(dir, `${c.label}.json`);
      await writeFile(chainPath, JSON.stringify(c.artifact), 'utf8');
      const result = await evaluatePhase10AcceptanceFromEvidence({
        db: pool,
        campaignEvidencePath: scaffold.campaignPath,
        failureInjectionEvidencePath: scaffold.failurePath,
        readinessEvidencePath: scaffold.readinessPath,
        chainHistoryEvidencePath: chainPath,
      });
      expect(result.verdict).not.toBe('PASS_EVIDENCE_PRESENT_OWNER_REVIEW_REQUIRED');
      expect(result.reasons.some((r) => r.includes(c.reasonNeedle))).toBe(true);
    }
  }, 120_000);

  it('historical baseline: edit capturedAt without digest update is REFUSED by parse', async () => {
    const { attemptId } = await createAmbiguousSubmittedAttempt('9920');
    const capturedAt = new Date(Date.now() - 60_000).toISOString();
    const artifact = await capturePhase10HistoricalBaselineForTests(pool, capturedAt);
    expect(artifact.attempts.some((a) => a.attemptId === attemptId)).toBe(true);
    const tampered = {
      ...artifact,
      capturedAt: new Date().toISOString(),
    };
    const parsed = parsePhase10HistoricalBaseline(tampered);
    expect(parsed.parsed).toBeNull();
    expect(parsed.errors.some((e) => e.includes('evidenceDigest'))).toBe(true);
    // Digest helper must cover capturedAt.
    expect(digestPhase10HistoricalBaseline(tampered.capturedAt, artifact.attempts)).not.toBe(
      artifact.evidenceDigest,
    );
  }, 120_000);

  it('historical baseline: production capture accepts only db (no capturedAt option)', async () => {
    await createAmbiguousSubmittedAttempt('9921');
    const artifact = await capturePhase10HistoricalBaseline(pool);
    expect(typeof artifact.capturedAt).toBe('string');
    expect(artifact.evidenceDigest).toBe(
      digestPhase10HistoricalBaseline(artifact.capturedAt, artifact.attempts),
    );
    expect(artifact.attempts.length).toBeGreaterThan(0);
  }, 120_000);

  it('historical baseline: changed withdrawal state after capture → DANGER', async () => {
    const { withdrawalId, attemptId } = await createAmbiguousSubmittedAttempt('9922');
    const artifact = await capturePhase10HistoricalBaselineForTests(
      pool,
      new Date(Date.now() - 60_000).toISOString(),
    );
    const baseline = historicalBaselineInputFromArtifact(artifact);
    await pool.query(`UPDATE withdrawals SET state = 'BROADCASTING' WHERE id = $1::uuid`, [
      withdrawalId,
    ]);
    const scan = await runPhase10RestoreReconcileScan(pool, {
      historicalBaseline: baseline,
      liveAuthorizationWindowStartedAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(scan.findings.some((f) => f.attemptId === attemptId && f.severity === 'DANGER')).toBe(
      true,
    );
  }, 120_000);

  it('historical baseline: changed workflowId after capture → DANGER', async () => {
    const { withdrawalId, attemptId } = await createAmbiguousSubmittedAttempt('9923');
    const artifact = await capturePhase10HistoricalBaselineForTests(
      pool,
      new Date(Date.now() - 60_000).toISOString(),
    );
    const baseline = historicalBaselineInputFromArtifact(artifact);
    await pool.query(`UPDATE withdrawals SET workflow_id = $2 WHERE id = $1::uuid`, [
      withdrawalId,
      `mutated-workflow-${randomUUID()}`,
    ]);
    const scan = await runPhase10RestoreReconcileScan(pool, {
      historicalBaseline: baseline,
      liveAuthorizationWindowStartedAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(scan.findings.some((f) => f.attemptId === attemptId && f.severity === 'DANGER')).toBe(
      true,
    );
  }, 120_000);

  it('historical baseline: changed broadcast state after capture → DANGER', async () => {
    const { attemptId } = await createAmbiguousSubmittedAttempt('9924');
    const artifact = await capturePhase10HistoricalBaselineForTests(
      pool,
      new Date(Date.now() - 60_000).toISOString(),
    );
    const baseline = historicalBaselineInputFromArtifact(artifact);
    await pool.query(
      `UPDATE withdrawal_attempts SET broadcast_result_state = 'BROADCASTED' WHERE id = $1::uuid`,
      [attemptId],
    );
    const scan = await runPhase10RestoreReconcileScan(pool, {
      historicalBaseline: baseline,
      liveAuthorizationWindowStartedAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(scan.findings.some((f) => f.attemptId === attemptId && f.severity === 'DANGER')).toBe(
      true,
    );
  }, 120_000);

  it('historical baseline: pending approved outbox after capture → DANGER', async () => {
    const { withdrawalId, attemptId } = await createAmbiguousSubmittedAttempt('9925');
    const artifact = await capturePhase10HistoricalBaselineForTests(
      pool,
      new Date(Date.now() - 60_000).toISOString(),
    );
    const baseline = historicalBaselineInputFromArtifact(artifact);
    await pool.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, status)
       VALUES ('withdrawal', $1::uuid, $2, $3::jsonb, 'PENDING')`,
      [withdrawalId, 'withdrawal.approved', JSON.stringify({ withdrawalId })],
    );
    const scan = await runPhase10RestoreReconcileScan(pool, {
      historicalBaseline: baseline,
      liveAuthorizationWindowStartedAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(scan.findings.some((f) => f.attemptId === attemptId && f.severity === 'DANGER')).toBe(
      true,
    );
  }, 120_000);

  it('historical baseline: newer attempt after capture → DANGER', async () => {
    const { withdrawalId, attemptId } = await createAmbiguousSubmittedAttempt('9926');
    const artifact = await capturePhase10HistoricalBaselineForTests(
      pool,
      new Date(Date.now() - 60_000).toISOString(),
    );
    const baseline = historicalBaselineInputFromArtifact(artifact);
    // Domain createWithdrawalAttempt forbids a second live UNKNOWN attempt; insert a
    // non-active newer lineage row (FAILED_PRE_BROADCAST) so the one-active index allows it.
    await pool.query(
      `INSERT INTO withdrawal_attempts (
         withdrawal_id, attempt_number, hot_wallet_id, expected_seqno, query_id,
         valid_until, canonical_message_hash, signer_key_reference,
         dispatch_fencing_token, broadcast_result_state, created_at
       ) VALUES (
         $1::uuid, 2, $2::uuid, 2, $3::bigint,
         now() + interval '1 hour', $4, 'TEST_ONLY_FAKE_HOT_1',
         1, 'FAILED_PRE_BROADCAST', now()
       )`,
      [
        withdrawalId,
        hotWalletId,
        BigInt(`9${Date.now()}`).toString(10),
        `fake-hash:${withdrawalId}:2`,
      ],
    );
    const scan = await runPhase10RestoreReconcileScan(pool, {
      historicalBaseline: baseline,
      liveAuthorizationWindowStartedAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(scan.findings.some((f) => f.attemptId === attemptId && f.severity === 'DANGER')).toBe(
      true,
    );
  }, 120_000);

  it('historical baseline: untouched isolated canonical snapshot → WARN not DANGER', async () => {
    const { attemptId } = await createAmbiguousSubmittedAttempt('9927');
    const artifact = await capturePhase10HistoricalBaselineForTests(
      pool,
      new Date(Date.now() - 60_000).toISOString(),
    );
    const baseline = historicalBaselineInputFromArtifact(artifact);
    const scan = await runPhase10RestoreReconcileScan(pool, {
      historicalBaseline: baseline,
      liveAuthorizationWindowStartedAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(
      scan.findings.some(
        (f) =>
          f.attemptId === attemptId &&
          f.category === 'historical_isolated_baseline' &&
          f.severity === 'WARN',
      ),
    ).toBe(true);
    expect(scan.findings.some((f) => f.attemptId === attemptId && f.severity === 'DANGER')).toBe(
      false,
    );
  }, 120_000);
});
