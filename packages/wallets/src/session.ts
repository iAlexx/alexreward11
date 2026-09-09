import { AuthDomainError, assertSessionActive, verifyAccessToken } from '@alex-rewards/auth';
import type { Pool } from 'pg';

import { WalletDomainError } from './errors.js';

/**
 * Resolve the authoritative authenticated user from a Phase 3 access token + active session.
 * Never accept userId from the client as wallet ownership authority.
 */
export async function requireAuthenticatedUserId(
  pool: Pool,
  accessToken: string,
  accessTokenSecret: string,
): Promise<{ readonly userId: string; readonly sessionId: string }> {
  if (accessTokenSecret.trim() === '') {
    throw new WalletDomainError('CONFIG', 'accessTokenSecret is required');
  }
  try {
    const claims = verifyAccessToken(accessToken, accessTokenSecret);
    await assertSessionActive(pool, claims.sid, claims.sub);
    return { userId: claims.sub, sessionId: claims.sid };
  } catch (error) {
    if (error instanceof AuthDomainError) {
      throw new WalletDomainError('UNAUTHORIZED', 'Authentication required', { cause: error });
    }
    throw new WalletDomainError('UNAUTHORIZED', 'Authentication required', { cause: error });
  }
}
