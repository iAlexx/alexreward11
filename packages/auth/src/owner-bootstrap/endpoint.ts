/**
 * Bootstrap endpoint trust profile types (M1-A.1 P2).
 * Pool construction / live TLS binding: see pool.ts.
 */
import type { DeploymentEnv } from './grant.js';

export type BootstrapTlsMode =
  | {
      readonly mode: 'verify_full';
      readonly caPem: string;
      readonly tlsServerName: string;
      /** Forbidden in v1 (G5=NO). If present, pool/TLS builders refuse — never strip. */
      readonly spkiSha256Hex?: string;
    }
  | {
      /** Stage B local harness only — never production/staging. */
      readonly mode: 'isolated_test_loopback_plaintext';
    };

export interface BootstrapEndpointProfile {
  readonly profileId: string;
  readonly deploymentEnv: DeploymentEnv;
  readonly expectedDatabaseName: string;
  readonly expectedSystemIdentifier?: string;
  readonly tls: BootstrapTlsMode;
}

export function buildIsolatedTestEndpointProfile(input: {
  readonly profileId: string;
  readonly expectedDatabaseName: string;
  readonly expectedSystemIdentifier?: string;
}): BootstrapEndpointProfile {
  const profile: BootstrapEndpointProfile = {
    profileId: input.profileId,
    deploymentEnv: 'isolated_test',
    expectedDatabaseName: input.expectedDatabaseName,
    tls: { mode: 'isolated_test_loopback_plaintext' },
  };
  if (input.expectedSystemIdentifier !== undefined && input.expectedSystemIdentifier !== '') {
    return {
      ...profile,
      expectedSystemIdentifier: input.expectedSystemIdentifier,
    };
  }
  return profile;
}
