export { TonDomainError } from './errors.js';
export type { TonErrorCode } from './errors.js';
export {
  canonicalizeTonAddress,
  parseTonConnectAccountAddress,
  type CanonicalTonAddress,
} from './address.js';
export {
  TON_CONNECT_PREFIX,
  TON_PROOF_ITEM_PREFIX,
  buildTonProofMessage,
  buildTonProofSigningDigest,
  type TonProofMessageParts,
} from './proof-message.js';
export {
  assertStateInitMatchesAddress,
  extractPublicKeyFromStateInit,
  parseStateInitFromBase64,
} from './state-init.js';
export {
  tonConnectNetworkFromGlobalChainIdentifier,
  verifyTonProof,
  type TonConnectAccount,
  type TonConnectNetworkId,
  type TonProofDomain,
  type TonProofObject,
  type VerifiedTonProof,
  type VerifyTonProofInput,
} from './verify-proof.js';
