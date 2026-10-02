/**
 * Phase 21 Step 4A — production Owner-bootstrap readiness reporting (source only).
 */
import { missingProductionTrustResources } from './production-ceremony-gate.js';
import { PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS } from './production-trust-class.js';

export interface ProductionOwnerBootstrapReadinessReport {
  readonly trustClass: typeof PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS;
  readonly productionOwnerBootstrapSourceReady: true;
  readonly productionOwnerBootstrapTrustResourcesReady: boolean;
  readonly readyForProductionOwnerBootstrapCeremony: boolean;
  readonly missingProductionTrustResources: readonly string[];
  readonly isolatedBootstrapProductionAllowed: false;
  readonly hotWalletKeyReuseForbidden: true;
  readonly claimExistingAdminSupported: true;
  readonly duplicateAdminCreationAllowed: false;
  readonly programmaticForceApply: false;
  readonly passwordEnvAllowed: false;
  readonly totpEnvAllowed: false;
  readonly notes: readonly string[];
}

export function buildProductionOwnerBootstrapReadinessReport(input?: {
  readonly ceremonyDir?: string | null;
}): ProductionOwnerBootstrapReadinessReport {
  const missing = missingProductionTrustResources(input?.ceremonyDir ?? null);
  const trustResourcesReady = missing.length === 0;
  // Even with local files present, Layer C/D provenance auth is unimplemented —
  // ceremony readiness requires Owner-operated witnessed install beyond source files.
  const readyForCeremony = false;
  return {
    trustClass: PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS,
    productionOwnerBootstrapSourceReady: true,
    productionOwnerBootstrapTrustResourcesReady: trustResourcesReady,
    readyForProductionOwnerBootstrapCeremony: readyForCeremony,
    missingProductionTrustResources: trustResourcesReady
      ? [
          'LAYER_C_D_PROVENANCE_AUTH_UNIMPLEMENTED',
          'OWNER_OPERATED_WITNESSED_CEREMONY_NOT_EXECUTED',
        ]
      : missing,
    isolatedBootstrapProductionAllowed: false,
    hotWalletKeyReuseForbidden: true,
    claimExistingAdminSupported: true,
    duplicateAdminCreationAllowed: false,
    programmaticForceApply: false,
    passwordEnvAllowed: false,
    totpEnvAllowed: false,
    notes: [
      'Step4A source/readiness only — no operational Owner claim',
      'Hot Wallet key must never be reused as Owner bootstrap key',
      'owner-bootstrap-ceremony remains ephemeral_isolated_test_only',
      'READY_FOR_PRODUCTION_OWNER_BOOTSTRAP_CEREMONY requires Owner-operated seal+witness+CA+Channel B install',
    ],
  };
}