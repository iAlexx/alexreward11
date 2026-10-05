/**
 * Test-only production trust helpers. NOT part of public package API.
 * Requires ALEX_OWNER_BOOTSTRAP_TEST_HOOKS=1.
 */
import { AuthDomainError } from '../../errors.js';
import type { BootstrapTrustMaterial } from '../redeem.js';
import type { ProductionCeremonyBundleV1 } from '../production-ceremony-bundle-v1.js';
import type { AuthenticatedProductionBootstrapTrust } from '../authenticated-production-trust.js';
import { mintAuthenticatedProductionBootstrapTrust } from '../production-trust-mint-internal.js';

function requireTestHooks(): void {
  if (process.env.ALEX_OWNER_BOOTSTRAP_TEST_HOOKS !== '1') {
    throw new AuthDomainError(
      'FORBIDDEN',
      'production trust test hooks require ALEX_OWNER_BOOTSTRAP_TEST_HOOKS=1',
    );
  }
}

export function mintAuthenticatedProductionBootstrapTrustForTests(input: {
  readonly trust: BootstrapTrustMaterial;
  readonly bundle: ProductionCeremonyBundleV1;
  readonly bundleDigestHex: string;
}): AuthenticatedProductionBootstrapTrust {
  requireTestHooks();
  return mintAuthenticatedProductionBootstrapTrust(input);
}

export function tryForgeProductionTrustFromCallerTrustClass(_input: {
  readonly trustClass: string;
}): false {
  requireTestHooks();
  return false;
}
