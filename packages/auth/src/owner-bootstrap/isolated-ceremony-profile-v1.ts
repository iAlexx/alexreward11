/**
 * Isolated-test Option C ceremony endpoint profile (Stage B / ephemeral trust only).
 *
 * Distinct from G2 CeremonyEndpointProfileV1 (production|staging + verify_full).
 * Digest method remains JCS_SHA256_V1. Never use for operational trust.
 */
import { createHash } from 'node:crypto';

import { AuthDomainError } from '../errors.js';
import { CEREMONY_ENDPOINT_PROFILE_DIGEST_METHOD } from './ceremony-profile-v1.js';
import type { BootstrapEndpointProfile } from './endpoint.js';
import { canonicalizeToJcs } from './jcs.js';
import { parseStrictJson } from './strict-json.js';

const PROFILE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export const ISOLATED_OWNER_CEREMONY_TARGET = {
  databaseName: 'alex_rewards_isolated_payout_test',
  host: '127.0.0.1',
  port: 55440,
  expectedMigrationHeadPrefix: '0029',
  trustClass: 'ephemeral_isolated_test_only',
  profileId: 'isolated-payout-test-owner-ceremony-v1',
} as const;

export type IsolatedCeremonyEndpointProfileV1 = {
  readonly v: 1;
  readonly profile_id: string;
  readonly deployment_env: 'isolated_test';
  readonly expected_database_name: string;
  readonly expected_host: '127.0.0.1';
  readonly expected_port: number;
  readonly tls: { readonly mode: 'isolated_test_loopback_plaintext' };
  readonly trust_class: 'ephemeral_isolated_test_only';
  readonly expected_system_identifier?: string;
};

function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new AuthDomainError('VALIDATION', `isolated ceremony profile field ${field} invalid`);
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

export function validateIsolatedCeremonyEndpointProfileV1(
  raw: unknown,
): IsolatedCeremonyEndpointProfileV1 {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AuthDomainError('VALIDATION', 'isolated ceremony profile must be object');
  }
  const obj = raw as Record<string, unknown>;
  assertExactKeysAllowOptional(
    obj,
    [
      'v',
      'profile_id',
      'deployment_env',
      'expected_database_name',
      'expected_host',
      'expected_port',
      'tls',
      'trust_class',
    ],
    ['expected_system_identifier'],
    'isolated ceremony profile',
  );

  if (typeof obj.v !== 'number' || !Number.isInteger(obj.v) || obj.v !== 1) {
    throw new AuthDomainError('VALIDATION', 'isolated ceremony profile v must be integer 1');
  }

  const profileId = assertString(obj.profile_id, 'profile_id');
  if (!PROFILE_ID_RE.test(profileId)) {
    throw new AuthDomainError('VALIDATION', 'isolated ceremony profile profile_id format invalid');
  }

  if (obj.deployment_env !== 'isolated_test') {
    throw new AuthDomainError(
      'VALIDATION',
      'isolated ceremony profile deployment_env must be isolated_test',
    );
  }

  const expectedDatabaseName = assertString(
    obj.expected_database_name,
    'expected_database_name',
  );
  if (expectedDatabaseName === 'alex_rewards') {
    throw new AuthDomainError(
      'FORBIDDEN',
      'isolated ceremony profile refuses operational alex_rewards',
    );
  }

  if (obj.expected_host !== '127.0.0.1') {
    throw new AuthDomainError(
      'VALIDATION',
      'isolated ceremony profile expected_host must be 127.0.0.1',
    );
  }

  if (
    typeof obj.expected_port !== 'number' ||
    !Number.isInteger(obj.expected_port) ||
    obj.expected_port <= 0 ||
    obj.expected_port > 65535
  ) {
    throw new AuthDomainError(
      'VALIDATION',
      'isolated ceremony profile expected_port must be integer 1..65535',
    );
  }
  if (obj.expected_port === 55432) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'isolated ceremony profile refuses operational port 55432',
    );
  }

  if (obj.trust_class !== 'ephemeral_isolated_test_only') {
    throw new AuthDomainError(
      'VALIDATION',
      'isolated ceremony profile trust_class must be ephemeral_isolated_test_only',
    );
  }

  if (obj.tls === null || typeof obj.tls !== 'object' || Array.isArray(obj.tls)) {
    throw new AuthDomainError('VALIDATION', 'isolated ceremony profile tls must be object');
  }
  const tls = obj.tls as Record<string, unknown>;
  assertExactKeysAllowOptional(tls, ['mode'], [], 'tls');
  if (tls.mode !== 'isolated_test_loopback_plaintext') {
    throw new AuthDomainError(
      'VALIDATION',
      'isolated ceremony profile tls.mode must be isolated_test_loopback_plaintext',
    );
  }

  const profile: IsolatedCeremonyEndpointProfileV1 = {
    v: 1,
    profile_id: profileId,
    deployment_env: 'isolated_test',
    expected_database_name: expectedDatabaseName,
    expected_host: '127.0.0.1',
    expected_port: obj.expected_port,
    tls: { mode: 'isolated_test_loopback_plaintext' },
    trust_class: 'ephemeral_isolated_test_only',
  };
  if (Object.hasOwn(obj, 'expected_system_identifier')) {
    const sid = assertString(obj.expected_system_identifier, 'expected_system_identifier');
    return { ...profile, expected_system_identifier: sid };
  }
  return profile;
}

export function parseIsolatedCeremonyEndpointProfileV1Json(
  text: string,
): IsolatedCeremonyEndpointProfileV1 {
  return validateIsolatedCeremonyEndpointProfileV1(parseStrictJson(text));
}

export function digestIsolatedCeremonyEndpointProfileV1(
  raw: IsolatedCeremonyEndpointProfileV1 | unknown,
): string {
  const profile = validateIsolatedCeremonyEndpointProfileV1(raw);
  const jcs = canonicalizeToJcs(profile);
  return createHash('sha256').update(Buffer.from(jcs, 'utf8')).digest('hex');
}

export function buildIsolatedCeremonyEndpointProfileV1(input: {
  readonly profileId: string;
  readonly expectedDatabaseName: string;
  readonly expectedPort: number;
  readonly expectedSystemIdentifier?: string;
}): IsolatedCeremonyEndpointProfileV1 {
  const wire: IsolatedCeremonyEndpointProfileV1 = {
    v: 1,
    profile_id: input.profileId,
    deployment_env: 'isolated_test',
    expected_database_name: input.expectedDatabaseName,
    expected_host: '127.0.0.1',
    expected_port: input.expectedPort,
    tls: { mode: 'isolated_test_loopback_plaintext' },
    trust_class: 'ephemeral_isolated_test_only',
    ...(input.expectedSystemIdentifier !== undefined
      ? { expected_system_identifier: input.expectedSystemIdentifier }
      : {}),
  };
  return validateIsolatedCeremonyEndpointProfileV1(wire);
}

export function bootstrapEndpointProfileFromIsolatedCeremonyWire(
  wire: IsolatedCeremonyEndpointProfileV1 | unknown,
): BootstrapEndpointProfile {
  const validated = validateIsolatedCeremonyEndpointProfileV1(wire);
  const profile: BootstrapEndpointProfile = {
    profileId: validated.profile_id,
    deploymentEnv: 'isolated_test',
    expectedDatabaseName: validated.expected_database_name,
    tls: { mode: 'isolated_test_loopback_plaintext' },
  };
  if (validated.expected_system_identifier !== undefined) {
    return {
      ...profile,
      expectedSystemIdentifier: validated.expected_system_identifier,
    };
  }
  return profile;
}

export function assertIsolatedSealProfileDigestMatches(
  sealProfileId: string,
  sealProfileDigestHex: string,
  profile: IsolatedCeremonyEndpointProfileV1 | unknown,
): void {
  const validated = validateIsolatedCeremonyEndpointProfileV1(profile);
  if (sealProfileId !== validated.profile_id) {
    throw new AuthDomainError(
      'VALIDATION',
      'ceremony seal endpoint_profile_id does not match isolated profile.profile_id',
    );
  }
  const digest = digestIsolatedCeremonyEndpointProfileV1(validated);
  if (sealProfileDigestHex !== digest) {
    throw new AuthDomainError(
      'VALIDATION',
      'ceremony seal profile_digest_hex does not match JCS_SHA256_V1(isolated profile)',
    );
  }
  if (sealProfileDigestHex.length !== 64) {
    throw new AuthDomainError('VALIDATION', 'profile digest length invalid');
  }
  void CEREMONY_ENDPOINT_PROFILE_DIGEST_METHOD;
}
