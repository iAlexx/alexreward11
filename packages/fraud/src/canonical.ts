import { createHash } from 'node:crypto';

import { FraudDomainError } from './errors.js';

/** Exact denylist after lowercasing and stripping `_` / `-` / spaces. */
const SENSITIVE_EXACT = new Set([
  'initdata',
  'telegraminitdata',
  'token',
  'accesstoken',
  'refreshtoken',
  'sessiontoken',
  'secret',
  'apisecret',
  'password',
  'mnemonic',
  'privatekey',
  'seed',
  'seedphrase',
  'authorization',
  'authorizationheader',
  'cookie',
  'setcookie',
  'exactip',
  'ipaddress',
  'rawip',
  'clientip',
  'remoteip',
  'ip',
  'gps',
  'latitude',
  'longitude',
]);

/** Substring denylist on normalized keys (does not match privacy-safe `iphash`). */
const SENSITIVE_SUBSTRINGS = [
  'initdata',
  'privatekey',
  'seedphrase',
  'accesstoken',
  'refreshtoken',
  'sessiontoken',
  'authorization',
  'setcookie',
  'exactip',
  'ipaddress',
  'rawip',
  'clientip',
  'remoteip',
  'latitude',
  'longitude',
] as const;

export function normalizeSensitiveKey(key: string): string {
  return key.toLowerCase().replace(/[_\-\s]/g, '');
}

export function isSensitivePersistedKey(key: string): boolean {
  const normalized = normalizeSensitiveKey(key);
  if (SENSITIVE_EXACT.has(normalized)) return true;
  // Privacy-safe hashed network identifiers are allowed.
  if (normalized === 'iphash') return false;
  for (const part of SENSITIVE_SUBSTRINGS) {
    if (normalized.includes(part)) return true;
  }
  if (normalized.includes('password') || normalized.includes('mnemonic')) return true;
  if (normalized.includes('secret') && normalized !== 'iphash') return true;
  if (normalized.endsWith('token') || normalized.includes('token')) return true;
  return false;
}

export function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Fail-closed JSON-compatible value check for persisted risk snapshot payloads.
 * Rejects Date/Map/Set/Buffer/class instances/bigint/undefined/function/symbol/non-finite numbers.
 */
export function assertJsonCompatibleValue(path: string, value: unknown): void {
  if (value === null) return;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return;
  if (t === 'number') {
    if (!Number.isFinite(value)) {
      throw new FraudDomainError('RISK_SNAPSHOT_INVALID', `${path} must be a finite number`, {
        path,
        value,
      });
    }
    return;
  }
  if (t === 'bigint' || t === 'undefined' || t === 'function' || t === 'symbol') {
    throw new FraudDomainError('RISK_SNAPSHOT_INVALID', `${path} has unsupported JSON type`, {
      path,
      typeof: t,
    });
  }
  if (t !== 'object') {
    throw new FraudDomainError('RISK_SNAPSHOT_INVALID', `${path} has unsupported JSON type`, {
      path,
      typeof: t,
    });
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonCompatibleValue(`${path}[${index}]`, item));
    return;
  }
  if (!isPlainJsonObject(value)) {
    throw new FraudDomainError(
      'RISK_SNAPSHOT_INVALID',
      `${path} must be a plain JSON object (Date/Map/Set/class instances rejected)`,
      { path },
    );
  }
  for (const [key, child] of Object.entries(value)) {
    if (isSensitivePersistedKey(key)) {
      throw new FraudDomainError(
        'RISK_SNAPSHOT_INVALID',
        `${path} key ${key} is not allowed`,
        { path, key },
      );
    }
    assertJsonCompatibleValue(`${path}.${key}`, child);
  }
}

/** Validate a top-level persisted JSON object (safeInputs / outputs). */
export function assertSafePersistedJsonObject(
  path: string,
  value: Readonly<Record<string, unknown>>,
): void {
  if (!isPlainJsonObject(value)) {
    throw new FraudDomainError('RISK_SNAPSHOT_INVALID', `${path} must be a plain JSON object`);
  }
  assertJsonCompatibleValue(path, value);
}

/**
 * Deterministic canonical JSON for digests.
 * Sorts object keys recursively; arrays keep order; never relies on insertion order.
 * Rejects non-JSON values fail-closed.
 */
export function canonicalizeForDigest(value: unknown): string {
  assertJsonCompatibleValue('canonical', value);
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = sortValue(record[key]);
  }
  return sorted;
}

/** SHA-256 hex digest of the canonical representation of a safe input set. */
export function computeRiskInputsDigest(
  ruleVersion: number,
  safeInputs: Readonly<Record<string, unknown>>,
): string {
  if (!Number.isInteger(ruleVersion) || ruleVersion <= 0) {
    throw new FraudDomainError('RISK_SNAPSHOT_INVALID', 'ruleVersion must be a positive integer');
  }
  assertSafePersistedJsonObject('safeInputs', safeInputs);
  const payload = canonicalizeForDigest({
    ruleVersion,
    safeInputs,
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}
