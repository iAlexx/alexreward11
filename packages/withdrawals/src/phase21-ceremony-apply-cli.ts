/**
 * Shared APPLY wiring for Phase 21 ops CLI.
 * PLAN may use DATABASE_URL (read-only). APPLY requires ceremony endpoint profile
 * + verified pool + Owner TTY auth — never DATABASE_URL alone.
 */
import { readFileSync } from 'node:fs';

import {
  bootstrapEndpointProfileFromCeremonyWire,
  loadProductionEndpointProfile,
  parseCeremonyEndpointProfileV1Json,
  type CeremonyEndpointProfileV1,
} from '@alex-rewards/auth';

import {
  authenticatePhase21OwnerCeremonyFromOwnerTty,
} from './phase21-owner-ceremony-auth.js';
import type { AuthenticatedPhase21OwnerCeremonyTrust } from './phase21-owner-ceremony-trust.js';
import {
  createPhase21CeremonyVerifiedPool,
  type Phase21CeremonyVerifiedPool,
} from './phase21-ceremony-verified-pool.js';

function envNonEmpty(name: string): string | null {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

function argValue(argv: readonly string[], name: string): string | null {
  const idx = argv.indexOf(name);
  if (idx < 0) return null;
  const value = argv[idx + 1];
  if (value === undefined || value.startsWith('--')) return null;
  return value;
}

export function loadPhase21ApplyEndpointProfile(argv: readonly string[]): CeremonyEndpointProfileV1 {
  const ceremonyDir =
    argValue(argv, '--ceremony-dir') ?? envNonEmpty('PHASE21_CEREMONY_DIR');
  const profileFile =
    argValue(argv, '--ceremony-endpoint-profile') ??
    envNonEmpty('PHASE21_CEREMONY_ENDPOINT_PROFILE_FILE');
  if (ceremonyDir !== null) {
    return loadProductionEndpointProfile(ceremonyDir);
  }
  if (profileFile !== null) {
    const text = readFileSync(profileFile, 'utf8');
    return parseCeremonyEndpointProfileV1Json(text);
  }
  throw new Error(
    'APPLY requires --ceremony-dir or PHASE21_CEREMONY_ENDPOINT_PROFILE_FILE (DATABASE_URL alone forbidden)',
  );
}

export function buildPhase21ApplyConnectionString(profile: CeremonyEndpointProfileV1): string {
  const explicit = envNonEmpty('PHASE21_CEREMONY_DATABASE_URL');
  if (explicit !== null) return explicit;

  const password =
    envNonEmpty('PHASE21_CEREMONY_DB_PASSWORD') ??
    envNonEmpty('OWNER_PRODUCTION_BOOTSTRAP_DB_PASSWORD');
  const host = envNonEmpty('PHASE21_CEREMONY_PROXY_HOST') ?? envNonEmpty('RAILWAY_TCP_PROXY_HOST');
  const port = envNonEmpty('PHASE21_CEREMONY_PROXY_PORT') ?? envNonEmpty('RAILWAY_TCP_PROXY_PORT');
  const user =
    envNonEmpty('PHASE21_CEREMONY_DB_USER') ??
    envNonEmpty('OWNER_PRODUCTION_BOOTSTRAP_DB_USER') ??
    'postgres';
  if (password === null || host === null || port === null) {
    throw new Error(
      'APPLY connection requires PHASE21_CEREMONY_DATABASE_URL or proxy host/port + PHASE21_CEREMONY_DB_PASSWORD (or OWNER_PRODUCTION_BOOTSTRAP_DB_PASSWORD); DATABASE_URL alone forbidden',
    );
  }
  const database = profile.expected_database_name;
  const encodedUser = encodeURIComponent(user);
  const encodedPass = encodeURIComponent(password);
  return `postgresql://${encodedUser}:${encodedPass}@${host}:${port}/${database}`;
}

export async function openPhase21ApplyVerifiedPool(argv: readonly string[]): Promise<{
  readonly verified: Phase21CeremonyVerifiedPool;
  readonly profile: CeremonyEndpointProfileV1;
  readonly trust: AuthenticatedPhase21OwnerCeremonyTrust;
}> {
  const profile = loadPhase21ApplyEndpointProfile(argv);
  const connectionString = buildPhase21ApplyConnectionString(profile);
  const verified = await createPhase21CeremonyVerifiedPool({ connectionString, profile });
  // Ensure env gates see the verified identities
  process.env.PHASE21_CEREMONY_REQUIRED_DATABASE_NAME = verified.databaseName;
  process.env.PHASE21_CEREMONY_REQUIRED_SYSTEM_IDENTIFIER = verified.systemIdentifier;

  const locator = envNonEmpty('PHASE21_CEREMONY_ADMIN_USER_ID');
  const trust = await authenticatePhase21OwnerCeremonyFromOwnerTty({
    pool: verified.pool,
    expectedDatabase: verified.databaseName,
    expectedClusterSystemIdentifier: verified.systemIdentifier,
    ...(locator !== null ? { expectedAdminUserId: locator } : {}),
  });

  // Touch wire helper so tree-shaking keeps the auth export used for APPLY profile mapping.
  void bootstrapEndpointProfileFromCeremonyWire;

  return { verified, profile, trust };
}
