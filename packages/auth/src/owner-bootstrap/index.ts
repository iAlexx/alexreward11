export { canonicalizeToJcs, JcsError } from './jcs.js';
export {
  DuplicateJsonKeyError,
  parseStrictJson,
} from './strict-json.js';
export {
  base64UrlDecode,
  base64UrlEncode,
  bytesToHex,
  ed25519Sign,
  ed25519Verify,
  generateEd25519KeyPair,
  hexToBytes,
} from './ed25519.js';
export {
  buildTestGrantPayload,
  createEphemeralCeremonyAuthority,
  fingerprintPublicKey,
  intendedSubjectFromPayload,
  parseAndVerifyGrantEnvelope,
  signGrantEnvelope,
  validateGrantPayload,
  type CeremonyAuthority,
  type DeploymentEnv,
  type OwnerBootstrapGrantEnvelope,
  type OwnerBootstrapGrantPayload,
} from './grant.js';
export {
  buildIsolatedTestEndpointProfile,
  type BootstrapEndpointProfile,
  type BootstrapTlsMode,
} from './endpoint.js';
export {
  CEREMONY_ENDPOINT_PROFILE_DIGEST_METHOD,
  bootstrapEndpointProfileFromCeremonyWire,
  ceremonyWireFromBootstrapEndpointProfile,
  digestCeremonyEndpointProfileV1,
  parseCeremonyEndpointProfileV1Json,
  validateCeremonyEndpointProfileV1,
  type CeremonyDeploymentEnvV1,
  type CeremonyEndpointProfileTlsV1,
  type CeremonyEndpointProfileV1,
} from './ceremony-profile-v1.js';
export {
  CEREMONY_SEAL_PROVENANCE_CHANNEL_B_V1,
  assertSealProfileDigestMatchesProfile,
  digestCeremonySealV1,
  parseCeremonySealV1Json,
  validateCeremonySealV1,
  type CeremonySealV1,
  type CeremonySealWitnessV1,
} from './ceremony-seal-v1.js';
export {
  DEPLOYMENT_TRUST_DERIVATIVE_KIND_V1,
  assertDerivativeConsistentWithProfile,
  assertDerivativeDigestEqualsRecordedSealDigest,
  claimDerivativeProvenanceAuthenticated,
  parseDeploymentTrustDerivativeV1Json,
  refuseSameHostChecksumAsChannelB,
  validateDeploymentTrustDerivativeV1,
  type DeploymentTrustDerivativeV1,
} from './ceremony-trust-derivative-v1.js';
export {
  ISOLATED_OWNER_CEREMONY_TARGET,
  assertIsolatedSealProfileDigestMatches,
  bootstrapEndpointProfileFromIsolatedCeremonyWire,
  buildIsolatedCeremonyEndpointProfileV1,
  digestIsolatedCeremonyEndpointProfileV1,
  parseIsolatedCeremonyEndpointProfileV1Json,
  validateIsolatedCeremonyEndpointProfileV1,
  type IsolatedCeremonyEndpointProfileV1,
} from './isolated-ceremony-profile-v1.js';
export {
  assertCeremonyDirOutsideRepo,
  assertConnectionUrlAllowedForIsolatedCeremony,
  assertIsolatedCeremonyAllowsEnrollment,
  assertWitnessesAreConcrete,
  draftCeremonySeal,
  generateEphemeralCeremonyKeypairFiles,
  loadCeremonyAuthorityFromDir,
  loadCeremonyPublicKey,
  loadCeremonySeal,
  loadChannelBRecord,
  loadIsolatedCeremonyProfile,
  recordChannelBDigestFromOwner,
  writeCeremonyPublicManifest,
  writeIsolatedCeremonyProfile,
  type CeremonyPublicKeyRecord,
  type CeremonyPublicManifest,
  type ChannelBOwnerDigestRecord,
} from './isolated-ceremony-gate.js';
export {
  buildIsolatedCeremonyGrantPayload,
  openIsolatedCeremonyBootstrap,
  runIsolatedOptionCEnrollment,
} from './isolated-ceremony-enroll.js';
export {
  ISOLATED_TELEGRAM_OWNER_BOOTSTRAP_TARGET,
  assertConfiguredOwnerTelegramUserId,
  assertIsolatedTelegramOwnerBootstrapTarget,
  enrollIsolatedTelegramOwner,
  parseIsolatedOwnerBootstrapUrl,
  verifyOwnerTelegramIdentityForBootstrap,
  type IsolatedTelegramOwnerBootstrapResult,
  type IsolatedTelegramOwnerBootstrapUrlFacts,
} from './isolated-telegram-owner-bootstrap.js';
export {
  G5_SPKI_V1_DECISION,
  assertSpkiPinningUnsupportedForV1,
  buildVerifyFullTlsSocketOptions,
} from './tls-verify-full.js';
export {
  assertBootstrapTlsAndEndpoint,
  assertNoConflictingSslConnectionParams,
  assertPoolBoundBootstrapTrust,
  buildOwnerBootstrapPoolConfig,
  clearIsolatedTestBootstrapClock,
  createBootstrapTrustMaterial,
  createOwnerBootstrapPool,
  readAuthoritativeBootstrapNowSec,
  peekIsolatedTestBootstrapClock,
  setIsolatedTestBootstrapClock,
  type BootstrapConnectionFacts,
  type OwnerBootstrapPool,
} from './pool.js';
export {
  OWNER_BOOTSTRAP_LOCK_ORDER,
  abortOwnerBootstrapAttempt,
  buildChannelAbortBytes,
  buildChannelPopBytes,
  buildFinalCredBytes,
  buildOwnerChallengeBytes,
  completeOwnerBootstrapEnrollment,
  createEnrollmentChannelKeypair,
  generateTotpCode,
  generateTotpSecretBytes,
  // internalSupersedePendingBootstrapAttempt intentionally NOT re-exported from package root
  // (narrow internal cleanup — available via owner-bootstrap/index for in-package use only).
  signChannelAbort,
  signChannelPop,
  signFinalCredReq,
  signOwnerRedeemChallenge,
  startOwnerBootstrapAttempt,
  submitOwnerBootstrapPop,
  type BootstrapTrustMaterial,
  type CompleteEnrollmentInput,
  type CompleteEnrollmentResult,
  type EnrollmentChannelKeypair,
  type FinalCredPublicHeader,
  type StartAttemptResult,
  type SubmitPopResult,
} from './redeem.js';

// Re-export internal helper only from this subpath module (not packages/auth public API).
export { internalSupersedePendingBootstrapAttempt } from './redeem.js';

export {
  PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS,
  ISOLATED_OWNER_BOOTSTRAP_TRUST_CLASS,
  type ProductionOwnerBootstrapTrustClass,
} from './production-trust-class.js';
export {
  inspectExistingAdminAuthMaterial,
  preflightClaimExistingAdmin,
  assertClaimExistingAdminEligible,
  type ClaimExistingAdminPreflightResult,
  type ExistingAdminCredentialState,
  type ClaimExistingAdminAuthCounts,
} from './claim-existing-admin.js';
export {
  PRODUCTION_CEREMONY_PROFILE_NAME,
  PRODUCTION_CEREMONY_SEAL_NAME,
  PRODUCTION_CHANNEL_A_NAME,
  PRODUCTION_CHANNEL_B_NAME,
  PRODUCTION_PUBLIC_KEY_NAME,
  PRODUCTION_MANIFEST_NAME,
  PRODUCTION_TARGET_ADMIN_NAME,
  PRODUCTION_BUNDLE_NAME,
  WITNESS_MODEL,
  assertProductionProfileRequiresSystemIdentifier,
  assertProductionCeremonyAllowsEnrollment,
  validateProductionCeremonyBundleStructurally,
  authenticateProductionCeremonyFromOwnerTty,
  generateProductionBootstrapKeypairFiles,
  loadProductionPublicKey,
  writeProductionEndpointProfile,
  loadProductionEndpointProfile,
  writeIntendedExistingAdminBinding,
  loadIntendedExistingAdminBinding,
  loadProductionCeremonyBundle,
  draftProductionCeremonySeal,
  recordProductionChannelBDigest,
  missingProductionTrustResources,
  type ProductionCeremonyPublicKeyRecord,
  type ProductionIntendedExistingAdminBinding,
  type ProductionChannelBRecord,
} from './production-ceremony-gate.js';
export {
  digestProductionCeremonyBundleV1,
  validateProductionCeremonyBundleV1,
  type ProductionCeremonyBundleV1,
} from './production-ceremony-bundle-v1.js';
export {
  isAuthenticatedProductionBootstrapTrust,
  assertAuthenticatedProductionBootstrapTrust,
  type AuthenticatedProductionBootstrapTrust,
} from './authenticated-production-trust.js';
// mintAuthenticatedProductionBootstrapTrust is intentionally NOT exported (package-private).
export {
  OWNER_BOOTSTRAP_KEY_KDF,
  OWNER_BOOTSTRAP_KEY_AEAD,
  generateEncryptedProductionOwnerBootstrapKey,
  decryptOwnerBootstrapPrivateSeed,
  encryptOwnerBootstrapPrivateSeed,
  assertNoPlaintextOwnerBootstrapSeedFile,
  assertOwnerBootstrapCeremonyDirSafe,
  type OwnerBootstrapEncryptedKeyBundleV1,
} from './owner-bootstrap-encrypted-key.js';
export {
  startProductionOwnerBootstrapAttempt,
  submitProductionOwnerBootstrapPop,
  abortProductionOwnerBootstrapAttempt,
  completeProductionOwnerBootstrapEnrollment,
} from './production-lifecycle.js';
export {
  orchestrateProductionOwnerBootstrapCeremony,
  assertProductionCeremonyApplyGates,
  loadEncryptedOwnerBootstrapKeyBundle,
  type ProductionCeremonyOrchestratorInput,
  type ProductionCeremonyOrchestratorResult,
} from './production-ceremony-orchestrator.js';
export {
  preflightProductionOwnerBootstrapSchema,
  assertProductionOwnerBootstrapSchemaReady,
  REQUIRED_PRODUCTION_OWNER_BOOTSTRAP_MIGRATIONS,
  type ProductionOwnerBootstrapSchemaPreflightResult,
} from './production-schema-preflight.js';
export {
  buildProductionOwnerBootstrapReadinessReport,
  type ProductionOwnerBootstrapReadinessReport,
} from './production-owner-bootstrap-readiness.js';
export {
  resolvePublicProxyDialIps,
  discoverProductionTrustedEndpoint,
  runProductionOwnerBootstrapPreflightOnly,
  type ProductionTrustedEndpointDiscoveryInput,
  type ProductionTrustedEndpointDiscoveryResult,
  type ProductionOwnerBootstrapPreflightOnlyResult,
} from './production-preflight-only.js';
export {
  buildProductionOwnerBootstrapPoolConfig,
  createProductionOwnerBootstrapPool,
  assertProductionBootstrapTlsAndEndpoint,
} from './pool.js';
