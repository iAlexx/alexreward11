/**
 * JSON parse that rejects duplicate object keys at any depth.
 * Objects are created with a null prototype; properties are assigned via
 * defineProperty so `__proto__` cannot mutate the prototype chain (PR-04).
 */
export class DuplicateJsonKeyError extends Error {
  constructor(readonly key: string) {
    super(`duplicate JSON key: ${key}`);
    this.name = 'DuplicateJsonKeyError';
  }
}

/**
 * Manual structural parse with duplicate-key rejection.
 * Accepts a subset sufficient for grant envelopes (objects/arrays/scalars).
 */
export function parseStrictJson(text: string): unknown {
  let i = 0;
  const s = text;

  function skipWs(): void {
    while (i < s.length && (s[i] === ' ' || s[i] === '\n' || s[i] === '\r' || s[i] === '\t')) {
      i += 1;
    }
  }

  function parseValue(): unknown {
    skipWs();
    const ch = s[i];
    if (ch === '{') return parseObject();
    if (ch === '[') return parseArray();
    if (ch === '"') return parseString();
    if (ch === 't') return parseLiteral('true', true);
    if (ch === 'f') return parseLiteral('false', false);
    if (ch === 'n') return parseLiteral('null', null);
    if (ch === '-' || (ch !== undefined && ch >= '0' && ch <= '9')) return parseNumber();
    throw new SyntaxError(`unexpected character at ${i}`);
  }

  function parseLiteral(lit: string, value: unknown): unknown {
    if (s.slice(i, i + lit.length) !== lit) throw new SyntaxError(`expected ${lit}`);
    i += lit.length;
    return value;
  }

  function parseNumber(): number {
    const start = i;
    if (s[i] === '-') i += 1;
    if (s[i] === '0') {
      i += 1;
    } else if (s[i] !== undefined && s[i]! >= '1' && s[i]! <= '9') {
      while (s[i] !== undefined && s[i]! >= '0' && s[i]! <= '9') i += 1;
    } else {
      throw new SyntaxError('invalid number');
    }
    if (s[i] === '.' || s[i] === 'e' || s[i] === 'E') {
      throw new SyntaxError('non-integer JSON numbers are rejected');
    }
    const raw = s.slice(start, i);
    const n = Number(raw);
    if (!Number.isInteger(n)) throw new SyntaxError('non-integer JSON numbers are rejected');
    return n;
  }

  function parseString(): string {
    i += 1; // "
    let out = '';
    while (i < s.length) {
      const ch = s[i]!;
      if (ch === '"') {
        i += 1;
        return out;
      }
      if (ch === '\\') {
        i += 1;
        const esc = s[i];
        if (esc === undefined) throw new SyntaxError('bad escape');
        i += 1;
        switch (esc) {
          case '"':
          case '\\':
          case '/':
            out += esc;
            break;
          case 'b':
            out += '\b';
            break;
          case 'f':
            out += '\f';
            break;
          case 'n':
            out += '\n';
            break;
          case 'r':
            out += '\r';
            break;
          case 't':
            out += '\t';
            break;
          case 'u': {
            const hex = s.slice(i, i + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new SyntaxError('bad unicode escape');
            const code = Number.parseInt(hex, 16);
            i += 4;
            // Pair high+low surrogates; reject unpaired (PR-03 path via JSON text).
            if (code >= 0xd800 && code <= 0xdbff) {
              if (s[i] !== '\\' || s[i + 1] !== 'u') {
                throw new SyntaxError('unpaired UTF-16 surrogate in string');
              }
              const hex2 = s.slice(i + 2, i + 6);
              if (!/^[0-9a-fA-F]{4}$/.test(hex2)) throw new SyntaxError('bad unicode escape');
              const low = Number.parseInt(hex2, 16);
              if (!(low >= 0xdc00 && low <= 0xdfff)) {
                throw new SyntaxError('unpaired UTF-16 surrogate in string');
              }
              out += String.fromCharCode(code, low);
              i += 6;
              break;
            }
            if (code >= 0xdc00 && code <= 0xdfff) {
              throw new SyntaxError('unpaired UTF-16 surrogate in string');
            }
            out += String.fromCharCode(code);
            break;
          }
          default:
            throw new SyntaxError('bad escape');
        }
        continue;
      }
      if (ch.charCodeAt(0) < 0x20) throw new SyntaxError('unescaped control');
      const code = ch.charCodeAt(0);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = s[i + 1];
        const nextCode = next === undefined ? -1 : next.charCodeAt(0);
        if (!(nextCode >= 0xdc00 && nextCode <= 0xdfff)) {
          throw new SyntaxError('unpaired UTF-16 surrogate in string');
        }
        out += ch + next!;
        i += 2;
        continue;
      }
      if (code >= 0xdc00 && code <= 0xdfff) {
        throw new SyntaxError('unpaired UTF-16 surrogate in string');
      }
      out += ch;
      i += 1;
    }
    throw new SyntaxError('unterminated string');
  }

  function parseArray(): unknown[] {
    i += 1; // [
    skipWs();
    const arr: unknown[] = [];
    if (s[i] === ']') {
      i += 1;
      return arr;
    }
    for (;;) {
      arr.push(parseValue());
      skipWs();
      if (s[i] === ',') {
        i += 1;
        continue;
      }
      if (s[i] === ']') {
        i += 1;
        return arr;
      }
      throw new SyntaxError('expected , or ]');
    }
  }

  function parseObject(): Record<string, unknown> {
    i += 1; // {
    skipWs();
    const obj = Object.create(null) as Record<string, unknown>;
    const seen = new Set<string>();
    if (s[i] === '}') {
      i += 1;
      return obj;
    }
    for (;;) {
      skipWs();
      if (s[i] !== '"') throw new SyntaxError('expected string key');
      const key = parseString();
      if (seen.has(key)) throw new DuplicateJsonKeyError(key);
      seen.add(key);
      skipWs();
      if (s[i] !== ':') throw new SyntaxError('expected :');
      i += 1;
      const value = parseValue();
      Object.defineProperty(obj, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      skipWs();
      if (s[i] === ',') {
        i += 1;
        continue;
      }
      if (s[i] === '}') {
        i += 1;
        return obj;
      }
      throw new SyntaxError('expected , or }');
    }
  }

  const value = parseValue();
  skipWs();
  if (i !== s.length) throw new SyntaxError('trailing content');
  return value;
}
