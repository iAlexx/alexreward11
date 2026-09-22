/**
 * Minimal RFC 8785 (JCS) canonicalization for Owner-bootstrap JSON values.
 * Supports objects, arrays, strings, booleans, null, and integers only.
 * Rejects non-integer numbers (floats / exponents) at encode time.
 * Rejects unpaired UTF-16 surrogates in strings (keys and values) before encode.
 */
export class JcsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JcsError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Reject unpaired UTF-16 surrogates (PR-03). Valid surrogate pairs are allowed. */
export function assertWellFormedUtf16(value: string, label = 'string'): void {
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : -1;
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new JcsError(`JCS rejects unpaired UTF-16 surrogate in ${label}`);
      }
      i += 1;
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) {
      throw new JcsError(`JCS rejects unpaired UTF-16 surrogate in ${label}`);
    }
  }
}

function encodeString(value: string): string {
  assertWellFormedUtf16(value, 'string');
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20) {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
    } else {
      out += ch;
    }
  }
  return `${out}"`;
}

function encodeNumber(value: number): string {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new JcsError('JCS rejects non-integer numbers');
  }
  if (Object.is(value, -0)) return '0';
  return String(value);
}

export function canonicalizeToJcs(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return encodeNumber(value);
  if (typeof value === 'string') return encodeString(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeToJcs(item)).join(',')}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const parts: string[] = [];
    for (const key of keys) {
      assertWellFormedUtf16(key, 'object key');
      parts.push(`${encodeString(key)}:${canonicalizeToJcs(value[key])}`);
    }
    return `{${parts.join(',')}}`;
  }
  throw new JcsError('JCS unsupported value type');
}
