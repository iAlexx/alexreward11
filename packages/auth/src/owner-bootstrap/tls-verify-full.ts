/**
 * G5 = NO (Owner-approved): SPKI pinning unsupported in v1.
 * verify_full TLS options for node-postgres / Node tls — CA + hostname, no SPKI.
 *
 * node-postgres passes `ssl` as Node.js tls.ConnectionOptions (not libpq sslmode).
 * With rejectUnauthorized:true, Node uses `servername` for SNI and default
 * tls.checkServerIdentity hostname verification against the peer certificate.
 * Setting servername alone without rejectUnauthorized:true is NOT sufficient.
 *
 * CV-01: pg@8.23 `Connection.upgradeToSSL` does `Object.assign(options, ssl)` then, when the
 * TCP host is not an IP, **overwrites** `options.servername` with the URL host. Identity
 * checks must therefore pin the Owner-approved profile hostname via checkServerIdentity
 * (and pool construction refuses non-IP URL hosts that differ from tls_server_name).
 */
import tls, { type ConnectionOptions, type PeerCertificate } from 'node:tls';

import { AuthDomainError } from '../errors.js';

export const G5_SPKI_V1_DECISION = 'NO' as const;

export function assertSpkiPinningUnsupportedForV1(
  spkiSha256Hex: string | undefined | null,
  fieldLabel = 'spki',
): void {
  if (spkiSha256Hex !== undefined && spkiSha256Hex !== null) {
    throw new AuthDomainError(
      'FORBIDDEN',
      `G5 Owner decision: SPKI pinning unsupported in v1; refuse explicitly supplied ${fieldLabel} (must not ignore, strip, or downgrade)`,
    );
  }
}

/**
 * Build Node TLS options equivalent to verify-full intent for Owner bootstrap.
 * Fail-closed: empty CA / empty servername / any SPKI → refuse.
 */
export function buildVerifyFullTlsSocketOptions(input: {
  readonly caPem: string;
  readonly tlsServerName: string;
  readonly spkiSha256Hex?: string;
}): ConnectionOptions {
  assertSpkiPinningUnsupportedForV1(input.spkiSha256Hex, 'spkiSha256Hex / spki_sha256_hex');
  if (typeof input.caPem !== 'string' || input.caPem.trim() === '') {
    throw new AuthDomainError('FORBIDDEN', 'Owner CA trust anchor missing; fail closed');
  }
  if (typeof input.tlsServerName !== 'string' || input.tlsServerName.trim() === '') {
    throw new AuthDomainError('FORBIDDEN', 'tls_server_name required; fail closed');
  }
  const approvedHostname = input.tlsServerName.trim();
  return {
    rejectUnauthorized: true,
    ca: input.caPem,
    servername: approvedHostname,
    checkServerIdentity: (_overwrittenHostname: string, cert: PeerCertificate): Error | undefined => {
      // Ignore hostname argument — pg may have replaced servername with the URL host.
      return tls.checkServerIdentity(approvedHostname, cert);
    },
  };
}
