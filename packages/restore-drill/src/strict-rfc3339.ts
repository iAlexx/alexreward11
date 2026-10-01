/**
 * Strict RFC3339 timestamp parser for Phase 18 restore evidence.
 * Rejects Date.parse-accepted forms that are not RFC3339 (date-only, space sep, missing TZ, etc.).
 */

const STRICT_RFC3339_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

function isValidClock(hour: number, minute: number, second: number): boolean {
  return hour <= 23 && minute <= 59 && second <= 60;
}

function isValidOffset(offset: string): boolean {
  if (offset === 'Z') return true;
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  if (!m) return false;
  const hh = Number(m[2]);
  const mm = Number(m[3]);
  return hh <= 23 && mm <= 59;
}

/**
 * Parse a strict RFC3339 timestamp and return UTC ISO via `toISOString()`.
 * @throws Error with message starting `STRICT_RFC3339_INVALID:` on rejection
 */
export function parseStrictRfc3339(value: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('STRICT_RFC3339_INVALID: empty');
  }
  const raw = value.trim();
  const match = STRICT_RFC3339_RE.exec(raw);
  if (!match) {
    throw new Error('STRICT_RFC3339_INVALID: format');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offset = match[8]!;
  if (!isValidCalendarDate(year, month, day)) {
    throw new Error('STRICT_RFC3339_INVALID: calendar');
  }
  if (!isValidClock(hour, minute, second)) {
    throw new Error('STRICT_RFC3339_INVALID: clock');
  }
  if (!isValidOffset(offset)) {
    throw new Error('STRICT_RFC3339_INVALID: timezone');
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    throw new Error('STRICT_RFC3339_INVALID: unparseable');
  }
  return new Date(ms).toISOString();
}

export function tryParseStrictRfc3339(value: string): string | null {
  try {
    return parseStrictRfc3339(value);
  } catch {
    return null;
  }
}
