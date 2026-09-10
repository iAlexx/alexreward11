import { describe, expect, it } from 'vitest';

import { matchIntendedJettonPayout } from '../src/confirmation.js';

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
});
