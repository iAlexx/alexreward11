/**
 * Privacy-safe selected-user references for restore-drill reports.
 * Raw UUIDs may exist only in process memory / SQL binds — never in serialized output.
 */
import { createHash } from 'node:crypto';

const SELECTED_USER_DOMAIN = 'phase18-selected-user-v1';
const OPAQUE_DOMAIN_PREFIX = 'phase18-opaque-ref-v1';

/**
 * Deterministic domain-separated SHA-256 of a canonical lowercase UUID.
 * SHA256(UTF8("phase18-selected-user-v1\0" + lowercaseCanonicalUuid))
 */
export function hashSelectedUserReference(userId: string): string {
  const canonical = userId.trim().toLowerCase();
  return createHash('sha256')
    .update(`${SELECTED_USER_DOMAIN}\0${canonical}`, 'utf8')
    .digest('hex');
}

/** Hash opaque identifiers (workflow IDs, withdrawal IDs) for mismatch evidence. */
export function hashOpaqueReference(kind: string, value: string): string {
  const k = kind.trim().toLowerCase();
  const v = value.trim().toLowerCase();
  return createHash('sha256')
    .update(`${OPAQUE_DOMAIN_PREFIX}\0${k}\0${v}`, 'utf8')
    .digest('hex');
}