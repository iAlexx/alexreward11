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
