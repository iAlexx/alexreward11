/**
 * Phase 10 closure-stage eligibility gate tests.
 * Fixture-only. Does not close the real Phase 10 campaign.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildPhase10ClosureAuditRecord,
  closePhase10,
  evaluatePhase10ClosureEligibility,
  transitionCampaignToPhase10FinalState,
  type Phase10ClosureCurrentSafetyInput,
  type Phase10ClosureEconomicSnapshot,
  type Phase10ClosureEligibilityInput,
} from '../src/phase10-closure-gate.js';
import type { Phase10CampaignManifest } from '../src/phase10-campaign.js';

const CAMPAIGN_ID = '2fdf9a3b-dee5-46e6-a2a4-4a0a10236093';
const CUTOFF = '2026-09-25T03:27:18.790Z';
const DIGEST = '679bb6944dbef90e0c2d2b5731ea88906cc723d0bd8dbe9a6c9f82750ee12456';
const USER_ID = '01a0ca6e-0e1f-7493-98f2-c546a5ccb9e1';

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function safeLocked(): Phase10ClosureCurrentSafetyInput {
  return {
    payoutDispatchPaused: true,
    signerCustodyState: 'LOCKED',
    signingReady: false,
    realChainEnabled: false,
    fakeChainEnabled: false,
  };
}

function economicOk(): Phase10ClosureEconomicSnapshot {
  return {
    unresolvedWithdrawals: 0,
    activePayoutLeases: 0,
    duplicateEconomicPayouts: 0,
    duplicateSettlements: 0,
    reservedBalanceAtomic: '0',
  };
}

function buildReadiness(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    recordedAt: '2026-09-25T02:58:14.505Z',
    liveAuthorizationWindow: true,
    verdict: 'READY_FOR_CONTROLLED_LIVE_TESTNET',
    controlledUserId: USER_ID,
    networkCode: 'TON_TESTNET',
    assetSymbol: 'USDT',
    realChainEnabled: true,
    fakeChainEnabled: false,
    signerProbed: true,
    signerReady: true,
    signerUnlocked: true,
    signerLockState: 'UNLOCKED',
    signerCustodyState: 'UNLOCKED',
    providers: {
      primary: {
        kind: 'tonapi',
        endpointFingerprint: 'https://testnet.tonapi.io:443',
        healthy: true,
        observedNetworkGlobalId: -3,
      },
      secondary: {
        kind: 'toncenter',
        endpointFingerprint: 'https://testnet.toncenter.com:443',
        healthy: true,
        observedNetworkGlobalId: -3,
      },
      independenceProven: true,
      independenceCode: null,
    },
    externalProbes: {
      schemaVersion: 1,
      observedAt: '2026-09-25T02:58:13.895Z',
      signer: {
        probePerformed: true,
        healthReachable: true,
        custodyState: 'UNLOCKED',
        signingReady: true,
        identityProbed: true,
        identityMatchesExpected: true,
        walletAddressMatchesExpected: true,
      },
      walletSeqnoAdmission: {
        probePerformed: true,
        admitted: true,
        seqno: 101,
        accountStatus: 'active',
      },
    },
    walletSeqnoAdmission: {
      probePerformed: true,
      admitted: true,
      seqno: 101,
      accountStatus: 'active',
      code: null,
    },
    preflightBlockers: [],
    preflightWarnings: [],
    restoreScanSummary: {
      dangerousCount: 0,
      warnCount: 0,
      scannedAt: '2026-09-25T02:58:14.505Z',
      historicalIsolatedBaselineCount: 0,
    },
    preflight: {
      verdict: 'READY_FOR_CONTROLLED_LIVE_TESTNET',
      liveAuthorizationWindow: true,
      realChainEnabled: true,
      fakeChainEnabled: false,
      networkCode: 'TON_TESTNET',
      assetSymbol: 'USDT',
      controlledUserId: USER_ID,
      recordedAt: '2026-09-25T02:58:14.505Z',
      signerProbed: true,
      signerReady: true,
      signerUnlocked: true,
      signerLockState: 'UNLOCKED',
    },
    ...overrides,
  };
}

function buildCampaign(count: number, extraOrdinal?: number): Record<string, unknown> {
  const withdrawalIds: string[] = [];
  const evidence: Record<string, unknown>[] = [];
  for (let i = 1; i <= count; i += 1) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    withdrawalIds.push(id);
    evidence.push({
      campaignId: CAMPAIGN_ID,
      ordinal: i,
      withdrawalId: id,
      confirmed: true,
      finalState: 'CONFIRMED',
      invariantResult: 'PASS',
    });
  }
  if (extraOrdinal !== undefined) {
    evidence.push({
      campaignId: CAMPAIGN_ID,
      ordinal: extraOrdinal,
      withdrawalId: '00000000-0000-4000-8000-000000000101',
      confirmed: true,
      finalState: 'CONFIRMED',
      invariantResult: 'PASS',
    });
  }
  return {
    schemaVersion: 1,
    campaignId: CAMPAIGN_ID,
    networkCode: 'TON_TESTNET',
    assetSymbol: 'USDT',
    controlledUserId: USER_ID,
    plannedCount: count,
    plannedPayoutCount: count,
    acceptanceCampaign: true,
    mode: 'real',
    status: 'AWAITING_OWNER_APPROVAL',
    realModeCheckpoint: 'OWNER_APPROVAL_REQUIRED',
    realExecutionGates: {
      campaignIdProvided: true,
      maxCountProvided: true,
      controlledUserProvided: true,
      networkIsTonTestnet: true,
      realChainEnabledTrue: true,
      fakeChainEnabledFalse: true,
      readinessPass: false,
      signerUnlockedExternally: false,
      confirmationPhraseMatches: true,
    },
    gates: null,
    baselineIsolatedHistoricalAttemptIds: [],
    withdrawalIds,
    evidence,
    createsWithdrawals: false,
    flipsEnv: false,
    mutatesFinancialState: false,
    unlocksSigner: false,
    createdAt: '2026-09-24T00:00:00.000Z',
    updatedAt: '2026-09-25T03:00:00.000Z',
    plan: {
      mode: 'real',
      accepted: true,
      refusalReason: null,
      intendedMatrix: [],
      localDeterministicCount: 0,
      requiresRealTestnetCount: 0,
      createsWithdrawals: false,
      flipsEnv: false,
    },
    amountPolicy: { grossAtomic: null, netAtomic: null, feeAtomic: null, note: null },
  };
}

async function writeFixture(opts?: {
  readonly acceptanceVerdict?: string;
  readonly readinessPass?: boolean;
  readonly ownerApproved?: boolean;
  readonly finalArchiveCreated?: boolean;
  readonly campaignCount?: number;
  readonly ordinal101?: boolean;
  readonly digest?: string;
  /** When set, chain file digest differs from Owner binding digest. */
  readonly chainFileDigest?: string;
  readonly knownAck?: boolean;
  readonly readinessValid?: boolean;
  readonly archiveHashTamper?: boolean;
  readonly economic?: Partial<Phase10ClosureEconomicSnapshot>;
  readonly safety?: Partial<Phase10ClosureCurrentSafetyInput>;
  readonly packageShaOverride?: string;
}): Promise<{
  readonly input: Phase10ClosureEligibilityInput;
  readonly dir: string;
  readonly campaignPath: string;
  readonly ownerPath: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'phase10-closure-'));
  const evidenceDir = join(dir, 'evidence');
  const archiveDir = join(dir, 'archive');
  await mkdir(evidenceDir, { recursive: true });
  await mkdir(archiveDir, { recursive: true });

  const campaignCount = opts?.campaignCount ?? 100;
  const campaign = buildCampaign(campaignCount, opts?.ordinal101 === true ? 101 : undefined);
  if (opts?.ordinal101 === true) {
    // keep planned/attached at 100 but add ordinal 101 evidence row
    campaign.plannedCount = 100;
    campaign.plannedPayoutCount = 100;
  }
  const readiness =
    opts?.readinessValid === false
      ? { schemaVersion: 1, verdict: 'BLOCKED' }
      : buildReadiness();
  const chain = {
    schemaVersion: 1,
    evidenceDigest: opts?.chainFileDigest ?? opts?.digest ?? DIGEST,
    generatedAt: '2026-09-25T03:27:18.907Z',
  };
  const failure = { schemaVersion: 1, scenarios: [] };
  const evalFinal = {
    generatedAt: '2026-09-25T03:27:28.951Z',
    acceptanceCutoff: CUTOFF,
    result: {
      verdict: opts?.acceptanceVerdict ?? 'PASS_EVIDENCE_PRESENT_OWNER_REVIEW_REQUIRED',
      mayCreateFinalArchive: opts?.readinessPass ?? true,
      mayMarkPhase10Closed: false,
      confirmedCount: campaignCount,
      duplicateEconomicPayouts: opts?.economic?.duplicateEconomicPayouts ?? 0,
      duplicateSettlements: opts?.economic?.duplicateSettlements ?? 0,
      acceptanceCutoff: CUTOFF,
    },
    readinessPass: opts?.readinessPass ?? true,
    mayCreateFinalArchive: opts?.readinessPass ?? true,
    mayMarkPhase10Closed: false,
  };
  const collector = { schemaVersion: 1, note: 'collector fixture' };

  const campaignPath = join(evidenceDir, 'campaign.json');
  const readinessPath = join(evidenceDir, 'readiness.json');
  const chainPath = join(evidenceDir, 'chain.json');
  const failurePath = join(evidenceDir, 'failure.json');
  const evalPath = join(evidenceDir, 'eval.json');
  const collectorPath = join(evidenceDir, 'collector.json');

  await writeFile(campaignPath, `${JSON.stringify(campaign, null, 2)}\n`);
  await writeFile(readinessPath, `${JSON.stringify(readiness, null, 2)}\n`);
  await writeFile(chainPath, `${JSON.stringify(chain, null, 2)}\n`);
  await writeFile(failurePath, `${JSON.stringify(failure, null, 2)}\n`);
  await writeFile(evalPath, `${JSON.stringify(evalFinal, null, 2)}\n`);
  await writeFile(collectorPath, `${JSON.stringify(collector, null, 2)}\n`);

  const sha = {
    campaign: sha256Hex(await readFile(campaignPath)),
    failureInjection: sha256Hex(await readFile(failurePath)),
    readiness: sha256Hex(await readFile(readinessPath)),
    chainHistory: sha256Hex(await readFile(chainPath)),
    chainHistoryCollector: sha256Hex(await readFile(collectorPath)),
    evalFinal: sha256Hex(await readFile(evalPath)),
  };

  const packageZipName = 'PHASE_10_TON_TESTNET_PAYOUT_PACKAGE_fixture.zip';
  const packageBody = Buffer.from('phase10-final-archive-fixture-body');
  const packagePath = join(archiveDir, packageZipName);
  await writeFile(packagePath, packageBody);
  let packageSha = sha256Hex(packageBody);
  if (opts?.archiveHashTamper === true) {
    packageSha = '0'.repeat(64);
  }
  const manifestBody = '# Phase 10 fixture manifest\n';
  const manifestPath = join(archiveDir, 'MANIFEST.md');
  await writeFile(manifestPath, manifestBody);
  const manifestSha = sha256Hex(manifestBody);
  await writeFile(join(archiveDir, 'PACKAGE_SHA256.txt'), `${packageSha}  ${packageZipName}\n`);
  // When tampering expected hash in Owner package, keep file hash as real unless override
  const recordedPackageSha = opts?.packageShaOverride ?? (opts?.archiveHashTamper ? packageSha : sha256Hex(packageBody));
  const actualPackageSha = sha256Hex(await readFile(packagePath));

  await writeFile(
    join(archiveDir, 'ARCHIVE_INDEX.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        packageKind: 'PHASE10_FINAL_EVIDENCE_ARCHIVE',
        finalArchiveCreated: true,
        phase10Closed: false,
        campaignId: CAMPAIGN_ID,
      },
      null,
      2,
    )}\n`,
  );

  const owner = {
    schemaVersion: 1,
    packageKind: 'PHASE10_OWNER_REVIEW_SUMMARY',
    ownerReviewApproved: opts?.ownerApproved ?? true,
    phase10Closed: false,
    finalArchiveCreated: opts?.finalArchiveCreated ?? true,
    ownerDecisionPending: false,
    acceptanceCutoff: CUTOFF,
    evaluator: {
      verdict: opts?.acceptanceVerdict ?? 'PASS_EVIDENCE_PRESENT_OWNER_REVIEW_REQUIRED',
      mayCreateFinalArchive: opts?.readinessPass ?? true,
      mayMarkPhase10Closed: false,
      confirmedCount: campaignCount,
      duplicateEconomicPayouts: opts?.economic?.duplicateEconomicPayouts ?? 0,
      duplicateSettlements: opts?.economic?.duplicateSettlements ?? 0,
    },
    ownerApproval: {
      approvedAt: '2026-09-25T03:37:02.256Z',
      evidenceBinding: {
        campaignId: CAMPAIGN_ID,
        acceptanceResult: opts?.acceptanceVerdict ?? 'PASS_EVIDENCE_PRESENT_OWNER_REVIEW_REQUIRED',
        acceptanceCutoff: CUTOFF,
        paths: {
          campaign: campaignPath,
          failureInjection: failurePath,
          readiness: readinessPath,
          chainHistory: chainPath,
          chainHistoryCollector: collectorPath,
          evalFinal: evalPath,
        },
        sha256: sha,
        chainHistory: {
          evidenceDigest: opts?.digest ?? DIGEST,
        },
      },
      knownTestCondition:
        opts?.knownAck === false
          ? undefined
          : {
              documented: true,
              ownerInformedAndAccepted: true,
              fullRepositoryTestSuiteGreen: false,
              knownUnrelatedFailures: {
                file: 'packages/withdrawals/test/phase10-canary-signing-recovery.test.ts',
                failingTestCount: 21,
              },
            },
    },
    archive: {
      packageZip: packageZipName,
      packageSha256: opts?.archiveHashTamper === true ? recordedPackageSha : actualPackageSha,
      manifest: 'MANIFEST.md',
      manifestSha256: manifestSha,
    },
  };

  const ownerPath = join(evidenceDir, 'owner-review-package.json');
  await writeFile(ownerPath, `${JSON.stringify(owner, null, 2)}\n`);

  return {
    dir,
    campaignPath,
    ownerPath,
    input: {
      ownerReviewPackagePath: ownerPath,
      finalArchiveDirectory: archiveDir,
      economicSnapshot: { ...economicOk(), ...(opts?.economic ?? {}) },
      currentSafety: { ...safeLocked(), ...(opts?.safety ?? {}) },
      controlledUserId: USER_ID,
      evaluatedAt: '2026-09-25T04:00:00.000Z',
    },
  };
}

describe('phase10 closure eligibility gate', () => {
  it('PASS path: eligible + mayMarkPhase10Closed=true with historical UNLOCKED B2 and current LOCKED', async () => {
    const { input } = await writeFixture();
    const result = await evaluatePhase10ClosureEligibility(input);
    expect(result.blockers).toEqual([]);
    expect(result.eligible).toBe(true);
    expect(result.mayMarkPhase10Closed).toBe(true);
    expect(result.historicalLiveReadiness.signerWasUnlockedDuringLiveWindow).toBe(true);
    expect(result.closureSafety.signerCustodyState).toBe('LOCKED');
    expect(result.knownTestCondition.classification).toBe(
      'KNOWN_ACCEPTED_NON_BLOCKING_CONDITION',
    );
    expect(result.knownTestCondition.fullRepositoryTestSuiteGreen).toBe(false);
    expect(result.checks.historicalLiveReadiness.status).toBe('PASS');
    expect(result.checks.closureSafety.status).toBe('PASS');
  });

  it('TEST1 technical acceptance invalid → false', async () => {
    const { input } = await writeFixture({ acceptanceVerdict: 'REFUSED_MISSING_LIVE_EVIDENCE' });
    const result = await evaluatePhase10ClosureEligibility(input);
    expect(result.mayMarkPhase10Closed).toBe(false);
    expect(result.blockers.some((b) => b.code === 'TECHNICAL_ACCEPTANCE_NOT_VALID')).toBe(true);
  });

  it('TEST2 Owner review not approved → false', async () => {
    const { input } = await writeFixture({ ownerApproved: false });
    const result = await evaluatePhase10ClosureEligibility(input);
    expect(result.mayMarkPhase10Closed).toBe(false);
    expect(result.blockers.some((b) => b.code === 'OWNER_REVIEW_NOT_APPROVED')).toBe(true);
  });

  it('TEST3 archive missing → false', async () => {
    const { input } = await writeFixture({ finalArchiveCreated: false });
    const result = await evaluatePhase10ClosureEligibility(input);
    expect(result.mayMarkPhase10Closed).toBe(false);
    expect(result.blockers.some((b) => b.code === 'FINAL_ARCHIVE_NOT_MARKED_CREATED')).toBe(true);
  });

  it('TEST4 archive hash mismatch → false', async () => {
    const { input } = await writeFixture({ archiveHashTamper: true });
    const result = await evaluatePhase10ClosureEligibility(input);
    expect(result.mayMarkPhase10Closed).toBe(false);
    expect(result.blockers.some((b) => b.code === 'FINAL_ARCHIVE_HASH_MISMATCH')).toBe(true);
  });

  it('TEST5 campaign 99/100 → false', async () => {
    const { input } = await writeFixture({ campaignCount: 99 });
    const result = await evaluatePhase10ClosureEligibility(input);
    expect(result.mayMarkPhase10Closed).toBe(false);
    expect(result.blockers.some((b) => b.code === 'CAMPAIGN_INCOMPLETE')).toBe(true);
  });

  it('TEST6 payout #101 exists → false', async () => {
    const { input } = await writeFixture({ ordinal101: true });
    const result = await evaluatePhase10ClosureEligibility(input);
    expect(result.mayMarkPhase10Closed).toBe(false);
    // either incomplete (101 evidence without 100 attached) or explicit 101
    expect(
      result.blockers.some(
        (b) => b.code === 'UNEXPECTED_PAYOUT_101' || b.code === 'CAMPAIGN_INCOMPLETE',
      ),
    ).toBe(true);
  });

  it('TEST7 unresolved withdrawal >0 → false', async () => {
    const { input } = await writeFixture({ economic: { unresolvedWithdrawals: 1 } });
    const result = await evaluatePhase10ClosureEligibility(input);
    expect(result.mayMarkPhase10Closed).toBe(false);
    expect(result.blockers.some((b) => b.code === 'UNRESOLVED_WITHDRAWALS')).toBe(true);
  });

  it('TEST8 active lease >0 → false', async () => {
    const { input } = await writeFixture({ economic: { activePayoutLeases: 2 } });
    const result = await evaluatePhase10ClosureEligibility(input);
    expect(result.mayMarkPhase10Closed).toBe(false);
    expect(result.blockers.some((b) => b.code === 'ACTIVE_PAYOUT_LEASES')).toBe(true);
  });

  it('TEST9 duplicate economic payout → false', async () => {
    const { input } = await writeFixture({ economic: { duplicateEconomicPayouts: 1 } });
    const result = await evaluatePhase10ClosureEligibility(input);
    expect(result.mayMarkPhase10Closed).toBe(false);
    expect(result.blockers.some((b) => b.code === 'DUPLICATE_ECONOMIC_PAYOUT')).toBe(true);
  });

  it('TEST10 evidence digest mismatch → false', async () => {
    const { input } = await writeFixture({
      digest: DIGEST,
      chainFileDigest: 'a'.repeat(64),
    });
    const result = await evaluatePhase10ClosureEligibility(input);
    expect(result.mayMarkPhase10Closed).toBe(false);
    expect(result.blockers.some((b) => b.code === 'CHAIN_EVIDENCE_DIGEST_MISMATCH')).toBe(true);
  });

  it('TEST11 pause=false → false', async () => {
    const { input } = await writeFixture({ safety: { payoutDispatchPaused: false } });
    const result = await evaluatePhase10ClosureEligibility(input);
    expect(result.mayMarkPhase10Closed).toBe(false);
    expect(result.blockers.some((b) => b.code === 'PAYOUT_DISPATCH_NOT_PAUSED')).toBe(true);
  });

  it('TEST12 signer UNLOCKED → false', async () => {
    const { input } = await writeFixture({
      safety: { signerCustodyState: 'UNLOCKED', signingReady: true },
    });
    const result = await evaluatePhase10ClosureEligibility(input);
    expect(result.mayMarkPhase10Closed).toBe(false);
    expect(result.blockers.some((b) => b.code === 'SIGNER_NOT_LOCKED')).toBe(true);
  });

  it('TEST13 REAL=true → false', async () => {
    const { input } = await writeFixture({ safety: { realChainEnabled: true } });
    const result = await evaluatePhase10ClosureEligibility(input);
    expect(result.mayMarkPhase10Closed).toBe(false);
    expect(result.blockers.some((b) => b.code === 'REAL_CHAIN_STILL_ENABLED')).toBe(true);
  });

  it('TEST14 FAKE=true → false', async () => {
    const { input } = await writeFixture({ safety: { fakeChainEnabled: true } });
    const result = await evaluatePhase10ClosureEligibility(input);
    expect(result.mayMarkPhase10Closed).toBe(false);
    expect(result.blockers.some((b) => b.code === 'FAKE_CHAIN_STILL_ENABLED')).toBe(true);
  });

  it('TEST15 current LOCKED + historical B2 UNLOCKED → PASS (lifecycle separation)', async () => {
    const { input } = await writeFixture();
    const result = await evaluatePhase10ClosureEligibility(input);
    expect(result.mayMarkPhase10Closed).toBe(true);
    expect(result.historicalLiveReadiness.signerWasUnlockedDuringLiveWindow).toBe(true);
    expect(result.closureSafety.signerCustodyState).toBe('LOCKED');
    expect(result.realExecutionGatesNote.toLowerCase()).toContain('historical');
  });

  it('TEST16 historical B2 readiness missing/invalid → false', async () => {
    const { input } = await writeFixture({ readinessValid: false });
    const result = await evaluatePhase10ClosureEligibility(input);
    expect(result.mayMarkPhase10Closed).toBe(false);
    expect(result.blockers.some((b) => b.code === 'HISTORICAL_LIVE_READINESS_INVALID')).toBe(true);
  });

  it('TEST17 known 21-test condition not acknowledged → false', async () => {
    const { input } = await writeFixture({ knownAck: false });
    const result = await evaluatePhase10ClosureEligibility(input);
    expect(result.mayMarkPhase10Closed).toBe(false);
    expect(result.blockers.some((b) => b.code === 'KNOWN_TEST_CONDITION_NOT_ACKNOWLEDGED')).toBe(
      true,
    );
  });

  it('campaign transition to COMPLETED preserves realExecutionGates and clears checkpoint', async () => {
    const { input, campaignPath } = await writeFixture();
    const eligibility = await evaluatePhase10ClosureEligibility(input);
    expect(eligibility.mayMarkPhase10Closed).toBe(true);
    const manifest = JSON.parse(await readFile(campaignPath, 'utf8')) as Phase10CampaignManifest;
    const beforeGates = manifest.realExecutionGates;
    const transition = transitionCampaignToPhase10FinalState(manifest, eligibility, CUTOFF);
    expect(transition.ok).toBe(true);
    expect(transition.finalStatus).toBe('COMPLETED');
    expect(transition.manifest?.status).toBe('COMPLETED');
    expect(transition.manifest?.realModeCheckpoint).toBeNull();
    expect(transition.manifest?.realExecutionGates).toEqual(beforeGates);
    expect(transition.realExecutionGatesUnchanged).toBe(true);
  });

  it('transition refuses when eligibility false', async () => {
    const { input, campaignPath } = await writeFixture({ ownerApproved: false });
    const eligibility = await evaluatePhase10ClosureEligibility(input);
    const manifest = JSON.parse(await readFile(campaignPath, 'utf8')) as Phase10CampaignManifest;
    const transition = transitionCampaignToPhase10FinalState(manifest, eligibility);
    expect(transition.ok).toBe(false);
    expect(transition.manifest).toBeNull();
  });

  it('closePhase10 without executeMutation does not mutate (eligible but not closed)', async () => {
    const { input, ownerPath, campaignPath } = await writeFixture();
    const beforeOwner = await readFile(ownerPath, 'utf8');
    const beforeCamp = await readFile(campaignPath, 'utf8');
    const result = await closePhase10({ eligibilityInput: input, executeMutation: false });
    expect(result.outcome).toBe('REFUSED_MUTATION_DISABLED');
    expect(result.mayMarkPhase10Closed).toBe(true);
    expect(result.phase10Closed).toBe(false);
    expect(result.mutated).toBe(false);
    expect(await readFile(ownerPath, 'utf8')).toBe(beforeOwner);
    expect(await readFile(campaignPath, 'utf8')).toBe(beforeCamp);
  });

  it('closePhase10 idempotent ALREADY_CLOSED / fixture mutation then second call', async () => {
    const { input, ownerPath, campaignPath } = await writeFixture();
    const first = await closePhase10({
      eligibilityInput: input,
      executeMutation: true,
      closureAuditOutputPath: join(input.finalArchiveDirectory, 'closure-audit.json'),
    });
    expect(first.outcome).toBe('CLOSED');
    expect(first.mutated).toBe(true);
    expect(first.phase10Closed).toBe(true);
    expect(first.campaignStatus).toBe('COMPLETED');
    const camp = JSON.parse(await readFile(campaignPath, 'utf8')) as Phase10CampaignManifest;
    expect(camp.status).toBe('COMPLETED');
    expect(camp.realModeCheckpoint).toBeNull();

    const second = await closePhase10({
      eligibilityInput: {
        ...input,
        ownerReviewPackagePath: ownerPath,
      },
      executeMutation: true,
    });
    expect(second.outcome).toBe('ALREADY_CLOSED');
    expect(second.mutated).toBe(false);
    expect(second.phase10Closed).toBe(true);
  });

  it('audit builder leaves closedAt null for eligibility-only records', async () => {
    const { input } = await writeFixture();
    const eligibility = await evaluatePhase10ClosureEligibility(input);
    const audit = buildPhase10ClosureAuditRecord({
      eligibility,
      closedAt: null,
      ownerApprovedAt: '2026-09-25T03:37:02.256Z',
    });
    expect(audit.packageKind).toBe('PHASE10_CLOSURE_AUDIT');
    expect(audit.closedAt).toBeNull();
    expect(audit.knownTestCondition.fullRepositoryTestSuiteGreen).toBe(false);
  });
});
