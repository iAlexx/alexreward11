/**
 * Credential-free database target summary for security-gate logs (CV-03).
 * Never emits usernames, passwords, query strings, or full URLs.
 * Keep allowlist logic aligned with packages/auth/src/security-gate-db-summary.ts
 */

/**
 * @param {string} connectionString
 * @returns {{ ok: true, summary: string } | { ok: false, summary: string }}
 */
export function summarizeSecurityGateDatabaseTarget(connectionString) {
  const raw = String(connectionString ?? '').trim();
  if (raw === '') {
    return { ok: false, summary: 'driver=postgresql parse=empty' };
  }
  try {
    // Normalize scheme so WHATWG URL can parse postgres URLs.
    const normalized = raw
      .replace(/^postgresql:/i, 'http:')
      .replace(/^postgres:/i, 'http:');
    const u = new URL(normalized);
    const dbName = decodeURIComponent((u.pathname || '/').replace(/^\//, '').split('/')[0] ?? '');
    if (dbName === '') {
      return { ok: false, summary: 'driver=postgresql parse=missing_database' };
    }
    const hostRaw = (u.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    let hostKind = 'name';
    if (hostRaw === 'localhost' || hostRaw === '127.0.0.1' || hostRaw === '::1') {
      hostKind = 'loopback';
    } else if (/^\d+\.\d+\.\d+\.\d+$/.test(hostRaw) || hostRaw.includes(':')) {
      hostKind = 'ip';
    }
    // Allowlisted fields only — never userinfo, never search/hash.
    return {
      ok: true,
      summary: `driver=postgresql db=${dbName} host_kind=${hostKind}`,
    };
  } catch {
    return { ok: false, summary: 'driver=postgresql parse=unparseable' };
  }
}
