/**
 * Phase 10 B3 Option C — USDT-Z pre-manifest canary predicate + loader coverage.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  PHASE10_USDT_Z_CANARY_WITHDRAWAL_ID,
  isAuthorizedPhase10PreManifestCanary,
  loadPhase10ExpectedCampaignPayouts,
} from '../src/index.js';

const ATTEMPT = '01a0cc7d-6045-7ffb-b272-93fb62695abc';
const BASELINE = [
  '01a0cb5f-5337-715c-9969-a6e79f85b5cd',
  '01a0cc5a-308c-7f0e-85c0-e852bd901e2d',
  ATTEMPT,
] as const;
const HOT = '0:085394446a0aaa34c0864d1d0083b935632152bcc861b3f418386d57d2eb74b3';
const MASTER = '0:53a1eee8c135c0472b4b75b14880ef1b5798f76d24e78b7f8140899be800c6e8';
const RECIPIENT = '0:2b4db4e1d331c85f413df2fda090b1fb715e90db3a2437f10a921f91b8b223c8';
const CONTROLLED = '01a0ca6e-0e1f-7493-98f2-c546a5ccb9e1';
const WINDOW = { start: '2024-01-01T00:00:00.000Z', end: '2026-12-31T00:00:00.000Z' };
const CREATED_AT = '2026-09-23T18:53:07.745Z';
const SETTLEMENT = '01a0ccd8-4efd-7e45-81b9-de56970764c3';

function authorizedFacts(
  overrides: Partial<Parameters<typeof isAuthorizedPhase10PreManifestCanary>[0]> = {},
) {
  return {
    withdrawalId: PHASE10_USDT_Z_CANARY_WITHDRAWAL_ID,
    campaignWithdrawalIds: [PHASE10_USDT_Z_CANARY_WITHDRAWAL_ID, randomUUID()],
    evidenceOrdinal: 1,
    withdrawalState: 'CONFIRMED',
    settlementLedgerTxId: SETTLEMENT,
    hasIntendedPayoutProven: true,
    finalSuccessfulAttemptId: ATTEMPT,
    baselineIsolatedHistoricalAttemptIds: [...BASELINE],
    evidenceInvariantPass: true,
    ...overrides,
  };
}

describe('phase10 USDT-Z pre-manifest canary (B3 Option C)', () => {
  it('TEST 1 — exact canary accepted when all guards pass (requested_at < createdAt)', () => {
    expect(isAuthorizedPhase10PreManifestCanary(authorizedFacts())).toBe(true);
  });

  it('TEST 2 — wrong UUID still rejected', () => {
    expect(
      isAuthorizedPhase10PreManifestCanary(
        authorizedFacts({
          withdrawalId: randomUUID(),
          campaignWithdrawalIds: [randomUUID()],
        }),
      ),
    ).toBe(false);
  });

  it('TEST 3 — ordinal != 1 rejected', () => {
    expect(isAuthorizedPhase10PreManifestCanary(authorizedFacts({ evidenceOrdinal: 2 }))).toBe(
      false,
    );
    expect(isAuthorizedPhase10PreManifestCanary(authorizedFacts({ evidenceOrdinal: null }))).toBe(
      false,
    );
  });

  it('TEST 4 — missing IPP rejected', () => {
    expect(
      isAuthorizedPhase10PreManifestCanary(authorizedFacts({ hasIntendedPayoutProven: false })),
    ).toBe(false);
  });

  it('TEST 5 — missing settlement rejected', () => {
    expect(
      isAuthorizedPhase10PreManifestCanary(authorizedFacts({ settlementLedgerTxId: null })),
    ).toBe(false);
    expect(
      isAuthorizedPhase10PreManifestCanary(authorizedFacts({ settlementLedgerTxId: '   ' })),
    ).toBe(false);
  });

  it('TEST 6 — not CONFIRMED rejected', () => {
    expect(
      isAuthorizedPhase10PreManifestCanary(authorizedFacts({ withdrawalState: 'APPROVED' })),
    ).toBe(false);
  });

  it('TEST 7 — attempt not in baseline allowlist rejected', () => {
    expect(
      isAuthorizedPhase10PreManifestCanary(
        authorizedFacts({
          finalSuccessfulAttemptId: randomUUID(),
        }),
      ),
    ).toBe(false);
    expect(
      isAuthorizedPhase10PreManifestCanary(
        authorizedFacts({ baselineIsolatedHistoricalAttemptIds: [] }),
      ),
    ).toBe(false);
    expect(
      isAuthorizedPhase10PreManifestCanary(
        authorizedFacts({ baselineIsolatedHistoricalAttemptIds: null }),
      ),
    ).toBe(false);
  });

  it('TEST 8 — campaign membership absent rejected', () => {
    expect(
      isAuthorizedPhase10PreManifestCanary(
        authorizedFacts({ campaignWithdrawalIds: [randomUUID()] }),
      ),
    ).toBe(false);
    expect(
      isAuthorizedPhase10PreManifestCanary(authorizedFacts({ campaignWithdrawalIds: null })),
    ).toBe(false);
  });

  it('TEST 9 — publicId-only / invariant missing still fail closed', () => {
    // Predicate never accepts by publicId; wrong UUID already covered.
    // Missing evidence invariant PASS must refuse even if other fields look good.
    expect(
      isAuthorizedPhase10PreManifestCanary(authorizedFacts({ evidenceInvariantPass: false })),
    ).toBe(false);
    expect(
      isAuthorizedPhase10PreManifestCanary(authorizedFacts({ evidenceInvariantPass: null })),
    ).toBe(false);
  });

  it('TEST 10 — collector includes authorized canary with requested_at < createdAt', async () => {
    const otherId = randomUUID();
    const otherAttempt = randomUUID();
    const canaryRequestedAt = new Date('2026-09-23T02:24:05.084Z');
    const otherRequestedAt = new Date('2026-09-24T00:00:00.000Z');

    const fakeDb = {
      query: async () => ({
        rows: [
          {
            withdrawal_id: PHASE10_USDT_Z_CANARY_WITHDRAWAL_ID,
            attempt_id: ATTEMPT,
            observed_query_id: '9192767702',
            correlation_reference: 'corr-canary',
            observed_recipient: RECIPIENT,
            observed_amount_atomic: '190000',
            evidence_summary: {
              jettonMaster: MASTER,
              primaryTransactionIdentity: 'canary-tx',
            },
            resolved_at: new Date('2026-09-23T05:58:43.160Z'),
            recipient: RECIPIENT,
            net_amount_atomic: '190000',
            jetton_master: MASTER,
            attempt_query_id: '9192767702',
            broadcasted_at: new Date('2026-09-23T04:19:24.035Z'),
            broadcast_submitted_at: new Date('2026-09-23T04:19:24.035Z'),
            requested_at: canaryRequestedAt,
            hot_wallet_address: HOT,
            withdrawal_state: 'CONFIRMED',
            settlement_ledger_tx_id: SETTLEMENT,
          },
          {
            withdrawal_id: otherId,
            attempt_id: otherAttempt,
            observed_query_id: '99',
            correlation_reference: 'corr-other',
            observed_recipient: RECIPIENT,
            observed_amount_atomic: '190000',
            evidence_summary: {
              jettonMaster: MASTER,
              primaryTransactionIdentity: 'other-tx',
            },
            resolved_at: new Date('2026-09-24T01:00:00.000Z'),
            recipient: RECIPIENT,
            net_amount_atomic: '190000',
            jetton_master: MASTER,
            attempt_query_id: '99',
            broadcasted_at: new Date('2026-09-24T00:30:00.000Z'),
            broadcast_submitted_at: new Date('2026-09-24T00:30:00.000Z'),
            requested_at: otherRequestedAt,
            hot_wallet_address: HOT,
            withdrawal_state: 'CONFIRMED',
            settlement_ledger_tx_id: randomUUID(),
          },
        ],
      }),
    };

    const payouts = await loadPhase10ExpectedCampaignPayouts(fakeDb as never, {
      campaignWithdrawalIds: [PHASE10_USDT_Z_CANARY_WITHDRAWAL_ID, otherId],
      window: WINDOW,
      campaignCreatedAt: CREATED_AT,
      expectedHotWalletAddress: HOT,
      expectedJettonMaster: MASTER,
      controlledUserId: CONTROLLED,
      baselineIsolatedHistoricalAttemptIds: [...BASELINE],
      campaignEvidenceOrdinalByWithdrawalId: {
        [PHASE10_USDT_Z_CANARY_WITHDRAWAL_ID]: 1,
        [otherId]: 2,
      },
      campaignEvidenceInvariantPassByWithdrawalId: {
        [PHASE10_USDT_Z_CANARY_WITHDRAWAL_ID]: true,
        [otherId]: true,
      },
    });

    expect(payouts).toHaveLength(2);
    expect(payouts.map((p) => p.withdrawalId).sort()).toEqual(
      [PHASE10_USDT_Z_CANARY_WITHDRAWAL_ID, otherId].sort(),
    );
    expect(payouts.find((p) => p.withdrawalId === PHASE10_USDT_Z_CANARY_WITHDRAWAL_ID)?.queryId).toBe(
      '9192767702',
    );
  });

  it('TEST 11 — collector still rejects unrelated historical payout before createdAt', async () => {
    const historicalId = randomUUID();
    const historicalAttempt = randomUUID();
    const fakeDb = {
      query: async () => ({
        rows: [
          {
            withdrawal_id: historicalId,
            attempt_id: historicalAttempt,
            observed_query_id: '1',
            correlation_reference: 'corr-h',
            observed_recipient: RECIPIENT,
            observed_amount_atomic: '190000',
            evidence_summary: { jettonMaster: MASTER, primaryTransactionIdentity: 'h-tx' },
            resolved_at: new Date('2026-09-22T00:00:00.000Z'),
            recipient: RECIPIENT,
            net_amount_atomic: '190000',
            jetton_master: MASTER,
            attempt_query_id: '1',
            broadcasted_at: new Date('2026-09-22T00:00:00.000Z'),
            broadcast_submitted_at: new Date('2026-09-22T00:00:00.000Z'),
            requested_at: new Date('2026-09-22T00:00:00.000Z'),
            hot_wallet_address: HOT,
            withdrawal_state: 'CONFIRMED',
            settlement_ledger_tx_id: randomUUID(),
          },
        ],
      }),
    };

    await expect(
      loadPhase10ExpectedCampaignPayouts(fakeDb as never, {
        campaignWithdrawalIds: [historicalId],
        window: WINDOW,
        campaignCreatedAt: CREATED_AT,
        expectedHotWalletAddress: HOT,
        expectedJettonMaster: MASTER,
        controlledUserId: CONTROLLED,
        baselineIsolatedHistoricalAttemptIds: [historicalAttempt],
        campaignEvidenceOrdinalByWithdrawalId: { [historicalId]: 1 },
        campaignEvidenceInvariantPassByWithdrawalId: { [historicalId]: true },
      }),
    ).rejects.toThrow(/INTENDED_PAYOUT_PROVEN/);
  });

  it('collector refuses canary when ordinal/guards incomplete even if SQL returns row', async () => {
    const fakeDb = {
      query: async () => ({
        rows: [
          {
            withdrawal_id: PHASE10_USDT_Z_CANARY_WITHDRAWAL_ID,
            attempt_id: ATTEMPT,
            observed_query_id: '9192767702',
            correlation_reference: 'corr-canary',
            observed_recipient: RECIPIENT,
            observed_amount_atomic: '190000',
            evidence_summary: { jettonMaster: MASTER, primaryTransactionIdentity: 'canary-tx' },
            resolved_at: new Date('2026-09-23T05:58:43.160Z'),
            recipient: RECIPIENT,
            net_amount_atomic: '190000',
            jetton_master: MASTER,
            attempt_query_id: '9192767702',
            broadcasted_at: new Date('2026-09-23T04:19:24.035Z'),
            broadcast_submitted_at: new Date('2026-09-23T04:19:24.035Z'),
            requested_at: new Date('2026-09-23T02:24:05.084Z'),
            hot_wallet_address: HOT,
            withdrawal_state: 'CONFIRMED',
            settlement_ledger_tx_id: SETTLEMENT,
          },
        ],
      }),
    };

    await expect(
      loadPhase10ExpectedCampaignPayouts(fakeDb as never, {
        campaignWithdrawalIds: [PHASE10_USDT_Z_CANARY_WITHDRAWAL_ID],
        window: WINDOW,
        campaignCreatedAt: CREATED_AT,
        expectedHotWalletAddress: HOT,
        expectedJettonMaster: MASTER,
        controlledUserId: CONTROLLED,
        baselineIsolatedHistoricalAttemptIds: [...BASELINE],
        // ordinal 2 — must refuse
        campaignEvidenceOrdinalByWithdrawalId: { [PHASE10_USDT_Z_CANARY_WITHDRAWAL_ID]: 2 },
        campaignEvidenceInvariantPassByWithdrawalId: {
          [PHASE10_USDT_Z_CANARY_WITHDRAWAL_ID]: true,
        },
      }),
    ).rejects.toThrow(/INTENDED_PAYOUT_PROVEN/);
  });
});
