import { isStrongServerSignalAuthentication } from '../provider-sdk/capabilities.js';
import type {
  AdSignalAuthenticity,
  AdSignalCorrelation,
  CapabilityTriState,
  ProviderHealthStatus,
  ProviderMonetaryStatus,
  ProviderSignalAuthentication,
} from '../types.js';

export type ProviderMonetaryReasonCode =
  | 'PRODUCTION_MONETARY_STATUS_BLOCKED'
  | 'PRODUCTION_MONETARY_STATUS_TEST_ONLY'
  | 'PRODUCTION_MONETARY_STATUS_SUSPENDED'
  | 'CASH_REWARD_POLICY_NOT_APPROVED'
  | 'SERVER_SIGNAL_AUTHENTICATION_INSUFFICIENT'
  | 'SESSION_CORRELATION_NOT_CONFIRMED'
  | 'PROVIDER_HEALTH_UNAVAILABLE'
  | 'PROVIDER_HEALTH_SUSPENDED'
  | 'OPEN_CLARIFICATION_ITEMS'
  | 'REQUEST_HARD_LIMIT_EXCEEDED'
  | 'SUCCESS_HARD_LIMIT_EXCEEDED'
  | 'SIGNAL_AUTHENTICITY_NOT_VERIFIED'
  | 'SIGNAL_NOT_CORRELATED'
  | 'SIGNAL_CORRELATION_AMBIGUOUS';

export interface ProviderMonetaryEligibilityInput {
  readonly providerId: string;
  readonly providerCode: string;
  /** Authoritative `ad_providers.production_monetary_status`, read from the database. */
  readonly productionMonetaryStatus: ProviderMonetaryStatus;
  readonly cashRewardPolicyApproved: boolean;
  readonly serverSignalAuthentication: ProviderSignalAuthentication;
  readonly sessionOrImpressionCorrelation: CapabilityTriState;
  readonly health: ProviderHealthStatus;
  readonly openClarificationCount: number;
  readonly requestHardLimitExceeded: boolean;
  readonly successHardLimitExceeded: boolean;
  /** Per-session signal facts, when evaluating a concrete reward attempt. */
  readonly signalAuthenticity?: AdSignalAuthenticity;
  readonly signalCorrelation?: AdSignalCorrelation;
}

export interface ProviderMonetaryEligibilityResult {
  readonly eligible: boolean;
  readonly status: ProviderMonetaryStatus;
  readonly reasonCodes: readonly ProviderMonetaryReasonCode[];
}

/**
 * Provider-neutral production-money gate.
 *
 * Every input is a fact supplied by the caller from database rows or declared adapter
 * capabilities. There is no provider name branch and no permanent refusal compiled in:
 * a provider becomes eligible the moment its *data* says it is approved, its policy is
 * approved, its server signal can actually be authenticated and correlated, its health
 * allows traffic, its clarification register is empty and no hard limit is exceeded.
 */
export function evaluateProviderMonetaryEligibility(
  input: ProviderMonetaryEligibilityInput,
): ProviderMonetaryEligibilityResult {
  const reasonCodes: ProviderMonetaryReasonCode[] = [];

  switch (input.productionMonetaryStatus) {
    case 'BLOCKED':
      reasonCodes.push('PRODUCTION_MONETARY_STATUS_BLOCKED');
      break;
    case 'TEST_ONLY':
      reasonCodes.push('PRODUCTION_MONETARY_STATUS_TEST_ONLY');
      break;
    case 'SUSPENDED':
      reasonCodes.push('PRODUCTION_MONETARY_STATUS_SUSPENDED');
      break;
    case 'APPROVED':
      break;
  }

  if (!input.cashRewardPolicyApproved) {
    reasonCodes.push('CASH_REWARD_POLICY_NOT_APPROVED');
  }

  // A protected provider/server signal is mandatory for production money (§20).
  if (!isStrongServerSignalAuthentication(input.serverSignalAuthentication)) {
    reasonCodes.push('SERVER_SIGNAL_AUTHENTICATION_INSUFFICIENT');
  }

  if (input.sessionOrImpressionCorrelation !== 'SUPPORTED') {
    reasonCodes.push('SESSION_CORRELATION_NOT_CONFIRMED');
  }

  if (input.health === 'UNAVAILABLE') {
    reasonCodes.push('PROVIDER_HEALTH_UNAVAILABLE');
  }
  if (input.health === 'SUSPENDED') {
    reasonCodes.push('PROVIDER_HEALTH_SUSPENDED');
  }

  if (input.openClarificationCount > 0) {
    reasonCodes.push('OPEN_CLARIFICATION_ITEMS');
  }

  if (input.requestHardLimitExceeded) {
    reasonCodes.push('REQUEST_HARD_LIMIT_EXCEEDED');
  }
  if (input.successHardLimitExceeded) {
    reasonCodes.push('SUCCESS_HARD_LIMIT_EXCEEDED');
  }

  if (input.signalAuthenticity !== undefined && input.signalAuthenticity !== 'VERIFIED') {
    reasonCodes.push('SIGNAL_AUTHENTICITY_NOT_VERIFIED');
  }
  if (input.signalCorrelation !== undefined && input.signalCorrelation !== 'CORRELATED') {
    reasonCodes.push(
      input.signalCorrelation === 'AMBIGUOUS'
        ? 'SIGNAL_CORRELATION_AMBIGUOUS'
        : 'SIGNAL_NOT_CORRELATED',
    );
  }

  const status: ProviderMonetaryStatus =
    input.productionMonetaryStatus === 'APPROVED' && reasonCodes.length > 0
      ? 'BLOCKED'
      : input.productionMonetaryStatus;

  return {
    eligible: reasonCodes.length === 0,
    status,
    reasonCodes,
  };
}
