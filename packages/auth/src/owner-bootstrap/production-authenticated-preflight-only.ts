/**
 * Phase 21 Step 4B.1 - AUTHENTICATED read-only production Owner-bootstrap preflight.
 *
 * Authority comes ONLY from the runtime-branded AuthenticatedProductionBootstrapTrust
 * (live Owner TTY digest authentication) bound to the verified pool of the same session.
 * No intended-admin override parameters. Never INSERT/UPDATE/DELETE. Never calls the orchestrator.
 */
import type { Pool } from 'pg';

import { AuthDomainError } from '../errors.js';
import {
  assertAuthenticatedProductionBootstrapTrust,
  isProductionBoundBootstrapTrustMaterial,
  type AuthenticatedProductionBootstrapTrust,
} from './authenticated-production-trust.js';
import { assertPoolBoundBootstrapTrust } from './pool.js';
import { digestProductionCeremonyBundleV1 } from './production-ceremony-bundle-v1.js';
import {
  evaluateProductionOwnerBootstrapReadOnlyState,
  type ProductionOwnerBootstrapPreflightOnlyResult,
} from './production-preflight-only.js';

function assertTrustSelfConsistent(trust: AuthenticatedProductionBootstrapTrust): void {
  const b = trust.bundle;
  if (
    trust.intendedAdminUserId !== b.intended_admin_user_id ||
    trust.intendedAdminEmail !== b.intended_admin_email ||
    trust.keyId !== b.bootstrap_key_id ||
    trust.endpointProfileId !== b.endpoint_profile_id ||
    trust.bundleDigestHex !== digestProductionCeremonyBundleV1(b)
  ) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'authenticated trust fields do not match its root-bound bundle (tampered)',
    );
  }
}

export async function runAuthenticatedProductionOwnerBootstrapPreflightOnly(input: {
  readonly productionTrust: AuthenticatedProductionBootstrapTrust;
  /** Verified production pool from the same authentication session. */
  readonly pool: Pool;
  /** Defaults to false. Never derived from env. */
  readonly ownerKeyOfflineBackupsReady?: boolean;
  /**
   * Step 4B.2: the gated --apply command re-runs this same read-only evaluation as its
   * pre-mutation gate while OWNER_PRODUCTION_BOOTSTRAP_APPLY=1. Only skips the env hygiene
   * refusal; the evaluation is still BEGIN READ ONLY + ROLLBACK and never mutates.
   */
  readonly permitApplyEnvironment?: boolean;
}): Promise<ProductionOwnerBootstrapPreflightOnlyResult> {
  if (
    process.env.OWNER_PRODUCTION_BOOTSTRAP_APPLY === '1' &&
    input.permitApplyEnvironment !== true
  ) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'OWNER_PRODUCTION_BOOTSTRAP_APPLY is enabled - authenticated preflight is read-only',
    );
  }
  assertAuthenticatedProductionBootstrapTrust(input.productionTrust);
  const productionTrust = input.productionTrust;
  assertTrustSelfConsistent(productionTrust);

  const material = productionTrust.trust;
  if (!isProductionBoundBootstrapTrustMaterial(material)) {
    throw new AuthDomainError('FORBIDDEN', 'trust material is not production-bound');
  }
  assertPoolBoundBootstrapTrust(input.pool, material);

  const profile = material.endpointProfile;
  const facts = material.connectionFacts;
  if (profile.deploymentEnv !== 'production') {
    throw new AuthDomainError('FORBIDDEN', 'authenticated preflight requires production profile');
  }
  if (profile.profileId !== productionTrust.endpointProfileId) {
    throw new AuthDomainError('FORBIDDEN', 'pool endpoint profile != authenticated bundle profile');
  }
  if (facts.currentDatabase !== profile.expectedDatabaseName) {
    throw new AuthDomainError('FORBIDDEN', 'pool database != profile expected database');
  }
  if (
    profile.expectedSystemIdentifier === undefined ||
    profile.expectedSystemIdentifier === '' ||
    profile.expectedSystemIdentifier !== facts.clusterSystemIdentifier
  ) {
    throw new AuthDomainError('FORBIDDEN', 'pool system_identifier != profile expected system_identifier');
  }

  const notes: string[] = [
    'authenticated preflight is read-only (BEGIN READ ONLY + ROLLBACK)',
    'OPERATIONAL_DB_MUTATION=NO',
    'trust authority: live Owner TTY digest (branded AuthenticatedProductionBootstrapTrust)',
  ];
  const ownerKeyBackupsReady = input.ownerKeyOfflineBackupsReady === true;

  const client = await input.pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    try {
      const ro = await client.query<{ transaction_read_only: string }>(`SHOW transaction_read_only`);
      if (ro.rows[0]?.transaction_read_only !== 'on') {
        throw new AuthDomainError('FORBIDDEN', 'transaction_read_only is not on - refuse');
      }
      const live = await client.query<{
        current_database: string;
        system_identifier: string;
      }>(
        `SELECT current_database() AS current_database,
                (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier`,
      );
      const liveRow = live.rows[0];
      if (
        liveRow === undefined ||
        liveRow.current_database !== facts.currentDatabase ||
        liveRow.system_identifier !== facts.clusterSystemIdentifier
      ) {
        throw new AuthDomainError(
          'FORBIDDEN',
          'live database / system_identifier != trust connection facts',
        );
      }
      const ssl = await client.query<{ ssl: boolean | null }>(
        `SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()`,
      );
      const sslInUse = ssl.rows[0]?.ssl === true;
      if (sslInUse !== facts.sslInUse) {
        throw new AuthDomainError('FORBIDDEN', 'live TLS state != trust connection facts');
      }
      if (profile.tls.mode === 'verify_full' && !sslInUse) {
        throw new AuthDomainError('FORBIDDEN', 'verify_full production profile requires TLS');
      }

      const evaluated = await evaluateProductionOwnerBootstrapReadOnlyState(client, {
        intendedAdminUserId: productionTrust.intendedAdminUserId,
        intendedAdminEmail: productionTrust.intendedAdminEmail,
        trustAuthenticated: true,
        ownerKeyBackupsReady,
        authenticatedBinding: {
          bundleDigestHex: productionTrust.bundleDigestHex,
          keyId: productionTrust.keyId,
          endpointProfileId: productionTrust.endpointProfileId,
        },
        endpoint: {
          dialIp: facts.hostname,
          tlsServerName: profile.tls.mode === 'verify_full' ? profile.tls.tlsServerName : null,
          databaseName: liveRow.current_database,
          systemIdentifier: liveRow.system_identifier,
        },
        notes,
      });
      return evaluated;
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
    }
  } finally {
    client.release();
  }
}
