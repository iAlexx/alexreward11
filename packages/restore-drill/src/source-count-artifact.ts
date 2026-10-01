/**
 * Fail-closed ingestion of Step 2B.1 redacted source count capture JSON.
 * Never reconnects to live source. Never consumes credential fields.
 */
import { readFileSync } from 'node:fs';

import { REPRESENTATIVE_COUNT_TABLES } from './counts.js';
import type { CountCapture, DrillSectionStatus } from './types.js';

export class SourceCountArtifactError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SourceCountArtifactError';
    this.code = code;
  }
}

const FORBIDDEN_ARTIFACT_KEYS = [
  'DATABASE_URL',
  'databaseUrl',
  'password',
  'PGPASSWORD',
  'token',
  'apiKey',
  'api_key',
  'secret',
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertNoCredentialKeys(obj: Record<string, unknown>, path: string): void {
  for (const key of Object.keys(obj)) {
    for (const forbidden of FORBIDDEN_ARTIFACT_KEYS) {
      if (key === forbidden || key.toLowerCase() === forbidden.toLowerCase()) {
        throw new SourceCountArtifactError(
          'CREDENTIAL_FIELD_REFUSED',
          `source capture must not contain credential field ${path}.${key}`,
        );
      }
    }
  }
}

function parseRfc3339(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SourceCountArtifactError('CAPTURED_AT_MISSING', `${field} must be a non-empty RFC3339 string`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new SourceCountArtifactError('CAPTURED_AT_INVALID', `${field} is not valid RFC3339`);
  }
  return new Date(ms).toISOString();
}

function parseNonNegativeInt(value: unknown, table: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new SourceCountArtifactError(
      'COUNT_INVALID',
      `representative count for ${table} must be a finite non-negative integer`,
    );
  }
  return value;
}

/**
 * Parse a redacted Step 2B.1 source-capture JSON object into CountCapture.
 * Accepts either:
 * - { capturedAt, tables: { ... } }
 * - { sourceEvidenceCapturedAt, representativeCounts: { ... } } (Step 2B.1 shape)
 */
export function parseSourceCountCapture(raw: unknown): CountCapture {
  if (!isPlainObject(raw)) {
    throw new SourceCountArtifactError('ARTIFACT_NOT_OBJECT', 'source capture root must be an object');
  }
  assertNoCredentialKeys(raw, 'root');

  let capturedAt: string;
  let countsObj: Record<string, unknown>;

  if (isPlainObject(raw.tables)) {
    capturedAt = parseRfc3339(raw.capturedAt, 'capturedAt');
    assertNoCredentialKeys(raw.tables, 'tables');
    countsObj = raw.tables;
  } else if (isPlainObject(raw.representativeCounts)) {
    capturedAt = parseRfc3339(
      raw.sourceEvidenceCapturedAt ?? raw.capturedAt,
      'sourceEvidenceCapturedAt',
    );
    assertNoCredentialKeys(raw.representativeCounts, 'representativeCounts');
    countsObj = raw.representativeCounts;
  } else {
    throw new SourceCountArtifactError(
      'COUNTS_MISSING',
      'source capture must include tables or representativeCounts',
    );
  }

  const tables: Record<string, number> = {};
  for (const table of REPRESENTATIVE_COUNT_TABLES) {
    if (!(table in countsObj)) {
      throw new SourceCountArtifactError('TABLE_MISSING', `missing representative table count: ${table}`);
    }
    tables[table] = parseNonNegativeInt(countsObj[table], table);
  }

  // Refuse unknown table keys that look like secrets already checked; extra numeric tables OK to ignore?
  // Strict: only required tables — extra keys in counts are allowed if not credential-named.
  return { capturedAt, tables };
}

export function loadSourceCountCaptureFromPath(path: string): CountCapture {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SourceCountArtifactError('ARTIFACT_READ_FAILED', `failed to read source capture: ${message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SourceCountArtifactError('ARTIFACT_JSON_INVALID', 'source capture is not valid JSON');
  }
  return parseSourceCountCapture(parsed);
}

export function compareSourceRestoredCounts(
  source: CountCapture,
  restored: CountCapture,
): {
  readonly status: DrillSectionStatus;
  readonly reasonCode: string;
  readonly diff: Readonly<Record<string, number>>;
  readonly failedTables: readonly string[];
} {
  const diff: Record<string, number> = {};
  const failedTables: string[] = [];
  for (const table of REPRESENTATIVE_COUNT_TABLES) {
    const s = source.tables[table];
    const r = restored.tables[table];
    if (s === undefined || r === undefined) {
      failedTables.push(table);
      continue;
    }
    const d = r - s;
    diff[table] = d;
    if (d !== 0) failedTables.push(table);
  }
  if (failedTables.length > 0 && Object.values(diff).some((d) => d !== 0)) {
    return {
      status: 'OWNER_REVIEW_REQUIRED',
      reasonCode: 'SOURCE_RESTORED_COUNT_DIFF',
      diff,
      failedTables,
    };
  }
  if (failedTables.length > 0) {
    return {
      status: 'FAIL',
      reasonCode: 'SOURCE_RESTORED_COUNT_INCOMPLETE',
      diff,
      failedTables,
    };
  }
  return {
    status: 'PASS',
    reasonCode: 'SOURCE_RESTORED_COUNT_EXACT_MATCH',
    diff,
    failedTables: [],
  };
}
