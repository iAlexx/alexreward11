/**
 * M1 Option C — ceremony endpoint profile wire schema v1 + JCS_SHA256_V1 digest.
 *
 * PROPOSED design (G2 decision record). Not Owner-approved. Not wired to ops
 * trust install, redeem, or default-deny lift.
 */
import { createHash } from 'node:crypto';

import { AuthDomainError } from '../errors.js';
import type { BootstrapEndpointProfile } from './endpoint.js';
import { canonicalizeToJcs } from './jcs.js';
import { parseStrictJson } from './strict-json.js';

export const CEREMONY_ENDPOINT_PROFILE_DIGEST_METHOD = 'JCS_SHA256_V1' as const;

const PROFILE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export type CeremonyDeploymentEnvV1 = 'production' | 'staging';

export interface CeremonyEndpointProfileTlsV1 {
  readonly mode: 'verify_full';
  readonly ca_pem: string;
  readonly tls_server_name: string;
}

export interface CeremonyEndpointProfileV1 {
  readonly v: 1;
  readonly profile_id: string;
  readonly deployment_env: CeremonyDeploymentEnvV1;
  readonly expected_database_name: string;
  readonly expected_system_identifier?: string;
  readonly tls: CeremonyEndpointProfileTlsV1;
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new AuthDomainError('VALIDATION', `ceremony profile field ${field} invalid`);
  }
  return value;
}

function assertExactKeysAllowOptional(
  obj: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new AuthDomainError('VALIDATION', `unexpected ${label} field: ${key}`);
    }
  }
  for (const need of required) {
    if (!Object.hasOwn(obj, need)) {
      throw new AuthDomainError('VALIDATION', `missing ${label} field: ${need}`);
    }
  }
}

function validateTls(raw: unknown): CeremonyEndpointProfileTlsV1 {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AuthDomainError('VALIDATION', 'ceremony profile field tls must be object');
  }
  const obj = raw as Record<string, unknown>;
  // G5 = NO: refuse SPKI before schema allow-list (do not silently strip).
  if (Object.hasOwn(obj, 'spki_sha256_hex') || Object.hasOwn(obj, 'spkiSha256Hex')) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'G5 Owner decision: SPKI pinning unsupported in v1; refuse explicitly supplied spki_sha256_hex (must not ignore, strip, or downgrade)',
    );
  }
  assertExactKeysAllowOptional(
    obj,
    ['mode', 'ca_pem', 'tls_server_name'],
    [],
    'tls',
  );

  const mode = assertString(obj.mode, 'tls.mode');
  if (mode !== 'verify_full') {
    throw new AuthDomainError(
      'VALIDATION',
      'ceremony profile tls.mode must be verify_full (isolated_test not in v1)',
    );
  }
  const caPem = assertString(obj.ca_pem, 'tls.ca_pem');
  const tlsServerName = assertString(obj.tls_server_name, 'tls.tls_server_name');

  return {
    mode: 'verify_full',
    ca_pem: caPem,
    tls_server_name: tlsServerName,
  };
}

/**
 * Strict validate a ceremony endpoint profile v1 object.
 * Does not repair or normalize invalid inputs.
 */
export function validateCeremonyEndpointProfileV1(raw: unknown): CeremonyEndpointProfileV1 {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AuthDomainError('VALIDATION', 'ceremony profile must be object');
  }
  const obj = raw as Record<string, unknown>;
  assertExactKeysAllowOptional(
    obj,
    ['v', 'profile_id', 'deployment_env', 'expected_database_name', 'tls'],
    ['expected_system_identifier'],
    'ceremony profile',
  );

  if (typeof obj.v !== 'number' || !Number.isInteger(obj.v) || obj.v !== 1) {
    throw new AuthDomainError('VALIDATION', 'ceremony profile v must be integer 1');
  }

  const profileId = assertString(obj.profile_id, 'profile_id');
  if (!PROFILE_ID_RE.test(profileId)) {
    throw new AuthDomainError('VALIDATION', 'ceremony profile profile_id format invalid');
  }

  const deploymentEnv = assertString(obj.deployment_env, 'deployment_env');
  if (deploymentEnv !== 'production' && deploymentEnv !== 'staging') {
    throw new AuthDomainError(
      'VALIDATION',
      'ceremony profile deployment_env must be production or staging',
    );
  }

  const expectedDatabaseName = assertString(obj.expected_database_name, 'expected_database_name');

  const profile: CeremonyEndpointProfileV1 = {
    v: 1,
    profile_id: profileId,
    deployment_env: deploymentEnv,
    expected_database_name: expectedDatabaseName,
    tls: validateTls(obj.tls),
  };

  if (Object.hasOwn(obj, 'expected_system_identifier')) {
    const sid = assertString(obj.expected_system_identifier, 'expected_system_identifier');
    return { ...profile, expected_system_identifier: sid };
  }
  return profile;
}

/**
 * Parse JSON text with duplicate-key rejection, then strict-validate.
 */
export function parseCeremonyEndpointProfileV1Json(text: string): CeremonyEndpointProfileV1 {
  return validateCeremonyEndpointProfileV1(parseStrictJson(text));
}

/**
 * JCS_SHA256_V1: validate → RFC 8785 JCS UTF-8 → SHA-256 → lowercase hex.
 */
export function digestCeremonyEndpointProfileV1(
  raw: CeremonyEndpointProfileV1 | unknown,
): string {
  const profile = validateCeremonyEndpointProfileV1(raw);
  const jcs = canonicalizeToJcs(profile);
  return createHash('sha256').update(Buffer.from(jcs, 'utf8')).digest('hex');
}

/**
 * Map camelCase runtime profile → snake_case ceremony wire.
 * Rejects isolated_test / non-verify_full / empty optional strings.
 */
export function ceremonyWireFromBootstrapEndpointProfile(
  profile: BootstrapEndpointProfile,
): CeremonyEndpointProfileV1 {
  if (profile.deploymentEnv !== 'production' && profile.deploymentEnv !== 'staging') {
    throw new AuthDomainError(
      'VALIDATION',
      'ceremony wire adapter rejects deploymentEnv outside production|staging',
    );
  }
  if (profile.tls.mode !== 'verify_full') {
    throw new AuthDomainError(
      'VALIDATION',
      'ceremony wire adapter rejects tls.mode other than verify_full',
    );
  }
  if (profile.profileId.trim() === '' || !PROFILE_ID_RE.test(profile.profileId)) {
    throw new AuthDomainError('VALIDATION', 'ceremony wire adapter: profileId invalid');
  }
  if (profile.expectedDatabaseName === '') {
    throw new AuthDomainError('VALIDATION', 'ceremony wire adapter: expectedDatabaseName empty');
  }
  if (profile.tls.caPem === '') {
    throw new AuthDomainError('VALIDATION', 'ceremony wire adapter: caPem empty');
  }
  if (profile.tls.tlsServerName === '') {
    throw new AuthDomainError('VALIDATION', 'ceremony wire adapter: tlsServerName empty');
  }
  if (
    profile.expectedSystemIdentifier !== undefined &&
    profile.expectedSystemIdentifier === ''
  ) {
    throw new AuthDomainError(
      'VALIDATION',
      'ceremony wire adapter: empty expectedSystemIdentifier is ambiguous (omit property)',
    );
  }
  if (profile.tls.mode === 'verify_full' && profile.tls.spkiSha256Hex !== undefined) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'G5 Owner decision: SPKI pinning unsupported in v1; refuse explicitly supplied spkiSha256Hex (must not ignore, strip, or downgrade)',
    );
  }

  const wire: CeremonyEndpointProfileV1 = {
    v: 1,
    profile_id: profile.profileId,
    deployment_env: profile.deploymentEnv,
    expected_database_name: profile.expectedDatabaseName,
    tls: {
      mode: 'verify_full',
      ca_pem: profile.tls.caPem,
      tls_server_name: profile.tls.tlsServerName,
    },
  };
  if (profile.expectedSystemIdentifier !== undefined) {
    return {
      ...wire,
      expected_system_identifier: profile.expectedSystemIdentifier,
    };
  }
  return validateCeremonyEndpointProfileV1(wire);
}

/**
 * Map snake_case ceremony wire → camelCase runtime profile.
 */
export function bootstrapEndpointProfileFromCeremonyWire(
  wire: CeremonyEndpointProfileV1,
): BootstrapEndpointProfile {
  const validated = validateCeremonyEndpointProfileV1(wire);
  const profile: BootstrapEndpointProfile = {
    profileId: validated.profile_id,
    deploymentEnv: validated.deployment_env,
    expectedDatabaseName: validated.expected_database_name,
    tls: {
      mode: 'verify_full',
      caPem: validated.tls.ca_pem,
      tlsServerName: validated.tls.tls_server_name,
    },
  };
  if (validated.expected_system_identifier !== undefined) {
    return {
      ...profile,
      expectedSystemIdentifier: validated.expected_system_identifier,
    };
  }
  return profile;
}
