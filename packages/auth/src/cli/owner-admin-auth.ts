#!/usr/bin/env node
/**
 * Owner admin authentication CLI (local / isolated DB).
 *
 * Commands: enroll | login | reauth | logout
 *
 * Secrets (password, TOTP, session token, provisioning material) are read/shown
 * only on verified interactive TTYs — never argv/env/logs/JSON stdout.
 *
 * Requires --expected-database <name> matching live current_database().
 * Operational first enrollment is refused (see OWNER_ADMIN_BOOTSTRAP_DESIGN.md).
 */
import { createDatabasePool } from '@alex-rewards/db';
import { loadWorkerConfig } from '@alex-rewards/config';

import {
  OWNER_ADMIN_AUTH_OPERATIONAL_CONFIRM,
  beginOwnerAdminTotpEnrollment,
  completeOwnerAdminTotpEnrollment,
  loginOwnerAdmin,
  logoutOwnerAdminSession,
  preflightOwnerAdminEnrollment,
  reauthenticateOwnerAdminSession,
} from '../admin-auth.js';
import { ADMIN_REAUTH_MAX_AGE_MS } from '../admin-session-token.js';
import { AuthDomainError } from '../errors.js';
import {
  assertInteractiveSecretTerminals,
  displaySecretOnceOnInteractiveStderr,
  readSecretFromTty,
} from '../tty-secret.js';

function usage(code = 2): never {
  console.error(
    JSON.stringify(
      {
        ok: false,
        usage: [
          'owner-admin-auth enroll --expected-database <name> [--admin-user-id <uuid>|--email <email>] [--replace]',
          'owner-admin-auth login --expected-database <name> [--admin-user-id <uuid>|--email <email>]',
          'owner-admin-auth reauth --expected-database <name>',
          'owner-admin-auth logout --expected-database <name>',
        ],
        secrets: 'TTY-only (password, TOTP, session token, provisioning material)',
        operationalRefuse:
          'operational alex_rewards requires matching expectedClusterSystemIdentifier ' +
          '(pg_control_system) + OWNER_ADMIN_AUTH_ALLOW_OPERATIONAL_DB=' +
          OWNER_ADMIN_AUTH_OPERATIONAL_CONFIRM +
          '; first operational enrollment is always refused',
        reauthMaxAgeMs: ADMIN_REAUTH_MAX_AGE_MS,
      },
      null,
      2,
    ),
  );
  process.exit(code);
}

function readFlag(argv: ReadonlyArray<string>, name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx < 0) return undefined;
  return argv[idx + 1];
}

function hasSwitch(argv: ReadonlyArray<string>, name: string): boolean {
  return argv.includes(name);
}

function forbidSecretFlags(argv: ReadonlyArray<string>): void {
  for (const arg of argv) {
    if (
      arg === '--password' ||
      arg.startsWith('--password=') ||
      arg === '--totp' ||
      arg.startsWith('--totp=') ||
      arg === '--session-token' ||
      arg.startsWith('--session-token=') ||
      arg === '--owner-session-token' ||
      arg.startsWith('--owner-session-token=')
    ) {
      console.error(
        JSON.stringify({
          ok: false,
          error: 'secrets must not be passed via CLI arguments (use interactive TTY)',
        }),
      );
      process.exit(1);
    }
  }
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function resolveDatabaseUrl(): string {
  // Prefer explicit OWNER_ADMIN_AUTH_DATABASE_URL over ambient DATABASE_URL.
  const explicit = process.env.OWNER_ADMIN_AUTH_DATABASE_URL?.trim();
  if (explicit) return explicit;
  let databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    try {
      databaseUrl = loadWorkerConfig().DATABASE_URL;
    } catch {
      console.error(JSON.stringify({ ok: false, error: 'DATABASE_URL is required' }));
      process.exit(1);
    }
  }
  return databaseUrl;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  forbidSecretFlags(argv);
  const command = argv[0];
  if (
    command !== 'enroll' &&
    command !== 'login' &&
    command !== 'reauth' &&
    command !== 'logout'
  ) {
    usage();
  }

  const expectedDatabase = readFlag(argv, '--expected-database');
  if (expectedDatabase === undefined || expectedDatabase.trim() === '') {
    usage();
  }

  const operationalConfirm =
    process.env.OWNER_ADMIN_AUTH_ALLOW_OPERATIONAL_DB ?? null;
  const expectedClusterSystemIdentifier =
    process.env.OWNER_ADMIN_AUTH_EXPECTED_CLUSTER_SYSTEM_IDENTIFIER ?? null;

  const databaseUrl = resolveDatabaseUrl();
  const pool = createDatabasePool(databaseUrl);
  try {
    if (command === 'enroll') {
      assertInteractiveSecretTerminals();
      const adminUserId = readFlag(argv, '--admin-user-id') ?? null;
      const email = readFlag(argv, '--email') ?? null;
      if ((adminUserId === null || adminUserId === '') && (email === null || email === '')) {
        usage();
      }
      const replace = hasSwitch(argv, '--replace');

      // Read-only preflight BEFORE generating/displaying TOTP secrets (authoritative
      // checks still run inside completeOwnerAdminTotpEnrollment).
      const preflight = await preflightOwnerAdminEnrollment(pool, {
        adminUserId,
        email,
        replaceExisting: replace,
        expectedDatabase: expectedDatabase.trim(),
        expectedClusterSystemIdentifier,
        operationalConfirm,
      });
      printJson({
        ok: true,
        command: 'enroll-preflight',
        adminUserId: preflight.adminUserId,
        email: preflight.email,
        mode: preflight.mode,
        redactedTarget: preflight.redactedTarget,
        note: 'Preflight passed; provisioning secrets follow on interactive stderr only',
      });

      const begun = await beginOwnerAdminTotpEnrollment();
      await displaySecretOnceOnInteractiveStderr({
        label: 'TOTP_SECRET_BASE32 (display once — store offline / add to authenticator)',
        secret: begun.totpSecretBase32,
        warning:
          'WARNING: Terminal screen recording and transcripts are sensitive. Do not redirect stderr.',
      });
      if (email) {
        await displaySecretOnceOnInteractiveStderr({
          label: 'OTPAUTH_URI (display once)',
          secret: begun.provisionalOtpauthUri(email),
          warning: 'WARNING: otpauth URI contains the TOTP seed. Do not log or redirect.',
        });
      }
      const password = await readSecretFromTty('New Owner password (hidden): ');
      const password2 = await readSecretFromTty('Confirm password (hidden): ');
      if (password !== password2) {
        throw new AuthDomainError('VALIDATION', 'password confirmation mismatch');
      }
      let currentPassword: string | null = null;
      let currentTotpCode: string | null = null;
      if (replace) {
        currentPassword = await readSecretFromTty('Current password (hidden): ');
        currentTotpCode = await readSecretFromTty('Current TOTP code (hidden): ');
      }
      const totpConfirmationCode = await readSecretFromTty(
        'Enter TOTP code for the NEW secret (hidden): ',
      );
      const result = await completeOwnerAdminTotpEnrollment(pool, {
        adminUserId: preflight.adminUserId,
        email: null,
        password,
        totpSecretBytes: begun.totpSecretBytes,
        totpConfirmationCode,
        replaceExisting: replace,
        currentPassword,
        currentTotpCode,
        expectedDatabase: expectedDatabase.trim(),
        expectedClusterSystemIdentifier,
        operationalConfirm,
      });
      printJson({
        ok: true,
        command: 'enroll',
        adminUserId: result.adminUserId,
        email: result.email,
        replaced: result.replaced,
        sessionsRevoked: result.sessionsRevoked,
        redactedTarget: result.redactedTarget,
        note: 'Provisioning material was shown only on interactive stderr and is not repeated here',
      });
      return;
    }

    if (command === 'login') {
      assertInteractiveSecretTerminals();
      const adminUserId = readFlag(argv, '--admin-user-id') ?? null;
      const email = readFlag(argv, '--email') ?? null;
      if ((adminUserId === null || adminUserId === '') && (email === null || email === '')) {
        usage();
      }
      const password = await readSecretFromTty('Owner password (hidden): ');
      const totpCode = await readSecretFromTty('TOTP code (hidden): ');
      const bundle = await loginOwnerAdmin(pool, {
        adminUserId,
        email,
        password,
        totpCode,
        expectedDatabase: expectedDatabase.trim(),
        expectedClusterSystemIdentifier,
        operationalConfirm,
      });
      const sessionToken = bundle.takeSessionTokenOnce();
      await displaySecretOnceOnInteractiveStderr({
        label: 'SESSION_TOKEN (paste into Recovery hidden TTY prompt; not stored by this CLI)',
        secret: sessionToken,
        warning:
          'WARNING: Session token authorizes high-impact Owner actions while reauth is fresh. ' +
          'Do not redirect stderr, log, or automate clipboard. Terminal recordings remain sensitive.',
      });
      printJson({
        ok: true,
        command: 'login',
        adminUserId: bundle.result.adminUserId,
        email: bundle.result.email,
        sessionId: bundle.result.sessionId,
        idleExpiresAt: bundle.result.idleExpiresAt,
        absoluteExpiresAt: bundle.result.absoluteExpiresAt,
        reauthenticatedAt: bundle.result.reauthenticatedAt,
        reauthMaxAgeMs: ADMIN_REAUTH_MAX_AGE_MS,
        redactedTarget: bundle.result.redactedTarget,
        sessionTokenPrintedInteractively: true,
      });
      return;
    }

    if (command === 'reauth') {
      assertInteractiveSecretTerminals();
      const sessionToken = await readSecretFromTty('Owner session token (hidden): ');
      const password = await readSecretFromTty('Owner password (hidden): ');
      const totpCode = await readSecretFromTty('TOTP code (hidden): ');
      const result = await reauthenticateOwnerAdminSession(pool, {
        sessionToken,
        password,
        totpCode,
        expectedDatabase: expectedDatabase.trim(),
        expectedClusterSystemIdentifier,
        operationalConfirm,
      });
      printJson({
        ok: true,
        command: 'reauth',
        adminUserId: result.adminUserId,
        sessionId: result.sessionId,
        reauthenticatedAt: result.reauthenticatedAt,
        reauthMaxAgeMs: result.reauthMaxAgeMs,
        redactedTarget: result.redactedTarget,
      });
      return;
    }

    assertInteractiveSecretTerminals();
    const sessionToken = await readSecretFromTty('Owner session token (hidden): ');
    const result = await logoutOwnerAdminSession(pool, {
      sessionToken,
      expectedDatabase: expectedDatabase.trim(),
      expectedClusterSystemIdentifier,
      operationalConfirm,
    });
    printJson({
      ok: true,
      command: 'logout',
      sessionId: result.sessionId,
      revoked: result.revoked,
      redactedTarget: result.redactedTarget,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unexpected error';
    const code = error instanceof AuthDomainError ? error.code : 'INTERNAL';
    printJson({ ok: false, error: message, code });
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : 'unexpected error',
    }),
  );
  process.exit(1);
});
