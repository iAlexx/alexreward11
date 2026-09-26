import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { FOUNDER_NUMBER, SEED_BALANCES, SEED_QUOTE, TELEGRAM_IDS } from '../env.js';

export type Phase12E2ePublicSeed = {
  readonly standardTelegramUserId: string;
  readonly founderTelegramUserId: string;
  readonly otherTelegramUserId: string;
  readonly balances: typeof SEED_BALANCES;
  readonly quote: typeof SEED_QUOTE;
  readonly founderNumber: number;
  readonly standardFriendlyAddress: string;
};

/** Secrets stay off stdout/logs — only written to a temp file for Playwright workers. */
export type Phase12E2eSecrets = {
  readonly founderClaimCode: string;
};

function publicSeedPath(): string {
  return join(tmpdir(), 'alex-rewards-phase12-e2e', 'public-seed.json');
}

function secretsPath(): string {
  return join(tmpdir(), 'alex-rewards-phase12-e2e', 'secrets.json');
}

export function writePublicSeed(seed: Phase12E2ePublicSeed): void {
  const path = publicSeedPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(seed, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function readPublicSeed(): Phase12E2ePublicSeed {
  return JSON.parse(readFileSync(publicSeedPath(), 'utf8')) as Phase12E2ePublicSeed;
}

export function writeSecrets(secrets: Phase12E2eSecrets): void {
  const path = secretsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(secrets)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function readSecrets(): Phase12E2eSecrets {
  return JSON.parse(readFileSync(secretsPath(), 'utf8')) as Phase12E2eSecrets;
}

export function defaultPublicSeed(friendlyAddress: string): Phase12E2ePublicSeed {
  return {
    standardTelegramUserId: TELEGRAM_IDS.standard,
    founderTelegramUserId: TELEGRAM_IDS.founder,
    otherTelegramUserId: TELEGRAM_IDS.other,
    balances: SEED_BALANCES,
    quote: SEED_QUOTE,
    founderNumber: FOUNDER_NUMBER,
    standardFriendlyAddress: friendlyAddress,
  };
}
