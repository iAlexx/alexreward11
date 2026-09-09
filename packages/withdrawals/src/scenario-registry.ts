import type { FakePayoutScenario } from './fake-chain.js';

/**
 * Process-local server-side scenario map for LOCAL/TEST fake payouts.
 * Never accept scenario from user/API input — tests and worker harness only.
 */
const scenariosByWithdrawalId = new Map<string, FakePayoutScenario>();

export function registerFakePayoutScenario(
  withdrawalId: string,
  scenario: FakePayoutScenario,
): void {
  scenariosByWithdrawalId.set(withdrawalId, scenario);
}

/** Take (and clear) the registered scenario, defaulting to CONFIRMED_SUCCESS. */
export function takeFakePayoutScenario(withdrawalId: string): FakePayoutScenario {
  const scenario = scenariosByWithdrawalId.get(withdrawalId) ?? 'CONFIRMED_SUCCESS';
  scenariosByWithdrawalId.delete(withdrawalId);
  return scenario;
}

/** Test helper — clear all registered scenarios between cases. */
export function clearFakePayoutScenarios(): void {
  scenariosByWithdrawalId.clear();
}
