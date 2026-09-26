#!/usr/bin/env node
/**
 * Isolated Option C Owner ceremony CLI (ephemeral TEST trust only).
 *
 * Prepares keypair + seal + dual-channel evidence, then can run the official
 * Option C sequence when ceremony evidence is complete.
 *
 * Never prints private keys, passwords, TOTP secrets, or recovery material.
 * Never use these keys for operational/production Owner enrollment.
 */
import { Client } from 'pg';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AuthDomainError } from '../errors.js';
import {
  assertCeremonyDirOutsideRepo,
  assertConnectionUrlAllowedForIsolatedCeremony,
  assertIsolatedCeremonyAllowsEnrollment,
  draftCeremonySeal,
  generateEphemeralCeremonyKeypairFiles,
  recordChannelBDigestFromOwner,
  resolveCeremonyDir,
  writeCeremonyPublicManifest,
  writeIsolatedCeremonyProfile,
  CEREMONY_CHANNEL_A_NAME,
  CEREMONY_PRIVATE_SEED_NAME,
  CEREMONY_PUBLIC_KEY_NAME,
  CEREMONY_SEAL_NAME,
} from '../owner-bootstrap/isolated-ceremony-gate.js';
import {
  ISOLATED_OWNER_CEREMONY_TARGET,
} from '../owner-bootstrap/isolated-ceremony-profile-v1.js';
import { digestCeremonySealV1 } from '../owner-bootstrap/ceremony-seal-v1.js';
import { runIsolatedOptionCEnrollment } from '../owner-bootstrap/isolated-ceremony-enroll.js';
import {
  assertInteractiveSecretTerminals,
  readLineFromTty,
  readSecretFromTty,
} from '../tty-secret.js';

function usage(code = 2): never {
  console.error(
    JSON.stringify(
      {
        ok: false,
        tool: 'owner-bootstrap-ceremony',
        trust_class: 'ephemeral_isolated_test_only',
        target: ISOLATED_OWNER_CEREMONY_TARGET,
        usage: [
          'owner-bootstrap-ceremony identity-check --expected-database <name>',
          'owner-bootstrap-ceremony generate-keypair --ceremony-dir <path> [--key-id <id>]',
          'owner-bootstrap-ceremony write-profile --ceremony-dir <path> --expected-database <name> --expected-port <port> [--system-identifier <sid>] [--profile-id <id>]',
          'owner-bootstrap-ceremony draft-seal --ceremony-dir <path>',
          'owner-bootstrap-ceremony record-channel-b --ceremony-dir <path>',
          'owner-bootstrap-ceremony validate --ceremony-dir <path>',
          'owner-bootstrap-ceremony enroll --ceremony-dir <path> --expected-database <name> --email <email>',
        ],
        secrets:
          'TTY-only for password/TOTP; private seed written only to ceremony-dir file (never stdout)',
        refuse:
          'port 55432, alex_rewards, non-loopback hosts, missing witnesses, missing Channel B, placeholder attestations',
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
      arg === '--totp' ||
      arg.startsWith('--totp=') ||
      arg === '--private-key' ||
      arg.startsWith('--private-key=')
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
  const explicit =
    process.env.OWNER_BOOTSTRAP_CEREMONY_DATABASE_URL?.trim() ||
    process.env.OWNER_ADMIN_AUTH_DATABASE_URL?.trim();
  if (explicit) return explicit;
  const ambient = process.env.DATABASE_URL?.trim();
  if (ambient) return ambient;
  console.error(JSON.stringify({ ok: false, error: 'DATABASE_URL is required' }));
  process.exit(1);
}

async function cmdIdentityCheck(argv: ReadonlyArray<string>): Promise<void> {
  const expectedDatabase = requireFlag(argv, '--expected-database');
  const databaseUrl = resolveDatabaseUrl();
  const urlFacts = assertConnectionUrlAllowedForIsolatedCeremony(databaseUrl);
  if (urlFacts.database !== expectedDatabase) {
    throw new AuthDomainError(
      'FORBIDDEN',
      `cross-DB rejection: connected URL db ${urlFacts.database} != expected ${expectedDatabase}`,
    );
  }
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const db = await client.query<{
      current_database: string;
      system_identifier: string;
    }>(
      `SELECT current_database() AS current_database,
              (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier`,
    );
    const live = db.rows[0];
    if (!live || live.current_database !== expectedDatabase) {
      throw new AuthDomainError('FORBIDDEN', 'live current_database mismatch');
    }
    const mig = await client.query<{ version: string }>(
      `SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1`,
    );
    const head = mig.rows[0]?.version ?? '';
    const seat = await client.query<{ holder: string | null }>(
      `SELECT holder_admin_user_id::text AS holder FROM admin_owner_authority WHERE seat = 1`,
    );
    const activeOwners = await client.query<{ c: number }>(
      `SELECT count(*)::int AS c
         FROM admin_role_bindings b
         JOIN admin_roles r ON r.id = b.role_id
        WHERE r.code = 'OWNER' AND b.revoked_at IS NULL`,
    );
    printJson({
      ok: true,
      command: 'identity-check',
      database: live.current_database,
      host: urlFacts.host,
      port: urlFacts.port,
      system_identifier: live.system_identifier,
      migration_head: head,
      migration_head_ok: head.startsWith(
        ISOLATED_OWNER_CEREMONY_TARGET.expectedMigrationHeadPrefix,
      ),
      owner_seat_holder: seat.rows[0]?.holder ?? null,
      active_owners: activeOwners.rows[0]?.c ?? 0,
      target_match:
        live.current_database === ISOLATED_OWNER_CEREMONY_TARGET.databaseName &&
        urlFacts.port === ISOLATED_OWNER_CEREMONY_TARGET.port,
      trust_class: 'ephemeral_isolated_test_only',
      writes: false,
    });
  } finally {
    await client.end();
  }
}

async function cmdGenerateKeypair(argv: ReadonlyArray<string>): Promise<void> {
  const ceremonyDir = resolveCeremonyDir(requireFlag(argv, '--ceremony-dir'));
  const repoRoot = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
  assertCeremonyDirOutsideRepo(ceremonyDir, repoRoot);
  const keyId =
    readFlag(argv, '--key-id')?.trim() ||
    `isolated-ephemeral-${ISOLATED_OWNER_CEREMONY_TARGET.databaseName}`;
  const pub = generateEphemeralCeremonyKeypairFiles({ ceremonyDir, keyId });
  writeCeremonyPublicManifest(ceremonyDir);
  printJson({
    ok: true,
    command: 'generate-keypair',
    trust_class: pub.trust_class,
    key_id: pub.key_id,
    public_key_sha256_hex: pub.public_key_sha256_hex,
    public_key_file: CEREMONY_PUBLIC_KEY_NAME,
    private_seed_file: CEREMONY_PRIVATE_SEED_NAME,
    private_seed_printed: false,
    warning: pub.warning,
    ceremony_dir: ceremonyDir,
  });
}

async function cmdWriteProfile(argv: ReadonlyArray<string>): Promise<void> {
  const ceremonyDir = resolveCeremonyDir(requireFlag(argv, '--ceremony-dir'));
  const expectedDatabase = requireFlag(argv, '--expected-database');
  const portRaw = requireFlag(argv, '--expected-port');
  const expectedPort = Number(portRaw);
  if (!Number.isInteger(expectedPort)) usage();
  const profileId =
    readFlag(argv, '--profile-id')?.trim() || ISOLATED_OWNER_CEREMONY_TARGET.profileId;
  const sid = readFlag(argv, '--system-identifier')?.trim();
  const profile = writeIsolatedCeremonyProfile({
    ceremonyDir,
    expectedDatabaseName: expectedDatabase,
    expectedPort,
    profileId,
    ...(sid !== undefined && sid !== '' ? { expectedSystemIdentifier: sid } : {}),
  });
  const manifest = writeCeremonyPublicManifest(ceremonyDir);
  printJson({
    ok: true,
    command: 'write-profile',
    profile_id: profile.profile_id,
    expected_database_name: profile.expected_database_name,
    expected_port: profile.expected_port,
    profile_digest_hex: manifest.profile_digest_hex,
    trust_class: profile.trust_class,
  });
}

async function cmdDraftSeal(argv: ReadonlyArray<string>): Promise<void> {
  assertInteractiveSecretTerminals();
  const ceremonyDir = resolveCeremonyDir(requireFlag(argv, '--ceremony-dir'));
  console.error(
    'Enter ceremony authorizer and at least one independent witness. Do not invent witnesses.',
  );
  const authorizer = (await readLineFromTty('authorizer_display_name: ')).trim();
  const witnessName = (await readLineFromTty('witness[0].display_name: ')).trim();
  const attestationRef = (await readLineFromTty('witness[0].attestation_ref: ')).trim();
  const seal = draftCeremonySeal({
    ceremonyDir,
    authorizerDisplayName: authorizer,
    witnesses: [
      {
        display_name: witnessName,
        role: 'independent_witness',
        attestation_ref: attestationRef,
      },
    ],
  });
  const digest = digestCeremonySealV1(seal);
  writeCeremonyPublicManifest(ceremonyDir);
  printJson({
    ok: true,
    command: 'draft-seal',
    ceremony_id: seal.ceremony_id,
    ceremony_time_unix: seal.ceremony_time_unix,
    key_id: seal.key_id,
    public_key_sha256_hex: seal.public_key_sha256_hex,
    endpoint_profile_id: seal.endpoint_profile_id,
    profile_digest_hex: seal.profile_digest_hex,
    seal_content_digest_hex: digest,
    seal_file: CEREMONY_SEAL_NAME,
    channel_a_file: CEREMONY_CHANNEL_A_NAME,
    next:
      'Copy seal_content_digest_hex to offline paper (Channel B), then run record-channel-b',
  });
  console.error(
    `\nOFFLINE PAPER (Channel B): write this digest on paper, then type it back with record-channel-b:\n${digest}\n`,
  );
}

async function cmdRecordChannelB(argv: ReadonlyArray<string>): Promise<void> {
  assertInteractiveSecretTerminals();
  const ceremonyDir = resolveCeremonyDir(requireFlag(argv, '--ceremony-dir'));
  const claimedPath = readFlag(argv, '--claimed-channel-b-file');
  console.error(
    'Type the seal content digest from your offline paper (Channel B). A same-host file is refused.',
  );
  const digest = (await readLineFromTty('channel_b_seal_content_digest_hex: ')).trim();
  const record = recordChannelBDigestFromOwner({
    ceremonyDir,
    digestHexFromOwner: digest,
    ...(claimedPath !== undefined ? { claimedChannelBPath: claimedPath } : {}),
  });
  const manifest = writeCeremonyPublicManifest(ceremonyDir);
  printJson({
    ok: true,
    command: 'record-channel-b',
    recorded_via: record.recorded_via,
    seal_content_digest_hex: record.seal_content_digest_hex,
    enrollment_allowed: manifest.enrollment_allowed,
  });
}

async function cmdValidate(argv: ReadonlyArray<string>): Promise<void> {
  const ceremonyDir = resolveCeremonyDir(requireFlag(argv, '--ceremony-dir'));
  try {
    const gated = assertIsolatedCeremonyAllowsEnrollment(ceremonyDir);
    const manifest = writeCeremonyPublicManifest(ceremonyDir);
    printJson({
      ok: true,
      command: 'validate',
      enrollment_allowed: true,
      ceremony_id: gated.seal.ceremony_id,
      key_id: gated.authorityPublic.key_id,
      public_key_sha256_hex: gated.authorityPublic.public_key_sha256_hex,
      expected_database_name: gated.profile.expected_database_name,
      expected_port: gated.profile.expected_port,
      seal_content_digest_hex: gated.sealContentDigestHex,
      provenance_authenticated: false,
      manifest,
    });
  } catch (err) {
    const manifest = writeCeremonyPublicManifest(ceremonyDir);
    printJson({
      ok: false,
      command: 'validate',
      enrollment_allowed: false,
      error: err instanceof Error ? err.message : String(err),
      manifest,
    });
    process.exitCode = 1;
  }
}

async function cmdEnroll(argv: ReadonlyArray<string>): Promise<void> {
  assertInteractiveSecretTerminals();
  const ceremonyDir = resolveCeremonyDir(requireFlag(argv, '--ceremony-dir'));
  const expectedDatabase = requireFlag(argv, '--expected-database');
  const email = requireFlag(argv, '--email');
  // Gate first — refuse before prompting for password if evidence incomplete.
  assertIsolatedCeremonyAllowsEnrollment(ceremonyDir);
  const databaseUrl = resolveDatabaseUrl();
  const urlFacts = assertConnectionUrlAllowedForIsolatedCeremony(databaseUrl);
  if (urlFacts.database !== expectedDatabase) {
    throw new AuthDomainError('FORBIDDEN', 'cross-DB rejection before enroll');
  }
  console.error(
    'Enroll uses the official Option C sequence. Password/TOTP entered on TTY only. TEST trust keys only.',
  );
  const subjectDisplay = (
    await readLineFromTty('subject_display (Owner label): ')
  ).trim();
  const password = await readSecretFromTty('password (TTY, not echoed): ');
  const password2 = await readSecretFromTty('password confirm: ');
  if (password !== password2) {
    throw new AuthDomainError('VALIDATION', 'password confirmation mismatch');
  }
  const enrolled = await runIsolatedOptionCEnrollment({
    ceremonyDir,
    connectionString: databaseUrl,
    expectedDatabase,
    intendedAdminEmail: email,
    subjectDisplay,
    password,
  });
  try {
    printJson({
      ok: true,
      command: 'enroll',
      trust_class: 'ephemeral_isolated_test_only',
      admin_user_id: enrolled.result.adminUserId,
      email: enrolled.result.email,
      database: expectedDatabase,
      secrets_printed: false,
    });
  } finally {
    await enrolled.close();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  forbidSecretFlags(argv);
  const command = argv[0];
  if (
    command !== 'identity-check' &&
    command !== 'generate-keypair' &&
    command !== 'write-profile' &&
    command !== 'draft-seal' &&
    command !== 'record-channel-b' &&
    command !== 'validate' &&
    command !== 'enroll'
  ) {
    usage();
  }

  try {
    if (command === 'identity-check') await cmdIdentityCheck(argv);
    else if (command === 'generate-keypair') await cmdGenerateKeypair(argv);
    else if (command === 'write-profile') await cmdWriteProfile(argv);
    else if (command === 'draft-seal') await cmdDraftSeal(argv);
    else if (command === 'record-channel-b') await cmdRecordChannelB(argv);
    else if (command === 'validate') await cmdValidate(argv);
    else if (command === 'enroll') await cmdEnroll(argv);
  } catch (err) {
    printJson({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      code: err instanceof AuthDomainError ? err.code : undefined,
      ceremony_hint: resolve(
        process.cwd(),
        readFlag(argv, '--ceremony-dir') ?? '<ceremony-dir>',
      ),
    });
    process.exit(1);
  }
}

void main();
