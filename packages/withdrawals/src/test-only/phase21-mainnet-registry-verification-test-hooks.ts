/**
 * Test-only branded Mainnet registry verification mint.
 * NOT part of public package API.
 * Requires NODE_ENV=test + ALEX_PHASE21_CEREMONY_TEST_HOOKS=1 +
 * ALEX_OWNER_BOOTSTRAP_TEST_HOOKS=1 + ALEX_OWNER_BOOTSTRAP_DISPOSABLE_PRODUCTION_SIM=1.
 */
import { isApprovedDestructiveTestDatabaseName } from '@alex-rewards/db';

import { mintAuthenticatedPhase21MainnetRegistryVerification } from '../phase21-mainnet-registry-verification-mint-internal.js';
import {
  Phase21MainnetRegistryVerificationError,
  type AuthenticatedPhase21MainnetRegistryVerification,
} from '../phase21-mainnet-registry-verification-trust.js';

function requireDisposableMainnetVerificationTestGates(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Phase21MainnetRegistryVerificationError(
      'FORBIDDEN',
      'Mainnet registry verification test mint requires NODE_ENV=test',
      {},
    );
  }
  if (process.env.ALEX_PHASE21_CEREMONY_TEST_HOOKS !== '1') {
    throw new Phase21MainnetRegistryVerificationError(
      'FORBIDDEN',
      'Mainnet registry verification test mint requires ALEX_PHASE21_CEREMONY_TEST_HOOKS=1',
      {},
    );
  }
  if (process.env.ALEX_OWNER_BOOTSTRAP_TEST_HOOKS !== '1') {
    throw new Phase21MainnetRegistryVerificationError(
      'FORBIDDEN',
      'Mainnet registry verification test mint requires ALEX_OWNER_BOOTSTRAP_TEST_HOOKS=1',
      {},
    );
  }
  if (process.env.ALEX_OWNER_BOOTSTRAP_DISPOSABLE_PRODUCTION_SIM !== '1') {
    throw new Phase21MainnetRegistryVerificationError(
      'FORBIDDEN',
      'Mainnet registry verification test mint requires ALEX_OWNER_BOOTSTRAP_DISPOSABLE_PRODUCTION_SIM=1',
      {},
    );
  }
}

/**
 * Mint branded Mainnet registry verification for disposable tests only.
 * Optional simulationDatabaseName must be an approved isolated test DB when provided.
 */
export function mintAuthenticatedPhase21MainnetRegistryVerificationForTests(input: {
  readonly jettonMaster: string;
  readonly verifiedAt?: string;
  readonly primaryProviderKind?: string;
  readonly secondaryProviderKind?: string;
  readonly primaryProviderHost?: string;
  readonly secondaryProviderHost?: string;
  readonly simulationDatabaseName?: string;
}): AuthenticatedPhase21MainnetRegistryVerification {
  requireDisposableMainnetVerificationTestGates();
  if (input.simulationDatabaseName !== undefined) {
    const db = input.simulationDatabaseName.trim().toLowerCase();
    if (db === 'railway' || db === 'alex_rewards' || !isApprovedDestructiveTestDatabaseName(input.simulationDatabaseName)) {
      throw new Phase21MainnetRegistryVerificationError(
        'FORBIDDEN',
        'Mainnet registry verification test mint refuses operational / non-approved databases',
        {},
      );
    }
  }
  const master = input.jettonMaster.trim();
  if (master === '') {
    throw new Phase21MainnetRegistryVerificationError(
      'VALIDATION',
      'jettonMaster required for test Mainnet registry verification mint',
      {},
    );
  }
  const primaryKind = (input.primaryProviderKind ?? 'toncenter').trim();
  const secondaryKind = (input.secondaryProviderKind ?? 'tonapi').trim();
  const primaryHost = (input.primaryProviderHost ?? 'toncenter.example.test').trim();
  const secondaryHost = (input.secondaryProviderHost ?? 'tonapi.example.test').trim();
  return mintAuthenticatedPhase21MainnetRegistryVerification({
    jettonMaster: master,
    verifiedAt: input.verifiedAt ?? new Date().toISOString(),
    primary: {
      providerKind: primaryKind,
      providerHost: primaryHost,
      networkIdentity: '-239',
      observedJettonMaster: master,
      verificationMethod: 'test_hook',
    },
    secondary: {
      providerKind: secondaryKind,
      providerHost: secondaryHost,
      networkIdentity: '-239',
      observedJettonMaster: master,
      verificationMethod: 'test_hook',
    },
  });
}


export {
  __runSimulatedLivePhase21MainnetRegistryVerificationAndMintTrustForTests,
} from '../phase21-mainnet-registry-live-verify-mint.js';
