/**
 * Phase 21 Step 4A.1 — honest production Owner-bootstrap readiness reporting.
 */
import { missingProductionTrustResources } from './production-ceremony-gate.js';
import { PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS } from './production-trust-class.js';

export interface ProductionOwnerBootstrapReadinessReport {
  readonly trustClass: typeof PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS;
  readonly productionOwnerBootstrapSourceReady: boolean;
  readonly productionOwnerBootstrapSchemaReady: boolean | null;
  readonly productionOwnerBootstrapEndpointTrustReady: boolean;
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
  readonly callerControlledProductionTrustClass: false;
  readonly productionTrustRuntimeBranded: true;
  readonly layerCDProvenanceAuthImplemented: true;
  readonly channelBOperationalSource: 'LIVE_OWNER_TTY_OFFLINE_MEDIA';
  readonly sameHostChannelBFileSufficient: false;
  readonly targetAdminRootBound: true;
  readonly witnessModel: 'HUMAN_ATTESTED';
  readonly witnessCryptographicIdentityProven: false;
  readonly notes: readonly string[];
}

/**
 * Source readiness is YES only when Step4A.1 capabilities are present in code.
 * Real-world ceremony resources / endpoint / schema are tracked separately.
 */
export function buildProductionOwnerBootstrapReadinessReport(input?: {
  readonly ceremonyDir?: string | null;
  readonly schemaReady?: boolean | null;
  readonly endpointTrustReady?: boolean;
  readonly capabilities?: {
    readonly productionLifecycleEndToEnd?: boolean;
    readonly authenticatedTrustMandatory?: boolean;
    readonly targetAdminRootBound?: boolean;
    readonly layerCDImplemented?: boolean;
    readonly failClosedExistingAdmin?: boolean;
    readonly productionTransactionPath?: boolean;
  };
}): ProductionOwnerBootstrapReadinessReport {
  const caps = input?.capabilities ?? {};
  const sourceReady = Boolean(
    caps.productionLifecycleEndToEnd !== false &&
      caps.authenticatedTrustMandatory !== false &&
      caps.targetAdminRootBound !== false &&
      caps.layerCDImplemented !== false &&
      caps.failClosedExistingAdmin !== false &&
      caps.productionTransactionPath !== false,
  );
  const missing = missingProductionTrustResources(input?.ceremonyDir ?? null);
  const trustResourcesReady = missing.length === 0;
  const schemaReady = input?.schemaReady ?? null;
  const endpointTrustReady = input?.endpointTrustReady === true;
  const readyForCeremony =
    sourceReady &&
    trustResourcesReady &&
    schemaReady === true &&
    endpointTrustReady;
  return {
    trustClass: PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS,
    productionOwnerBootstrapSourceReady: sourceReady,
    productionOwnerBootstrapSchemaReady: schemaReady,
    productionOwnerBootstrapEndpointTrustReady: endpointTrustReady,
    productionOwnerBootstrapTrustResourcesReady: trustResourcesReady,
    readyForProductionOwnerBootstrapCeremony: readyForCeremony,
    missingProductionTrustResources: trustResourcesReady
      ? [
          ...(schemaReady === true ? [] : ['PRODUCTION_OWNER_BOOTSTRAP_SCHEMA_READY=NO_OR_UNKNOWN']),
          ...(endpointTrustReady ? [] : ['PRODUCTION_BOOTSTRAP_ENDPOINT_TRUST_NOT_ESTABLISHED']),
          'OWNER_OPERATED_WITNESSED_CEREMONY_NOT_EXECUTED',
          'LIVE_OWNER_TTY_CHANNEL_B_NOT_PERFORMED',
        ]
      : missing,
    isolatedBootstrapProductionAllowed: false,
    hotWalletKeyReuseForbidden: true,
    claimExistingAdminSupported: true,
    duplicateAdminCreationAllowed: false,
    programmaticForceApply: false,
    passwordEnvAllowed: false,
    totpEnvAllowed: false,
    callerControlledProductionTrustClass: false,
    productionTrustRuntimeBranded: true,
    layerCDProvenanceAuthImplemented: true,
    channelBOperationalSource: 'LIVE_OWNER_TTY_OFFLINE_MEDIA',
    sameHostChannelBFileSufficient: false,
    targetAdminRootBound: true,
    witnessModel: 'HUMAN_ATTESTED',
    witnessCryptographicIdentityProven: false,
    notes: [
      'Step4A.1 source/readiness — no operational Owner claim',
      'Channel B file is documentary only; operational auth is live Owner TTY',
      'Witness model is HUMAN_ATTESTED (not cryptographic identity proof)',
      'Hot Wallet key must never be reused as Owner bootstrap key',
    ],
  };
}
