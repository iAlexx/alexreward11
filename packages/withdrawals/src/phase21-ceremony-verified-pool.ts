/**
 * Root-bound Phase 21 ceremony verified production pool (APPLY + canary PLAN).
 * Wraps @alex-rewards/auth createProductionOwnerBootstrapPool (verify_full TLS + identity).
 */
import { readFileSync } from 'node:fs';

import type { Pool } from 'pg';

import {
  bootstrapEndpointProfileFromCeremonyWire,
  createProductionOwnerBootstrapPool,
  loadProductionEndpointProfile,
  parseCeremonyEndpointProfileV1Json,
  validateCeremonyEndpointProfileV1,
  type CeremonyEndpointProfileV1,
} from '@alex-rewards/auth';

import type { AuthenticatedPhase21OwnerCeremonyTrust } from './phase21-owner-ceremony-trust.js';
import { Phase21OwnerCeremonyTrustError } from './phase21-owner-ceremony-trust.js';

export class Phase21CeremonyVerifiedPoolError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'Phase21CeremonyVerifiedPoolError';
    this.code = code;
    this.details = details;
  }
}

export type Phase21CeremonyVerifiedPool = {
  readonly brand: 'Phase21CeremonyVerifiedPool';
  readonly pool: Pool;
  readonly databaseName: string;
  readonly systemIdentifier: string;
  readonly tlsServerName: string;
  readonly sslInUse: true;
  readonly close: () => Promise<void>;
};

const verifiedPoolBrand = new WeakSet<object>();

export function isPhase21CeremonyVerifiedPool(value: unknown): value is Phase21CeremonyVerifiedPool {
  return typeof value === 'object' && value !== null && verifiedPoolBrand.has(value);
}

export function assertPhase21CeremonyVerifiedPool(
  value: unknown,
): asserts value is Phase21CeremonyVerifiedPool {
  if (!isPhase21CeremonyVerifiedPool(value)) {
    throw new Phase21CeremonyVerifiedPoolError(
      'CEREMONY_VERIFIED_POOL_REQUIRED',
      'Phase21CeremonyVerifiedPool required for APPLY (DATABASE_URL-alone forbidden)',
      {},
    );
  }
}

export function loadPhase21CeremonyEndpointProfile(input: {
  readonly ceremonyDir?: string | null;
  readonly profileFile?: string | null;
  readonly profileJson?: string | null;
}): CeremonyEndpointProfileV1 {
  if (input.profileJson !== undefined && input.profileJson !== null && input.profileJson.trim() !== '') {
    return validateCeremonyEndpointProfileV1(parseCeremonyEndpointProfileV1Json(input.profileJson));
  }
  if (input.ceremonyDir !== undefined && input.ceremonyDir !== null && input.ceremonyDir.trim() !== '') {
    return loadProductionEndpointProfile(input.ceremonyDir.trim());
  }
  if (input.profileFile !== undefined && input.profileFile !== null && input.profileFile.trim() !== '') {
    const text = readFileSync(input.profileFile.trim(), 'utf8');
    return validateCeremonyEndpointProfileV1(parseCeremonyEndpointProfileV1Json(text));
  }
  throw new Phase21CeremonyVerifiedPoolError(
    'CEREMONY_ENDPOINT_PROFILE_REQUIRED',
    'PHASE21_CEREMONY_ENDPOINT_PROFILE_FILE or --ceremony-dir required for APPLY verified pool',
    {},
  );
}

export async function createPhase21CeremonyVerifiedPool(input: {
  readonly connectionString: string;
  readonly profile: CeremonyEndpointProfileV1;
}): Promise<Phase21CeremonyVerifiedPool> {
  const bootstrapProfile = bootstrapEndpointProfileFromCeremonyWire(input.profile);
  if (
    bootstrapProfile.expectedSystemIdentifier === undefined ||
    bootstrapProfile.expectedSystemIdentifier === ''
  ) {
    throw new Phase21CeremonyVerifiedPoolError(
      'SYSTEM_IDENTIFIER_REQUIRED',
      'ceremony endpoint profile must include expected_system_identifier',
      {},
    );
  }
  if (bootstrapProfile.tls.mode !== 'verify_full') {
    throw new Phase21CeremonyVerifiedPoolError(
      'VERIFY_FULL_TLS_REQUIRED',
      'Phase 21 ceremony verified pool requires verify_full TLS',
      {},
    );
  }

  const bootstrap = await createProductionOwnerBootstrapPool({
    connectionString: input.connectionString,
    profile: bootstrapProfile,
  });

  if (bootstrap.connectionFacts.sslInUse !== true) {
    await bootstrap.pool.end().catch(() => undefined);
    throw new Phase21CeremonyVerifiedPoolError(
      'VERIFY_FULL_TLS_REQUIRED',
      'Phase 21 ceremony verified pool requires pg_stat_ssl.ssl=true',
      {},
    );
  }

  const obj: Phase21CeremonyVerifiedPool = {
    brand: 'Phase21CeremonyVerifiedPool',
    pool: bootstrap.pool,
    databaseName: bootstrap.connectionFacts.currentDatabase,
    systemIdentifier: bootstrap.connectionFacts.clusterSystemIdentifier,
    tlsServerName: bootstrapProfile.tls.tlsServerName,
    sslInUse: true,
    close: async () => {
      await bootstrap.pool.end();
    },
  };
  verifiedPoolBrand.add(obj);
  return obj;
}

export interface Phase21OwnerTrustLiveConnectionClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
}

/**
 * Ensure branded Owner trust was minted against the live connection identity.
 */
export async function assertOwnerTrustMatchesLiveConnection(
  client: Phase21OwnerTrustLiveConnectionClient,
  trust: AuthenticatedPhase21OwnerCeremonyTrust,
): Promise<void> {
  const db = await client.query<{ name: string }>(`SELECT current_database() AS name`);
  const currentDatabase = db.rows[0]?.name ?? '';
  const sid = await client.query<{ sid: string }>(
    `SELECT system_identifier::text AS sid FROM pg_control_system()`,
  );
  const systemIdentifier = sid.rows[0]?.sid ?? '';
  if (currentDatabase !== trust.currentDatabase) {
    throw new Phase21OwnerCeremonyTrustError(
      'OWNER_TRUST_DATABASE_MISMATCH',
      'Owner ceremony trust currentDatabase does not match live connection',
      { trustDatabase: trust.currentDatabase, currentDatabase },
    );
  }
  if (systemIdentifier !== trust.systemIdentifier) {
    throw new Phase21OwnerCeremonyTrustError(
      'OWNER_TRUST_SYSTEM_IDENTIFIER_MISMATCH',
      'Owner ceremony trust systemIdentifier does not match live connection',
      { trustSystemIdentifier: trust.systemIdentifier, systemIdentifier },
    );
  }
}

/**
 * Test-only branding for Phase21CeremonyVerifiedPool.
 * Requires ALEX_PHASE21_CEREMONY_TEST_HOOKS=1.
 */
export function __brandPhase21CeremonyVerifiedPoolForTests(
  value: Phase21CeremonyVerifiedPool,
): Phase21CeremonyVerifiedPool {
  if (process.env.ALEX_PHASE21_CEREMONY_TEST_HOOKS !== '1') {
    throw new Phase21CeremonyVerifiedPoolError(
      'TEST_HOOKS_REQUIRED',
      '__brandPhase21CeremonyVerifiedPoolForTests requires ALEX_PHASE21_CEREMONY_TEST_HOOKS=1',
      {},
    );
  }
  verifiedPoolBrand.add(value);
  return value;
}

