/**
 * G5 TLS verify-full — real Node tls.connect tests with synthetic OpenSSL certs.
 * Exercises the same ConnectionOptions shape passed to node-postgres (`ssl`).
 * Not operational PostgreSQL. Not mocked CA validation.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tls from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthDomainError } from '../src/errors.js';
import {
  assertSpkiPinningUnsupportedForV1,
  buildVerifyFullTlsSocketOptions,
} from '../src/owner-bootstrap/tls-verify-full.js';
import { buildOwnerBootstrapPoolConfig } from '../src/owner-bootstrap/pool.js';

const OPENSSL = process.env.OPENSSL_BIN ?? 'openssl';

function openssl(args: string[], cwd: string): void {
  execFileSync(OPENSSL, args, { cwd, stdio: 'pipe' });
}

function tlsConnectOnce(
  port: number,
  options: tls.ConnectionOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        ...options,
        host: '127.0.0.1',
        port,
      },
      () => {
        socket.end();
        resolve();
      },
    );
    socket.setTimeout(5000, () => {
      socket.destroy(new Error('tls connect timeout'));
    });
    socket.on('error', reject);
  });
}

describe('G5 SPKI rejection (unit — not TLS handshake)', () => {
  it('refuses explicit SPKI and malformed presence', () => {
    expect(() => assertSpkiPinningUnsupportedForV1('ab'.repeat(32))).toThrow(/G5|SPKI/i);
    expect(() => assertSpkiPinningUnsupportedForV1('')).toThrow(/G5|SPKI/i);
    expect(() =>
      buildVerifyFullTlsSocketOptions({
        caPem: '-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----\n',
        tlsServerName: 'db.example',
        spkiSha256Hex: 'not-hex',
      }),
    ).toThrow(/G5|SPKI/i);
  });

  it('rejects missing CA / hostname and never sets rejectUnauthorized false', () => {
    expect(() =>
      buildVerifyFullTlsSocketOptions({ caPem: '', tlsServerName: 'db.example' }),
    ).toThrow(/CA|trust anchor/i);
    expect(() =>
      buildVerifyFullTlsSocketOptions({
        caPem: '-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----\n',
        tlsServerName: '',
      }),
    ).toThrow(/tls_server_name/i);
    const opts = buildVerifyFullTlsSocketOptions({
      caPem: '-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----\n',
      tlsServerName: 'db.example',
    });
    expect(opts.rejectUnauthorized).toBe(true);
    expect(opts.servername).toBe('db.example');
    expect(typeof opts.checkServerIdentity).toBe('function');
  });

  it('pool adapter refuses weaker URL sslmode and SPKI profile field', () => {
    expect(() =>
      buildOwnerBootstrapPoolConfig(
        'postgresql://u:p@db.example:5432/alex_rewards_test?sslmode=require',
        {
          profileId: 'p',
          deploymentEnv: 'staging',
          expectedDatabaseName: 'alex_rewards_test',
          tls: {
            mode: 'verify_full',
            caPem: '-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----\n',
            tlsServerName: 'db.example',
          },
        },
      ),
    ).toThrow(/sslmode/i);
    expect(() =>
      buildOwnerBootstrapPoolConfig('postgresql://u:p@db.example:5432/alex_rewards_test', {
        profileId: 'p',
        deploymentEnv: 'staging',
        expectedDatabaseName: 'alex_rewards_test',
        tls: {
          mode: 'verify_full',
          caPem: '-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----\n',
          tlsServerName: 'db.example',
          spkiSha256Hex: 'ab'.repeat(32),
        },
      }),
    ).toThrow(/G5|SPKI/i);
  });
});

describe('G5 real Node TLS verify-full (synthetic OpenSSL certs)', () => {
  let dir = '';
  let caPem = '';
  let otherCaPem = '';
  let serverKey = '';
  let serverCert = '';
  let wrongHostCert = '';
  let wrongHostKey = '';
  let expiredCert = '';
  let expiredKey = '';
  let server: tls.Server | null = null;
  let port = 0;

  async function listen(s: tls.Server): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = s.address();
    if (addr === null || typeof addr === 'string') {
      throw new Error('listen failed');
    }
    return addr.port;
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'alex-g5-tls-'));
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
        '/CN=AlexG5TestCA',
      ],
      dir,
    );
    openssl(
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-keyout',
        'other-ca.key',
        '-out',
        'other-ca.crt',
        '-days',
        '2',
        '-nodes',
        '-subj',
        '/CN=AlexG5OtherCA',
      ],
      dir,
    );
    openssl(
      [
        'req',
        '-newkey',
        'rsa:2048',
        '-keyout',
        'server.key',
        '-out',
        'server.csr',
        '-nodes',
        '-subj',
        '/CN=db.test.local',
      ],
      dir,
    );
    writeFileSync(
      join(dir, 'server.ext'),
      'subjectAltName=DNS:db.test.local\nbasicConstraints=CA:FALSE\n',
    );
    openssl(
      [
        'x509',
        '-req',
        '-in',
        'server.csr',
        '-CA',
        'ca.crt',
        '-CAkey',
        'ca.key',
        '-CAcreateserial',
        '-out',
        'server.crt',
        '-days',
        '2',
        '-extfile',
        'server.ext',
      ],
      dir,
    );
    openssl(
      [
        'req',
        '-newkey',
        'rsa:2048',
        '-keyout',
        'wrong.key',
        '-out',
        'wrong.csr',
        '-nodes',
        '-subj',
        '/CN=other.example',
      ],
      dir,
    );
    writeFileSync(
      join(dir, 'wrong.ext'),
      'subjectAltName=DNS:other.example\nbasicConstraints=CA:FALSE\n',
    );
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
    openssl(
      [
        'req',
        '-newkey',
        'rsa:2048',
        '-keyout',
        'expired.key',
        '-out',
        'expired.csr',
        '-nodes',
        '-subj',
        '/CN=db.test.local',
      ],
      dir,
    );
    writeFileSync(
      join(dir, 'expired.ext'),
      'subjectAltName=DNS:db.test.local\nbasicConstraints=CA:FALSE\n',
    );
    openssl(
      [
        'x509',
        '-req',
        '-in',
        'expired.csr',
        '-CA',
        'ca.crt',
        '-CAkey',
        'ca.key',
        '-CAcreateserial',
        '-out',
        'expired.crt',
        '-extfile',
        'expired.ext',
        '-not_before',
        '200101000000Z',
        '-not_after',
        '200102000000Z',
      ],
      dir,
    );

    caPem = readFileSync(join(dir, 'ca.crt'), 'utf8');
    otherCaPem = readFileSync(join(dir, 'other-ca.crt'), 'utf8');
    serverKey = readFileSync(join(dir, 'server.key'), 'utf8');
    serverCert = readFileSync(join(dir, 'server.crt'), 'utf8');
    wrongHostKey = readFileSync(join(dir, 'wrong.key'), 'utf8');
    wrongHostCert = readFileSync(join(dir, 'wrong.crt'), 'utf8');
    expiredKey = readFileSync(join(dir, 'expired.key'), 'utf8');
    expiredCert = readFileSync(join(dir, 'expired.crt'), 'utf8');

    server = tls.createServer({ key: serverKey, cert: serverCert }, (socket) => {
      socket.end('ok');
    });
    port = await listen(server);
  });

  afterAll(() => {
    server?.close();
    if (dir !== '') {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('1 trusted CA + matching hostname succeeds (real tls.connect)', async () => {
    const opts = buildVerifyFullTlsSocketOptions({
      caPem,
      tlsServerName: 'db.test.local',
    });
    await expect(tlsConnectOnce(port, opts)).resolves.toBeUndefined();
  });

  it('2 untrusted CA fails', async () => {
    const opts = buildVerifyFullTlsSocketOptions({
      caPem: otherCaPem,
      tlsServerName: 'db.test.local',
    });
    await expect(tlsConnectOnce(port, opts)).rejects.toThrow();
  });

  it('3 wrong hostname fails', async () => {
    const opts = buildVerifyFullTlsSocketOptions({
      caPem,
      tlsServerName: 'not-the-cert-name.example',
    });
    await expect(tlsConnectOnce(port, opts)).rejects.toThrow();
  });

  it('4 expired certificate fails', async () => {
    const expiredServer = tls.createServer(
      { key: expiredKey, cert: expiredCert },
      (socket) => socket.end(),
    );
    const p = await listen(expiredServer);
    try {
      const opts = buildVerifyFullTlsSocketOptions({
        caPem,
        tlsServerName: 'db.test.local',
      });
      await expect(tlsConnectOnce(p, opts)).rejects.toThrow();
    } finally {
      expiredServer.close();
    }
  });

  it('5 missing CA refused before connect', () => {
    expect(() =>
      buildVerifyFullTlsSocketOptions({ caPem: '   ', tlsServerName: 'db.test.local' }),
    ).toThrow(AuthDomainError);
  });

  it('6 missing server hostname refused before connect', () => {
    expect(() =>
      buildVerifyFullTlsSocketOptions({ caPem, tlsServerName: '' }),
    ).toThrow(AuthDomainError);
  });

  it('10 connection failure has no insecure fallback', async () => {
    const opts = buildVerifyFullTlsSocketOptions({
      caPem,
      tlsServerName: 'db.test.local',
    });
    await expect(tlsConnectOnce(1, opts)).rejects.toThrow();
    expect(opts.rejectUnauthorized).toBe(true);
  });

  it('hostname verification is not satisfied by servername alone without rejectUnauthorized', async () => {
    await expect(
      tlsConnectOnce(port, {
        rejectUnauthorized: false,
        ca: caPem,
        servername: 'not-the-cert-name.example',
      }),
    ).resolves.toBeUndefined();
    await expect(
      tlsConnectOnce(
        port,
        buildVerifyFullTlsSocketOptions({
          caPem,
          tlsServerName: 'not-the-cert-name.example',
        }),
      ),
    ).rejects.toThrow();
  });

  it('wrong-host server cert fails when client expects db.test.local', async () => {
    const wrongServer = tls.createServer(
      { key: wrongHostKey, cert: wrongHostCert },
      (socket) => socket.end(),
    );
    const p = await listen(wrongServer);
    try {
      const opts = buildVerifyFullTlsSocketOptions({
        caPem,
        tlsServerName: 'db.test.local',
      });
      await expect(tlsConnectOnce(p, opts)).rejects.toThrow();
    } finally {
      wrongServer.close();
    }
  });
});
