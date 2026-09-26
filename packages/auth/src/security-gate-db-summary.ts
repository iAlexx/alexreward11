/**
 * Credential-free database target summary for security-gate logs (CV-03).
 * Never emits usernames, passwords, query strings, or full URLs.
 *
 * Keep allowlist logic aligned with `scripts/security-gate-db-summary.mjs`.
 */
export function summarizeSecurityGateDatabaseTarget(connectionString: string): {
  readonly ok: boolean;
  readonly summary: string;
} {
  const raw = String(connectionString ?? '').trim();
  if (raw === '') {
    return { ok: false, summary: 'driver=postgresql parse=empty' };
  }
  try {
    const normalized = raw.replace(/^postgresql:/i, 'http:').replace(/^postgres:/i, 'http:');
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
    return {
      ok: true,
      summary: `driver=postgresql db=${dbName} host_kind=${hostKind}`,
    };
  } catch {
    return { ok: false, summary: 'driver=postgresql parse=unparseable' };
  }
}
