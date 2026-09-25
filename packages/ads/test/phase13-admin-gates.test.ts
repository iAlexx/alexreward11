/**
 * Phase 13 packages/ads — monetary approval clarification gate + hard-limit helper.
 */
import { describe, expect, it } from 'vitest';

import {
  assertProviderMonetaryApprovalAllowed,
  AdsDomainError,
  refuseProviderMonetaryApprovalWithoutClarification,
  wouldExceedProviderHardLimit,
} from '../src/index.js';

describe('Phase 13 refuseProviderMonetaryApprovalWithoutClarification', () => {
  it('refuses APPROVED while clarifications remain open', () => {
    expect(
      refuseProviderMonetaryApprovalWithoutClarification({
        providerCode: 'ADSGRAM',
        targetStatus: 'APPROVED',
        openClarificationCount: 1,
      }),
    ).toEqual({ allowed: false, reasonCode: 'OPEN_CLARIFICATION_ITEMS' });
  });

  it('assert throws CLARIFICATION_GATE_OPEN', () => {
    expect(() =>
      assertProviderMonetaryApprovalAllowed({
        providerCode: 'ADSGRAM',
        targetStatus: 'APPROVED',
        openClarificationCount: 2,
      }),
    ).toThrow(AdsDomainError);
  });

  it('hard-limit helper refuses PLATFORM_SOFT above PROVIDER_HARD', () => {
    expect(
      wouldExceedProviderHardLimit({
        limitScope: 'PLATFORM_SOFT',
        proposedMaxCount: 31,
        hardCeilingMaxCount: 30,
      }),
    ).toBe(true);
  });
});
