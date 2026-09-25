import { describe, expect, it } from 'vitest';

import { matchIntendedJettonPayout, primarySecondaryEvidenceAgree } from '../src/confirmation.js';

describe('phase10 confirmation matchIntendedJettonPayout', () => {
  const expected = {
    hotWallet: 'EQ_hot',
    jettonMaster: 'EQ_master',
    recipient: 'EQ_recv',
    amountAtomic: '190000',
    queryId: '12345',
  };

  it('matches when all fields align and success/not bounced', () => {
    expect(
      matchIntendedJettonPayout(
        {
          ...expected,
          success: true,
          bounced: false,
        },
        expected,
      ),
    ).toBe(true);
  });

  it('rejects amount mismatch', () => {
    expect(
      matchIntendedJettonPayout(
        { ...expected, amountAtomic: '190001', success: true, bounced: false },
        expected,
      ),
    ).toBe(false);
  });

  it('rejects queryId mismatch', () => {
    expect(
      matchIntendedJettonPayout(
        { ...expected, queryId: '999', success: true, bounced: false },
        expected,
      ),
    ).toBe(false);
  });

  it('rejects bounced or unsuccessful transfers', () => {
    expect(
      matchIntendedJettonPayout({ ...expected, success: false, bounced: false }, expected),
    ).toBe(false);
    expect(matchIntendedJettonPayout({ ...expected, success: true, bounced: true }, expected)).toBe(
      false,
    );
  });

  it('rejects hot wallet / master / recipient mismatch', () => {
    expect(
      matchIntendedJettonPayout(
        { ...expected, hotWallet: 'EQ_other', success: true, bounced: false },
        expected,
      ),
    ).toBe(false);
    expect(
      matchIntendedJettonPayout(
        { ...expected, jettonMaster: 'EQ_other', success: true, bounced: false },
        expected,
      ),
    ).toBe(false);
    expect(
      matchIntendedJettonPayout(
        { ...expected, recipient: 'EQ_other', success: true, bounced: false },
        expected,
      ),
    ).toBe(false);
  });

  it('rejects network mismatch and sender Jetton wallet mismatch', () => {
    expect(
      matchIntendedJettonPayout(
        { ...expected, success: true, bounced: false, networkGlobalId: -239 },
        { ...expected, networkGlobalId: -3 },
      ),
    ).toBe(false);
    expect(
      matchIntendedJettonPayout(
        {
          ...expected,
          success: true,
          bounced: false,
          senderJettonWallet: 'EQ_wrong_jw',
        },
        { ...expected, senderJettonWallet: 'EQ_expected_jw' },
      ),
    ).toBe(false);
    expect(
      matchIntendedJettonPayout(
        {
          ...expected,
          success: true,
          bounced: false,
          networkGlobalId: -3,
          senderJettonWallet: 'EQ_expected_jw',
        },
        { ...expected, networkGlobalId: -3, senderJettonWallet: 'EQ_expected_jw' },
      ),
    ).toBe(true);
  });

  it('requires complete low-level proof fields from production adapters', () => {
    expect(
      matchIntendedJettonPayout(
        {
          ...expected,
          success: true,
          bounced: false,
          providerKind: 'tonapi',
        },
        expected,
      ),
    ).toBe(false);
    expect(
      matchIntendedJettonPayout(
        {
          ...expected,
          success: true,
          bounced: false,
          providerKind: 'tonapi',
          proofStage: 'COMPLETE',
          hotWalletTxHash: 'hot-tx',
          jettonWalletTxHash: 'sender-jetton-wallet-tx',
          recipientEvidence: 'recipient-jetton-wallet-tx',
        },
        expected,
      ),
    ).toBe(true);
  });
});

describe('phase10 confirmation primarySecondaryEvidenceAgree', () => {
  const expected = {
    hotWallet: '0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    jettonMaster: '0:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    recipient: '0:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    amountAtomic: '190000',
    queryId: '6336607349',
  };
  const completePrimary = {
    ...expected,
    success: true as const,
    bounced: false as const,
    providerKind: 'tonapi' as const,
    proofStage: 'COMPLETE' as const,
    hotWalletTxHash: 'hot-tx-a',
    jettonWalletTxHash: 'jw-tx-a',
    recipientEvidence: 'recv-tx-a',
  };
  const completeSecondary = {
    ...expected,
    success: true as const,
    bounced: false as const,
    providerKind: 'toncenter' as const,
    proofStage: 'COMPLETE' as const,
    hotWalletTxHash: 'hot-tx-b',
    jettonWalletTxHash: 'jw-tx-b',
    recipientEvidence: 'recv-tx-b',
  };

  it('agrees when both match intended payout fields', () => {
    expect(primarySecondaryEvidenceAgree(completePrimary, completeSecondary, expected)).toBe(true);
  });

  it('disagrees when secondary amount conflicts (primary MATCH alone insufficient)', () => {
    expect(
      primarySecondaryEvidenceAgree(
        completePrimary,
        { ...completeSecondary, amountAtomic: '180000' },
        expected,
      ),
    ).toBe(false);
  });

  it('disagrees when primary amount conflicts (secondary MATCH alone insufficient)', () => {
    expect(
      primarySecondaryEvidenceAgree(
        { ...completePrimary, amountAtomic: '180000' },
        completeSecondary,
        expected,
      ),
    ).toBe(false);
  });

  it('disagrees when success/bounce conflict', () => {
    expect(
      primarySecondaryEvidenceAgree(
        completePrimary,
        { ...completeSecondary, success: false, bounced: true },
        expected,
      ),
    ).toBe(false);
  });

  it('disagrees when recipient conflicts', () => {
    expect(
      primarySecondaryEvidenceAgree(
        completePrimary,
        {
          ...completeSecondary,
          recipient: '0:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        },
        expected,
      ),
    ).toBe(false);
  });
});
