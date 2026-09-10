import { timingSafeEqual } from 'node:crypto';

import { SignerError } from '@alex-rewards/signing';

export function assertBearerAuth(
  authorizationHeader: string | undefined,
  expectedToken: string,
): void {
  if (authorizationHeader === undefined || !authorizationHeader.startsWith('Bearer ')) {
    throw new SignerError('UNAUTHORIZED', 'Missing bearer token');
  }
  const provided = authorizationHeader.slice('Bearer '.length);
  const a = Buffer.from(provided);
  const b = Buffer.from(expectedToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new SignerError('UNAUTHORIZED', 'Invalid bearer token');
  }
}
