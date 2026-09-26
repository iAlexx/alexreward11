import { AdsDomainError } from '../errors.js';
import type { ProviderMonetaryStatus } from '../types.js';

import type { RewardedAdProvider } from './contract.js';

/**
 * Compile-time provider registry (Spec V1.3 §156D.1).
 *
 * Adapters are registered by explicit module import at build time. There is no dynamic
 * loading, no `eval`, and no database-driven code path: an unregistered provider code
 * can never be routed monetary traffic, and a registered adapter still cannot enable
 * itself — `production_monetary_status` in the database decides that.
 */
const registry = new Map<string, RewardedAdProvider>();

export function registerProvider(provider: RewardedAdProvider): RewardedAdProvider {
  const existing = registry.get(provider.code);
  if (existing !== undefined && existing !== provider) {
    throw new AdsDomainError(
      'VALIDATION',
      'provider code already registered with a different adapter',
      { details: { providerCode: provider.code } },
    );
  }
  registry.set(provider.code, provider);
  return provider;
}

export function getProvider(providerCode: string): RewardedAdProvider {
  const provider = registry.get(providerCode);
  if (provider === undefined) {
    throw new AdsDomainError('PROVIDER_NOT_REGISTERED', 'provider adapter is not registered', {
      details: { providerCode, registeredCodes: [...registry.keys()].sort() },
    });
  }
  return provider;
}

export function findProvider(providerCode: string): RewardedAdProvider | null {
  return registry.get(providerCode) ?? null;
}

export function listProviders(): readonly RewardedAdProvider[] {
  return [...registry.values()].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

export function listProviderCodes(): readonly string[] {
  return [...registry.keys()].sort();
}

/**
 * Gate for monetary routing: the provider code must resolve to a compile-time adapter,
 * and the caller's database-sourced monetary status must be APPROVED. An unknown code
 * is rejected outright rather than defaulted.
 */
export function requireRegisteredProviderForMonetaryUse(
  providerCode: string,
  productionMonetaryStatus: ProviderMonetaryStatus,
): RewardedAdProvider {
  const provider = getProvider(providerCode);
  if (productionMonetaryStatus !== 'APPROVED') {
    throw new AdsDomainError(
      'PROVIDER_MONETARY_BLOCKED',
      'provider is not approved for production monetary traffic',
      { details: { providerCode, productionMonetaryStatus } },
    );
  }
  return provider;
}

/** Test-support only: clears registrations so a suite can assert registry behaviour. */
export function resetProviderRegistryForTests(): void {
  registry.clear();
}
