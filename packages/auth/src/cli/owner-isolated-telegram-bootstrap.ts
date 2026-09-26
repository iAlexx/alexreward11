#!/usr/bin/env node
/**
 * Isolated Testnet first-Owner bootstrap CLI (Telegram ID + initData + password/TOTP).
 *
 * No Option C ceremony. Username is display-only.
 * Restricted to alex_rewards_isolated_payout_test @ 127.0.0.1:55440.
 */
import { readFileSync } from 'node:fs';
import { createDatabasePool } from '@alex-rewards/db';

import { AuthDomainError } from '../errors.js';
import {
  ISOLATED_TELEGRAM_OWNER_BOOTSTRAP_TARGET,
  assertConfiguredOwnerTelegramUserId,
  assertIsolatedTelegramOwnerBootstrapTarget,
  enrollIsolatedTelegramOwner,
  parseIsolatedOwnerBootstrapUrl,
} from '../owner-bootstrap/isolated-telegram-owner-bootstrap.js';
import {
  assertInteractiveSecretTerminals,
  displaySecretOnceOnInteractiveStderr,
  readLineFromTty,
  readSecretFromTty,
} from '../tty-secret.js';
import { bytesToBase32, generateTotpSecretBytes } from '../admin-password.js';
import { buildOtpAuthUri, generateTotpCode } from '../admin-totp.js';

function usage(code = 2): never {
  console.error(
    JSON.stringify(
      {
        ok: false,
        tool: 'owner-isolated-telegram-bootstrap',
        target: ISOLATED_TELEGRAM_OWNER_BOOTSTRAP_TARGET,
        usage: [
          'owner-isolated-telegram-bootstrap preflight --expected-database alex_rewards_isolated_payout_test',
          'owner-isolated-telegram-bootstrap enroll --expected-database alex_rewards_isolated_payout_test --email <email>',
        ],
        env: [
          'OWNER_BOOTSTRAP_CEREMONY_DATABASE_URL or OWNER_ADMIN_AUTH_DATABASE_URL (preferred over DATABASE_URL)',
          'ISOLATED_OWNER_BOOTSTRAP_TELEGRAM_USER_ID (required configured Owner Telegram id)',
          'TELEGRAM_BOT_TOKEN (for initData HMAC; never printed)',
        ],
        secrets: 'TTY-only: initData, password, TOTP provisioning material',
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

function requireFlag(argv: ReadonlyArray<string>, name: string): string {
  const v = readFlag(argv, name);
  if (v === undefined || v.trim() === '') usage();
  return v.trim();
}

function forbidSecretFlags(argv: ReadonlyArray<string>): void {
  for (const arg of argv) {
    if (
      arg === '--password' ||
      arg.startsWith('--password=') ||
      arg === '--init-data' ||
      arg.startsWith('--init-data=') ||
      arg === '--totp' ||
      arg.startsWith('--totp=') ||
      arg === '--bot-token' ||
      arg.startsWith('--bot-token=')
    ) {
      console.error(
        JSON.stringify({
          ok: false,
          error: 'secrets must not be passed via CLI arguments',
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
  const fromFile = process.env.OWNER_ISOLATED_BOOTSTRAP_DATABASE_URL_FILE?.trim();
  if (fromFile) {
    return readFileSync(fromFile, 'utf8').trim();
  }
  const explicit =
    process.env.OWNER_BOOTSTRAP_CEREMONY_DATABASE_URL?.trim() ||
    process.env.OWNER_ADMIN_AUTH_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim();
  if (!explicit) {
    console.error(JSON.stringify({ ok: false, error: 'DATABASE_URL is required' }));
    process.exit(1);
  }
  return explicit;
}

function resolveConfiguredTelegramUserId(): string {
  const raw =
    process.env.ISOLATED_OWNER_BOOTSTRAP_TELEGRAM_USER_ID?.trim() ||
    process.env.CONTROL_CENTER_OWNER_TELEGRAM_USER_IDS?.split(',')[0]?.trim() ||
    '';
  if (raw === '') {
    throw new AuthDomainError(
      'VALIDATION',
      'ISOLATED_OWNER_BOOTSTRAP_TELEGRAM_USER_ID is required',
    );
  }
  return assertConfiguredOwnerTelegramUserId(raw);
}

function resolveBotToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? '';
  if (token === '') {
    throw new AuthDomainError('VALIDATION', 'TELEGRAM_BOT_TOKEN is required');
  }
  return token;
}

async function cmdPreflight(argv: ReadonlyArray<string>): Promise<void> {
  const expectedDatabase = requireFlag(argv, '--expected-database');
  const databaseUrl = resolveDatabaseUrl();
  const urlFacts = parseIsolatedOwnerBootstrapUrl(databaseUrl);
  assertIsolatedTelegramOwnerBootstrapTarget(urlFacts, expectedDatabase);
  const configuredTelegramUserId = resolveConfiguredTelegramUserId();

  const pool = createDatabasePool(databaseUrl);
  try {
    const live = await pool.query<{
      current_database: string;
      system_identifier: string;
    }>(
      `SELECT current_database() AS current_database,
              (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier`,
    );
    const row = live.rows[0];
    if (!row || row.current_database !== expectedDatabase) {
      throw new AuthDomainError('FORBIDDEN', 'live current_database mismatch');
    }
    const head = await pool.query<{ version: string }>(
      `SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1`,
    );
    const seat = await pool.query<{ holder: string | null }>(
      `SELECT holder_admin_user_id::text AS holder FROM admin_owner_authority WHERE seat = 1`,
    );
    const owners = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c
         FROM admin_role_bindings b
         JOIN admin_roles r ON r.id = b.role_id
        WHERE r.code = 'OWNER' AND b.revoked_at IS NULL`,
    );
    printJson({
      ok: true,
      command: 'preflight',
      trust_class: ISOLATED_TELEGRAM_OWNER_BOOTSTRAP_TARGET.trustClass,
      database: row.current_database,
      host: urlFacts.host,
      port: urlFacts.port,
      system_identifier: row.system_identifier,
      migration_head: head.rows[0]?.version ?? null,
      owner_seat_holder: seat.rows[0]?.holder ?? null,
      active_owners: owners.rows[0]?.c ?? 0,
      configured_owner_telegram_user_id: configuredTelegramUserId,
      target_match:
        row.current_database === ISOLATED_TELEGRAM_OWNER_BOOTSTRAP_TARGET.databaseName &&
        urlFacts.port === ISOLATED_TELEGRAM_OWNER_BOOTSTRAP_TARGET.port,
      writes: false,
      next: 'enroll (interactive TTY: initData + password)',
    });
  } finally {
    await pool.end();
  }
}

async function cmdEnroll(argv: ReadonlyArray<string>): Promise<void> {
  assertInteractiveSecretTerminals();
  const expectedDatabase = requireFlag(argv, '--expected-database');
  const email = requireFlag(argv, '--email');
  const databaseUrl = resolveDatabaseUrl();
  const urlFacts = parseIsolatedOwnerBootstrapUrl(databaseUrl);
  assertIsolatedTelegramOwnerBootstrapTarget(urlFacts, expectedDatabase);
  const configuredTelegramUserId = resolveConfiguredTelegramUserId();
  const botToken = resolveBotToken();

  console.error(
    'Paste Telegram Mini App initData for the configured Owner Telegram id (not echoed to JSON).',
  );
  console.error('Username in initData is display-only and never grants permissions.');
  const rawInitData = (await readSecretFromTty('initData (TTY): ')).trim();
  const password = await readSecretFromTty('password (TTY): ');
  const password2 = await readSecretFromTty('password confirm: ');
  if (password !== password2) {
    throw new AuthDomainError('VALIDATION', 'password confirmation mismatch');
  }

  const totpSecret = generateTotpSecretBytes();
  const totpCode = generateTotpCode(totpSecret);

  const pool = createDatabasePool(databaseUrl);
  try {
    const result = await enrollIsolatedTelegramOwner({
      pool,
      connectionString: databaseUrl,
      expectedDatabase,
      configuredOwnerTelegramUserId: configuredTelegramUserId,
      rawInitData,
      botToken,
      password,
      email,
      totpSecretBytes: totpSecret,
      totpConfirmCode: totpCode,
    });

    await displaySecretOnceOnInteractiveStderr({
      label: 'TOTP secret (base32) — record in authenticator now:',
      secret: bytesToBase32(totpSecret),
      warning:
        'TEST/isolated Owner TOTP secret. Never paste into chat, argv, env, or logs.',
    });
    await displaySecretOnceOnInteractiveStderr({
      label: 'otpauth URI:',
      secret: buildOtpAuthUri({
        secretBase32: bytesToBase32(totpSecret),
        accountName: email,
        issuer: 'ALEx-Rewards-Isolated',
      }),
      warning: 'Provisioning URI shown once on interactive stderr only.',
    });

    printJson({
      ok: true,
      command: 'enroll',
      trust_class: ISOLATED_TELEGRAM_OWNER_BOOTSTRAP_TARGET.trustClass,
      admin_user_id: result.adminUserId,
      telegram_user_id: result.telegramUserId,
      email: result.email,
      display_username: result.displayUsername,
      secrets_printed: false,
      database: expectedDatabase,
    });
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  forbidSecretFlags(argv);
  const command = argv[0];
  if (command !== 'preflight' && command !== 'enroll') usage();
  try {
    if (command === 'preflight') await cmdPreflight(argv);
    else await cmdEnroll(argv);
  } catch (err) {
    printJson({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      code: err instanceof AuthDomainError ? err.code : undefined,
    });
    process.exit(1);
  }
}

void main();
