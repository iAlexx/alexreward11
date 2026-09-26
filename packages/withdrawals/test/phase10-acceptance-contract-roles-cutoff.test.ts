/**
 * Phase 10 acceptance-contract: provider-role alignment + stable acceptanceCutoff.
 * No DB / chain mutation.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateChainHistoryForAcceptance,
  fingerprintProviderEndpoint,
  parsePhase10AcceptanceCutoff,
  resolvePhase10LiveProviderRoles,
} from '../src/index.js';
import { buildPhase10ProviderBackedChainHistoryEvidenceForTests } from '../src/phase10-chain-history-evidence.js';
import { PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID } from '../src/phase10-live-probes.js';

const TONAPI_URL = 'https://testnet.tonapi.io';
const TONCENTER_URL = 'https://testnet.toncenter.com/api/v2';
const TONAPI_FP = fingerprintProviderEndpoint(TONAPI_URL)!;
const TONCENTER_FP = fingerprintProviderEndpoint(TONCENTER_URL)!;

function providerBackedArtifact(input: {
  readonly primaryKind: string;
  readonly secondaryKind: string;
  readonly primaryFp: string;
  readonly secondaryFp: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly networkGlobalId?: number;
}) {
  return buildPhase10ProviderBackedChainHistoryEvidenceForTests({
    hotWalletAddress: '0:abcd',
    hotWalletJettonWallet: '0:jw',
    jettonMaster: '0:master',
    networkGlobalId: input.networkGlobalId ?? PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID,
    observationWindow: { start: input.windowStart, end: input.windowEnd },
    providerIdentity: {
      primaryKind: input.primaryKind,
      primaryEndpointFingerprint: input.primaryFp,
      secondaryKind: input.secondaryKind,
      secondaryEndpointFingerprint: input.secondaryFp,
      independenceProven: true,
    },
    providerEnumeratedOutgoingTransfers: [],
    expectedCampaignPayoutIdentities: [],
  });
}

describe('Phase 10 provider-role contract (P1–P8)', () => {
  it('P1: canonical TonAPI primary / TonCenter secondary resolves consistently', () => {
    const resolved = resolvePhase10LiveProviderRoles({
      primary: { kind: 'tonapi', baseUrl: TONAPI_URL },
      secondary: { kind: 'toncenter', baseUrl: TONCENTER_URL },
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.roles.primary.kind).toBe('tonapi');
    expect(resolved.roles.secondary.kind).toBe('toncenter');
    expect(resolved.roles.networkCode).toBe('TON_TESTNET');
    expect(resolved.roles.networkGlobalId).toBe(PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID);
    expect(resolved.roles.independenceProven).toBe(true);
    expect(resolved.roles.primary.endpointFingerprint).toBe(TONAPI_FP);
    expect(resolved.roles.secondary.endpointFingerprint).toBe(TONCENTER_FP);
  });

  it('P2: primary readiness fingerprint equals primary chain-history fingerprint', () => {
    const resolved = resolvePhase10LiveProviderRoles({
      primary: { kind: 'tonapi', baseUrl: TONAPI_URL },
      secondary: { kind: 'toncenter', baseUrl: TONCENTER_URL },
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const artifact = providerBackedArtifact({
      primaryKind: resolved.roles.primary.kind,
      secondaryKind: resolved.roles.secondary.kind,
      primaryFp: resolved.roles.primary.endpointFingerprint,
      secondaryFp: resolved.roles.secondary.endpointFingerprint,
      windowStart: '2026-09-23T02:00:00.000Z',
      windowEnd: '2026-09-25T00:00:00.000Z',
    });
    expect(artifact.providerIdentity.primaryEndpointFingerprint).toBe(
      resolved.roles.primary.endpointFingerprint,
    );
  });

  it('P3: secondary readiness fingerprint equals secondary chain-history fingerprint', () => {
    const resolved = resolvePhase10LiveProviderRoles({
      primary: { kind: 'tonapi', baseUrl: TONAPI_URL },
      secondary: { kind: 'toncenter', baseUrl: TONCENTER_URL },
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const artifact = providerBackedArtifact({
      primaryKind: resolved.roles.primary.kind,
      secondaryKind: resolved.roles.secondary.kind,
      primaryFp: resolved.roles.primary.endpointFingerprint,
      secondaryFp: resolved.roles.secondary.endpointFingerprint,
      windowStart: '2026-09-23T02:00:00.000Z',
      windowEnd: '2026-09-25T00:00:00.000Z',
    });
    expect(artifact.providerIdentity.secondaryEndpointFingerprint).toBe(
      resolved.roles.secondary.endpointFingerprint,
    );
  });

  it('P4: distinct endpoint fingerprints still required', () => {
    const resolved = resolvePhase10LiveProviderRoles({
      primary: { kind: 'tonapi', baseUrl: TONAPI_URL },
      secondary: { kind: 'toncenter', baseUrl: TONCENTER_URL },
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.roles.primary.endpointFingerprint).not.toBe(
      resolved.roles.secondary.endpointFingerprint,
    );
  });

  it('P5: same provider/endpoint used twice → FAIL CLOSED', () => {
    const sameKind = resolvePhase10LiveProviderRoles({
      primary: { kind: 'tonapi', baseUrl: TONAPI_URL },
      secondary: { kind: 'tonapi', baseUrl: 'https://other.tonapi.io' },
    });
    expect(sameKind.ok).toBe(false);

    const sameFp = resolvePhase10LiveProviderRoles({
      primary: { kind: 'tonapi', baseUrl: TONAPI_URL },
      secondary: { kind: 'toncenter', baseUrl: TONAPI_URL },
    });
    expect(sameFp.ok).toBe(false);
    if (sameFp.ok) return;
    expect(
      sameFp.reasons.some(
        (r) => r.includes('fingerprints must differ') || r.includes('independence'),
      ),
    ).toBe(true);
  });

  it('P6: incorrect network on chain-history binding → FAIL CLOSED', () => {
    const artifact = providerBackedArtifact({
      primaryKind: 'tonapi',
      secondaryKind: 'toncenter',
      primaryFp: TONAPI_FP,
      secondaryFp: TONCENTER_FP,
      windowStart: '2026-09-23T02:00:00.000Z',
      windowEnd: '2026-09-25T00:00:00.000Z',
      networkGlobalId: -239,
    });
    const evaluated = evaluateChainHistoryForAcceptance(artifact, {
      hotWalletAddress: '0:abcd',
      hotWalletJettonWallet: '0:jw',
      jettonMaster: '0:master',
      networkGlobalId: PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID,
      campaignWindowStart: '2026-09-23T02:00:00.000Z',
      campaignWindowEnd: '2026-09-25T00:00:00.000Z',
      primaryEndpointFingerprint: TONAPI_FP,
      secondaryEndpointFingerprint: TONCENTER_FP,
    });
    expect(evaluated.ok).toBe(false);
    expect(evaluated.reasons.some((r) => r.includes('networkGlobalId'))).toBe(true);
  });

  it('P7: genuinely different primary fingerprint → FAIL CLOSED', () => {
    const artifact = providerBackedArtifact({
      primaryKind: 'tonapi',
      secondaryKind: 'toncenter',
      primaryFp: TONAPI_FP,
      secondaryFp: TONCENTER_FP,
      windowStart: '2026-09-23T02:00:00.000Z',
      windowEnd: '2026-09-25T00:00:00.000Z',
    });
    const evaluated = evaluateChainHistoryForAcceptance(artifact, {
      hotWalletAddress: '0:abcd',
      hotWalletJettonWallet: '0:jw',
      jettonMaster: '0:master',
      networkGlobalId: PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID,
      campaignWindowStart: '2026-09-23T02:00:00.000Z',
      campaignWindowEnd: '2026-09-25T00:00:00.000Z',
      primaryEndpointFingerprint: 'https://other-primary.example:443',
      secondaryEndpointFingerprint: TONCENTER_FP,
    });
    expect(evaluated.ok).toBe(false);
    expect(
      evaluated.reasons.some((r) => r.includes('primary provider fingerprint mismatches')),
    ).toBe(true);
  });

  it('P8: genuinely different secondary fingerprint → FAIL CLOSED', () => {
    const artifact = providerBackedArtifact({
      primaryKind: 'tonapi',
      secondaryKind: 'toncenter',
      primaryFp: TONAPI_FP,
      secondaryFp: TONCENTER_FP,
      windowStart: '2026-09-23T02:00:00.000Z',
      windowEnd: '2026-09-25T00:00:00.000Z',
    });
    const evaluated = evaluateChainHistoryForAcceptance(artifact, {
      hotWalletAddress: '0:abcd',
      hotWalletJettonWallet: '0:jw',
      jettonMaster: '0:master',
      networkGlobalId: PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID,
      campaignWindowStart: '2026-09-23T02:00:00.000Z',
      campaignWindowEnd: '2026-09-25T00:00:00.000Z',
      primaryEndpointFingerprint: TONAPI_FP,
      secondaryEndpointFingerprint: 'https://other-secondary.example:443',
    });
    expect(evaluated.ok).toBe(false);
    expect(
      evaluated.reasons.some((r) => r.includes('secondary provider fingerprint mismatches')),
    ).toBe(true);
  });
});

describe('Phase 10 acceptanceCutoff observation-window contract (W1–W8)', () => {
  const T0 = '2026-09-25T12:00:00.000Z';
  const T0_PLUS = '2026-09-25T12:00:10.000Z';
  const T0_MINUS = '2026-09-25T11:59:50.000Z';
  const WINDOW_START = '2026-09-23T02:00:00.000Z';

  function windowEval(artifactEnd: string, cutoff: string) {
    const artifact = providerBackedArtifact({
      primaryKind: 'tonapi',
      secondaryKind: 'toncenter',
      primaryFp: TONAPI_FP,
      secondaryFp: TONCENTER_FP,
      windowStart: WINDOW_START,
      windowEnd: artifactEnd,
    });
    return evaluateChainHistoryForAcceptance(artifact, {
      hotWalletAddress: '0:abcd',
      hotWalletJettonWallet: '0:jw',
      jettonMaster: '0:master',
      networkGlobalId: PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID,
      campaignWindowStart: WINDOW_START,
      campaignWindowEnd: cutoff,
      primaryEndpointFingerprint: TONAPI_FP,
      secondaryEndpointFingerprint: TONCENTER_FP,
    });
  }

  it('W1: acceptanceCutoff=T0 and artifact end=T0 → coverage PASS (no window-end refuse)', () => {
    const evaluated = windowEval(T0, T0);
    expect(evaluated.ok).toBe(true);
    expect(evaluated.reasons.some((r) => r.includes('does not cover campaign end'))).toBe(false);
  });

  it('W2: artifact end > T0 → coverage PASS', () => {
    const evaluated = windowEval(T0_PLUS, T0);
    expect(evaluated.ok).toBe(true);
    expect(evaluated.reasons.some((r) => r.includes('does not cover campaign end'))).toBe(false);
  });

  it('W3: artifact end < T0 → REFUSE', () => {
    const evaluated = windowEval(T0_MINUS, T0);
    expect(evaluated.ok).toBe(false);
    expect(evaluated.reasons.some((r) => r.includes('does not cover campaign end'))).toBe(true);
  });

  it('W4: evaluator 10+ seconds after artifact end, but end >= captured T0 → no window refuse', () => {
    const evaluated = windowEval(T0, T0);
    const lateEvaluatorNow = '2026-09-25T12:00:15.000Z';
    const withLateNow = windowEval(T0, lateEvaluatorNow);
    expect(evaluated.ok).toBe(true);
    expect(evaluated.reasons.some((r) => r.includes('does not cover campaign end'))).toBe(false);
    expect(withLateNow.ok).toBe(false);
    expect(withLateNow.reasons.some((r) => r.includes('does not cover campaign end'))).toBe(true);
    expect(Date.parse(T0)).toBeLessThan(Date.parse(lateEvaluatorNow));
  });

  it('W5: missing cutoff → FAIL CLOSED', () => {
    const parsed = parsePhase10AcceptanceCutoff(undefined);
    expect(parsed.ok).toBe(false);
    expect(parsed.cutoff).toBeNull();
    expect(parsed.reason).toMatch(/acceptanceCutoff required/);
  });

  it('W6: invalid cutoff → FAIL CLOSED', () => {
    const parsed = parsePhase10AcceptanceCutoff('not-a-timestamp');
    expect(parsed.ok).toBe(false);
    expect(parsed.cutoff).toBeNull();
    expect(parsed.reason).toMatch(/not a valid ISO timestamp/);
  });

  it('W7: future-dated artifact is not required (end == T0 is enough)', () => {
    const evaluated = windowEval(T0, T0);
    expect(evaluated.ok).toBe(true);
    expect(evaluated.reasons.some((r) => r.includes('does not cover campaign end'))).toBe(false);
  });

  it('W8: no arbitrary tolerance/skew constant is used', async () => {
    const fs = await import('node:fs');
    const gateSrc = fs.readFileSync(
      new URL('../src/phase10-acceptance-gate.ts', import.meta.url),
      'utf8',
    );
    const probesSrc = fs.readFileSync(
      new URL('../src/phase10-live-probes.ts', import.meta.url),
      'utf8',
    );
    expect(gateSrc).not.toMatch(/TOLERANCE|SKEW|CLOCK_SKEW|\+ ?30_?000|\+ ?30 \* 1000/);
    expect(probesSrc).toMatch(/parsePhase10AcceptanceCutoff/);
    expect(gateSrc).toMatch(/campaignWindowEnd: acceptanceCutoff/);
    expect(gateSrc).not.toMatch(/campaignWindowEnd:\s*new Date\(\)/);
  });
});
