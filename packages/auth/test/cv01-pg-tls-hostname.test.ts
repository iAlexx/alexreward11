/**
 * CV-01 — pg adapter TLS hostname must follow Owner profile tls_server_name,
 * not a URL host that pg@8.23 would overwrite into ssl.servername.
 *
 * Uses real `pg` Client against a synthetic SSLRequest+TLS responder (not ops DB).
 */
import { isIP } from 'node:net';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tls from 'node:tls';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildOwnerBootstrapPoolConfig } from '../src/owner-bootstrap/pool.js';
import { buildVerifyFullTlsSocketOptions } from '../src/owner-bootstrap/tls-verify-full.js';

const OPENSSL = process.env.OPENSSL_BIN ?? 'openssl';

function openssl(args: string[], cwd: string): void {
  execFileSync(OPENSSL, args, { cwd, stdio: 'pipe' });
}

/** Minimal peer that accepts pg SSLRequest ('S') then completes TLS with given cert. */
function startPgSslResponder(key: string, cert: string): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((socket: Socket) => {
      socket.once('data', () => {
        socket.write('S');
        const secure = new tls.TLSSocket(socket, {
          isServer: true,
          key,
          cert,
        });
        secure.on('error', () => {
          try {
            secure.destroy();
          } catch {
            /* ignore */
          }
        });
        // Do not speak PostgreSQL — TLS hostname check happens during handshake.
      });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('listen failed'));
        return;
      }
      resolve({
        port: addr.port,
        close: () => {
          server.close();
        },
      });
    });
  });
}

describe('CV-01 pg TLS hostname vs URL host', () => {
  let dir = '';
  let caPem = '';
  let profileKey = '';
  let profileCert = '';
  let wrongKey = '';
  let wrongCert = '';

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'alex-cv01-tls-'));
    openssl(
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-keyout',
        'ca.key',
        '-out',
        'ca.crt',
        '-days',
        '2',
        '-nodes',
        '-subj',
        '/CN=AlexCv01CA',
      ],
      dir,
    );
    openssl(
      ['req', '-newkey', 'rsa:2048', '-keyout', 'profile.key', '-out', 'profile.csr', '-nodes', '-subj', '/CN=db.test.local'],
      dir,
    );
    writeFileSync(join(dir, 'profile.ext'), 'subjectAltName=DNS:db.test.local\nbasicConstraints=CA:FALSE\n');
    openssl(
      [
        'x509',
        '-req',
        '-in',
        'profile.csr',
        '-CA',
        'ca.crt',
        '-CAkey',
        'ca.key',
        '-CAcreateserial',
        '-out',
        'profile.crt',
        '-days',
        '2',
        '-extfile',
        'profile.ext',
      ],
      dir,
    );
    openssl(
      ['req', '-newkey', 'rsa:2048', '-keyout', 'wrong.key', '-out', 'wrong.csr', '-nodes', '-subj', '/CN=evil.example'],
      dir,
    );
    writeFileSync(join(dir, 'wrong.ext'), 'subjectAltName=DNS:evil.example\nbasicConstraints=CA:FALSE\n');
    openssl(
      [
        'x509',
        '-req',
        '-in',
        'wrong.csr',
        '-CA',
        'ca.crt',
        '-CAkey',
        'ca.key',
        '-CAcreateserial',
        '-out',
        'wrong.crt',
        '-days',
        '2',
        '-extfile',
        'wrong.ext',
      ],
      dir,
    );
    caPem = readFileSync(join(dir, 'ca.crt'), 'utf8');
    profileKey = readFileSync(join(dir, 'profile.key'), 'utf8');
    profileCert = readFileSync(join(dir, 'profile.crt'), 'utf8');
    wrongKey = readFileSync(join(dir, 'wrong.key'), 'utf8');
    wrongCert = readFileSync(join(dir, 'wrong.crt'), 'utf8');
  });

  afterAll(() => {
    if (dir !== '') {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('documents pg overwrite: non-IP URL host replaces ssl.servername', () => {
    const ssl = buildVerifyFullTlsSocketOptions({
      caPem,
      tlsServerName: 'db.test.local',
    });
    const options: tls.ConnectionOptions = {};
    Object.assign(options, ssl);
    // Replicate pg@8.23 Connection.upgradeToSSL for a DNS dial host:
    const host = 'evil.example';
    if (isIP(host) === 0) {
      options.servername = host;
    }
    expect(options.servername).toBe('evil.example');
    expect(ssl.servername).toBe('db.test.local');
    expect(typeof ssl.checkServerIdentity).toBe('function');
  });

  it('real pg Client fails when peer cert is for URL host but profile requires db.test.local', async () => {
    const responder = await startPgSslResponder(wrongKey, wrongCert);
    try {
      const built = buildOwnerBootstrapPoolConfig(
        `postgresql://u:p@127.0.0.1:${responder.port}/alex_rewards_test`,
        {
          profileId: 'cv01-pg',
          deploymentEnv: 'staging',
          expectedDatabaseName: 'alex_rewards_test',
          tls: {
            mode: 'verify_full',
            caPem,
            tlsServerName: 'db.test.local',
          },
        },
      );
      expect(built.config.host).toBe('127.0.0.1');
      expect((built.config.ssl as tls.ConnectionOptions).servername).toBe('db.test.local');
      expect((built.config.ssl as tls.ConnectionOptions).rejectUnauthorized).toBe(true);

      const client = new Client(built.config);
      await expect(client.connect()).rejects.toThrow();
      try {
        await client.end();
      } catch {
        /* ignore */
      }
    } finally {
      responder.close();
    }
  });

  it('real pg Client TLS identity accepts profile hostname when dialing by IP', async () => {
    const responder = await startPgSslResponder(profileKey, profileCert);
    try {
      const built = buildOwnerBootstrapPoolConfig(
        `postgresql://u:p@127.0.0.1:${responder.port}/alex_rewards_test`,
        {
          profileId: 'cv01-pg-ok',
          deploymentEnv: 'staging',
          expectedDatabaseName: 'alex_rewards_test',
          tls: {
            mode: 'verify_full',
            caPem,
            tlsServerName: 'db.test.local',
          },
        },
      );
      const client = new Client({
        ...built.config,
        connectionTimeoutMillis: 1500,
      });
      // TLS hostname must pass; responder is not PostgreSQL so connect fails afterward.
      let errorMessage = '';
      try {
        await client.connect();
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }
      expect(errorMessage).not.toMatch(/Hostname\/IP does not match|altnames|ERR_TLS_CERT_ALTNAME/i);
      expect(errorMessage.length).toBeGreaterThan(0);
      try {
        await client.end();
      } catch {
        /* ignore */
      }
    } finally {
      responder.close();
    }
  }, 15_000);

  it('refuses mismatched DNS URL host at pool config (exploit scenario closed)', () => {
    expect(() =>
      buildOwnerBootstrapPoolConfig('postgresql://u:p@evil.example:5432/alex_rewards_test', {
        profileId: 'cv01-mismatch',
        deploymentEnv: 'staging',
        expectedDatabaseName: 'alex_rewards_test',
        tls: { mode: 'verify_full', caPem, tlsServerName: 'db.test.local' },
      }),
    ).toThrow(/tls_server_name|overwrite/i);
  });
});
