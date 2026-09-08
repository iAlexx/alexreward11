export { AuthDomainError } from './errors.js';
export type { AuthErrorCode } from './errors.js';
export {
  generateClaimCode,
  generateOpaqueToken,
  hashClaimCode,
  hashIp,
  hashRefreshToken,
  hashSessionSecret,
  redactSensitive,
  sha256Hex,
  summarizeUserAgent,
} from './crypto.js';
export { issueAccessToken, verifyAccessToken, type AccessTokenClaims } from './access-token.js';
export {
  assertSessionActive,
  createUserSession,
  listActiveSessions,
  revokeAllUserSessions,
  revokeSession,
  rotateRefreshSession,
  type RequestMeta,
  type SessionConfig,
  type SessionRevocationReason,
  type SessionTokens,
} from './sessions.js';
export {
  authenticateWithTelegramInitData,
  type AuthenticatedUser,
  type PreferredLocale,
  type TelegramLoginResult,
} from './telegram-login.js';
export {
  claimFounderCode,
  getMembershipView,
  type FounderClaimResult,
  type MembershipView,
} from './membership.js';
export { consumeThrottle, type ThrottlePolicy } from './throttle.js';
