import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  E2E_ADMIN_BASE_URL,
  E2E_ADMIN_PORT,
  E2E_API_BASE_URL,
  E2E_API_PORT,
  E2E_OWNER_EMAIL,
} from '../env.js';

export type Phase13AdminE2ePublicSeed = {
  readonly email: string;
  readonly adminUserId: string;
  readonly apiBaseUrl: string;
  readonly adminBaseUrl: string;
  readonly apiPort: number;
  readonly adminPort: number;
};

/**
 * Secrets stay off stdout/logs — only written to a temp file for Playwright workers.
 * NEVER include session tokens (cookie-only auth; tests must not plant bearer tokens).
 */
export type Phase13AdminE2eSecrets = {
  readonly password: string;
  /** Base64 of TOTP secret bytes for generateTotpCode. */
  readonly totpSecretBase64: string;
};

function publicSeedPath(): string {
  return join(tmpdir(), 'alex-rewards-phase13-admin-e2e', 'public-seed.json');
}

function secretsPath(): string {
  return join(tmpdir(), 'alex-rewards-phase13-admin-e2e', 'secrets.json');
}

export function writePublicSeed(seed: Phase13AdminE2ePublicSeed): void {
  const path = publicSeedPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(seed, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function readPublicSeed(): Phase13AdminE2ePublicSeed {
  return JSON.parse(readFileSync(publicSeedPath(), 'utf8')) as Phase13AdminE2ePublicSeed;
}

export function writeSecrets(secrets: Phase13AdminE2eSecrets): void {
  const path = secretsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(secrets)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function readSecrets(): Phase13AdminE2eSecrets {
  return JSON.parse(readFileSync(secretsPath(), 'utf8')) as Phase13AdminE2eSecrets;
}

export function defaultPublicSeed(adminUserId: string): Phase13AdminE2ePublicSeed {
  return {
    email: E2E_OWNER_EMAIL,
    adminUserId,
    apiBaseUrl: E2E_API_BASE_URL,
    adminBaseUrl: E2E_ADMIN_BASE_URL,
    apiPort: E2E_API_PORT,
    adminPort: E2E_ADMIN_PORT,
  };
}
