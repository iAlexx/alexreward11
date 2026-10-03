#!/usr/bin/env node
/**
 * Production Owner-bootstrap ceremony CLI (Phase 21 Step 4B / 4B.1).
 * run/enroll-existing require exactly one of --preflight-only (unauthenticated read-only),
 * --authenticated-preflight-only (live Owner TTY digest, read-only) or gated --apply.
 * Does NOT weaken owner-bootstrap-ceremony (isolated-only).
 * DO NOT reuse Hot Wallet keys. DO NOT accept secrets via argv/env.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { stdin as stdinFd, stdout as stdoutFd } from 'node:process';

import {
  type AuthenticatedProductionCeremonySession,
  assertCeremonyDirOutsideRepo,
  assertProductionProfileRequiresSystemIdentifier,
  authenticateProductionCeremonyFromOwnerTty,
  buildProductionOwnerBootstrapReadinessReport,
  createProductionOwnerBootstrapPool,
  draftProductionCeremonySeal,
  generateProductionBootstrapKeypairFiles,
  loadEncryptedOwnerBootstrapKeyBundle,
  loadIntendedExistingAdminBinding,
  loadProductionEndpointProfile,
  loadProductionPublicKey,
  missingProductionTrustResources,
  orchestrateProductionOwnerBootstrapCeremony,
  hydrateIntendedExistingAdminBindingFromDatabase,
  recordProductionChannelBDigest,
  resolvePublicProxyDialIps,
  runAuthenticatedProductionOwnerBootstrapPreflightOnly,
  runProductionOwnerBootstrapPreflightOnly,
  writeIntendedExistingAdminBinding,
  writeProductionEndpointProfile,
  validateProductionCeremonyBundleStructurally,
  PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS,
  validateCeremonyEndpointProfileV1,
  assertProductionCeremonyApplyGates,
} from '../owner-bootstrap/index.js';

function usage(): never {
  console.error(
    JSON.stringify({
      ok: false,
      tool: 'owner-production-bootstrap',
      trust_class: PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS,
      message:
        'usage: owner-production-bootstrap <preflight|generate-keypair|write-profile|write-intended-admin|hydrate-intended-admin|draft-seal|record-channel-b|validate|readiness|enroll-existing|run|verify> ...',
      notes: [
        'run/enroll-existing: pass exactly one of --preflight-only | --authenticated-preflight-only | --apply',
        'DB password: set OWNER_PRODUCTION_BOOTSTRAP_DB_PASSWORD in shell (never argv/chat)',
        'Hot Wallet keys must never be reused',
        'secrets: interactive TTY only (never --password/--totp/--bootstrap-passphrase)',
      ],
    }),
  );
  process.exit(2);
}

function argValue(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  return argv[i + 1] ?? null;
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function envTrue(name: string): boolean {
  const v = process.env[name];
  return v === '1' || v?.toLowerCase() === 'true';
}

function assertNoSecretArgv(argv: string[]): void {
  const forbidden = [
    '--password',
    '--totp',
    '--bootstrap-private-key',
    '--bootstrap-passphrase',
    '--passphrase',
  ];
  for (const a of argv) {
    for (const f of forbidden) {
      if (a === f || a.startsWith(`${f}=`)) {
        console.error(
          JSON.stringify({
            ok: false,
            refuseCode: 'SECRET_ARGV_FORBIDDEN',
            message: 'password/TOTP/passphrase via argv forbidden — interactive TTY only',
          }),
        );
        process.exit(1);
      }
    }
  }
  if (
    process.env.PASSWORD ||
    process.env.TOTP ||
    process.env.OWNER_BOOTSTRAP_PASSWORD ||
    process.env.OWNER_BOOTSTRAP_PASSPHRASE
  ) {
    console.error(
      JSON.stringify({
        ok: false,
        refuseCode: 'SECRET_ENV_FORBIDDEN',
        message: 'password/TOTP/passphrase via env forbidden',
      }),
    );
    process.exit(1);
  }
}

async function readLine(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error('INTERACTIVE_TTY_REQUIRED');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolvePromise) => {
    rl.question(prompt, (v) => {
      rl.close();
      resolvePromise(v);
    });
  });
  return answer.trim();
}

async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('INTERACTIVE_TTY_REQUIRED');
  }
  // Best-effort no-echo on POSIX; Windows may still echo — never log the value.
  const stdin = stdinFd;
  const wasRaw = stdin.isRaw;
  try {
    if (typeof stdin.setRawMode === 'function') {
      stdin.setRawMode(true);
    }
  } catch {
    // ignore
  }
  process.stdout.write(prompt);
  let value = '';
  await new Promise<void>((resolvePromise, reject) => {
    const onData = (chunk: Buffer) => {
      const s = chunk.toString('utf8');
      for (const ch of s) {
        if (ch === '\n' || ch === '\r') {
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolvePromise();
          return;
        }
        if (ch === '\u0003') {
          stdin.off('data', onData);
          reject(new Error('interrupted'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
  try {
    if (typeof stdin.setRawMode === 'function') {
      stdin.setRawMode(wasRaw ?? false);
    }
  } catch {
    // ignore
  }
  void stdoutFd;
  return value;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function maskEmail(email: string | null | undefined): string | null {
  if (email === null || email === undefined || email.trim() === '') return null;
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const maskedLocal = local.length <= 1 ? '*' : `${local[0]}***`;
  return `${maskedLocal}@${domain}`;
}

function parsePort(value: string | null, envName: string): number {
  const raw = value ?? process.env[envName] ?? '';
  const port = Number.parseInt(raw, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid port — pass --proxy-port or set ${envName}`);
  }
  return port;
}

function resolveDbPassword(): string {
  const password =
    process.env.OWNER_PRODUCTION_BOOTSTRAP_DB_PASSWORD ??
    process.env.OWNER_BOOTSTRAP_DATABASE_PASSWORD ??
    process.env.PGPASSWORD ??
    '';
  if (password.trim() === '') {
    throw new Error(
      'OWNER_PRODUCTION_BOOTSTRAP_DB_PASSWORD must be set in your shell for preflight/apply (never argv or chat)',
    );
  }
  return password;
}

function resolveDbUser(argv: string[]): string {
  const fromArg = argValue(argv, '--user');
  const user = fromArg ?? process.env.PGUSER ?? process.env.OWNER_PRODUCTION_BOOTSTRAP_DB_USER ?? '';
  if (user.trim() === '') {
    throw new Error('DB user required — pass --user or set PGUSER in shell');
  }
  return user.trim();
}

async function buildProductionConnectionString(input: {
  readonly proxyHost: string;
  readonly proxyPort: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
}): Promise<string> {
  const dialIps = await resolvePublicProxyDialIps(input.proxyHost);
  const dialIp = dialIps[0];
  if (dialIp === undefined) {
    throw new Error('no public dial IP resolved for proxy host');
  }
  const userEnc = encodeURIComponent(input.user);
  const passEnc = encodeURIComponent(input.password);
  return `postgresql://${userEnc}:${passEnc}@${dialIp}:${input.proxyPort}/${encodeURIComponent(input.database)}`;
}

function loadCaPemFromFile(caFile: string): string {
  return readFileSync(resolve(caFile), 'utf8');
}

function findEncryptedKeyBundlePath(ceremonyDir: string): string {
  const dir = resolve(ceremonyDir);
  const enc = readdirSync(dir).find((f) => f.endsWith('.enc'));
  if (enc === undefined) {
    throw new Error('encrypted Owner bootstrap key bundle (.enc) not found in ceremony dir');
  }
  return resolve(dir, enc);
}

async function runPreflightOnlyCommand(argv: string[]): Promise<void> {
  if (envTrue('OWNER_PRODUCTION_BOOTSTRAP_APPLY')) {
    printJson({
      ok: false,
      refuseCode: 'OWNER_PRODUCTION_BOOTSTRAP_APPLY_SET',
      message:
        'OWNER_PRODUCTION_BOOTSTRAP_APPLY is enabled — unset before read-only preflight in Step4B',
    });
    process.exitCode = 1;
    return;
  }

  const proxyHost = argValue(argv, '--proxy-host') ?? process.env.RAILWAY_TCP_PROXY_DOMAIN ?? '';
  if (proxyHost.trim() === '') {
    printJson({
      ok: false,
      refuseCode: 'PROXY_HOST_REQUIRED',
      message: 'pass --proxy-host or set RAILWAY_TCP_PROXY_DOMAIN',
    });
    process.exitCode = 1;
    return;
  }

  let proxyPort: number;
  let dbUser: string;
  let dbPassword: string;
  try {
    proxyPort = parsePort(argValue(argv, '--proxy-port'), 'RAILWAY_TCP_PROXY_PORT');
    dbUser = resolveDbUser(argv);
    dbPassword = resolveDbPassword();
  } catch (error: unknown) {
    printJson({
      ok: false,
      refuseCode: 'PREFLIGHT_PARAMS_INVALID',
      message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
    return;
  }

  const database =
    argValue(argv, '--database') ??
    process.env.PGDATABASE ??
    process.env.OWNER_PRODUCTION_BOOTSTRAP_DB_NAME ??
    'railway';
  const tlsServerName =
    argValue(argv, '--tls-server-name') ??
    process.env.OWNER_PRODUCTION_BOOTSTRAP_TLS_SERVER_NAME ??
    'postgres.railway.internal';
  const adminUserId =
    argValue(argv, '--admin-user-id') ?? 'a11a11a1-0000-4000-8000-000000000011';
  const caFile = argValue(argv, '--ca-file');
  if (caFile === null || caFile.trim() === '') {
    printJson({
      ok: false,
      refuseCode: 'CA_FILE_REQUIRED',
      message: 'pass --ca-file pointing to Owner-approved root.crt outside repo',
    });
    process.exitCode = 1;
    return;
  }

  let caPem: string;
  try {
    caPem = loadCaPemFromFile(caFile);
  } catch (error: unknown) {
    printJson({
      ok: false,
      refuseCode: 'CA_FILE_UNREADABLE',
      message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
    return;
  }

  let expectedSystemIdentifier: string | undefined;
  const ceremonyDir = argValue(argv, '--ceremony-dir');
  if (ceremonyDir !== null) {
    try {
      const profile = loadProductionEndpointProfile(ceremonyDir);
      expectedSystemIdentifier = profile.expected_system_identifier ?? undefined;
    } catch {
      // ceremony profile optional for endpoint-only preflight
    }
  }

  let intendedAdminEmail: string | undefined;
  if (ceremonyDir !== null) {
    try {
      intendedAdminEmail = loadIntendedExistingAdminBinding(ceremonyDir).intended_admin_email;
    } catch {
      // optional
    }
  }

  const ownerKeyOfflineBackupsReady = false;

  try {
    const result = await runProductionOwnerBootstrapPreflightOnly({
      endpoint: {
        proxyHostname: proxyHost,
        proxyPort,
        databaseName: database,
        user: dbUser,
        password: dbPassword,
        caPem,
        tlsServerName,
        ...(expectedSystemIdentifier !== undefined
          ? { expectedSystemIdentifier }
          : {}),
      },
      intendedAdminUserId: adminUserId,
      ...(intendedAdminEmail !== undefined ? { intendedAdminEmail } : {}),
      ownerKeyOfflineBackupsReady,
    });
    printJson({
      ok: result.refuseCode === null,
      command: 'preflight-only',
      authenticated: false,
      trust_class: PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS,
      forceApply: false,
      applyDefault: false,
      operationalDbMutation: false,
      intendedAdminEmailMasked: maskEmail(intendedAdminEmail ?? null),
      result,
    });
    if (result.refuseCode !== null) process.exitCode = 1;
  } catch (error: unknown) {
    printJson({
      ok: false,
      command: 'preflight-only',
      refuseCode: 'PREFLIGHT_FAILED',
      message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
}

async function runApplyCommand(argv: string[], command: string): Promise<void> {
  const ceremonyDir = argValue(argv, '--ceremony-dir');
  if (ceremonyDir === null) {
    printJson({
      ok: false,
      refuseCode: 'CEREMONY_DIR_REQUIRED',
      message: '--ceremony-dir required for --apply',
    });
    process.exitCode = 1;
    return;
  }

  try {
    assertProductionCeremonyApplyGates({
      apply: true,
      deploymentEnvIsProduction: process.env.DEPLOYMENT_ENV === 'production',
      ownerProductionBootstrapEnabled: envTrue('OWNER_PRODUCTION_BOOTSTRAP_ENABLED'),
      ownerProductionBootstrapApply: envTrue('OWNER_PRODUCTION_BOOTSTRAP_APPLY'),
    });
  } catch (error: unknown) {
    printJson({
      ok: false,
      command,
      refuseCode: 'APPLY_GATES_REQUIRED',
      message: error instanceof Error ? error.message : String(error),
      required:
        'DEPLOYMENT_ENV=production + OWNER_PRODUCTION_BOOTSTRAP_ENABLED=true + OWNER_PRODUCTION_BOOTSTRAP_APPLY=1 + --apply',
      forceApply: false,
    });
    process.exitCode = 1;
    return;
  }

  const proxyHost = argValue(argv, '--proxy-host') ?? process.env.RAILWAY_TCP_PROXY_DOMAIN ?? '';
  if (proxyHost.trim() === '') {
    printJson({
      ok: false,
      refuseCode: 'PROXY_HOST_REQUIRED',
      message: 'pass --proxy-host or set RAILWAY_TCP_PROXY_DOMAIN',
    });
    process.exitCode = 1;
    return;
  }

  let proxyPort: number;
  let dbUser: string;
  let dbPassword: string;
  let connectionString: string;
  try {
    proxyPort = parsePort(argValue(argv, '--proxy-port'), 'RAILWAY_TCP_PROXY_PORT');
    dbUser = resolveDbUser(argv);
    dbPassword = resolveDbPassword();
    connectionString = await buildProductionConnectionString({
      proxyHost,
      proxyPort,
      database:
        argValue(argv, '--database') ??
        process.env.PGDATABASE ??
        process.env.OWNER_PRODUCTION_BOOTSTRAP_DB_NAME ??
        'railway',
      user: dbUser,
      password: dbPassword,
    });
  } catch (error: unknown) {
    printJson({
      ok: false,
      refuseCode: 'APPLY_PARAMS_INVALID',
      message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
    return;
  }

  let session: AuthenticatedProductionCeremonySession | null = null;
  try {
    const pub = loadProductionPublicKey(ceremonyDir);
    const encryptedBundle = loadEncryptedOwnerBootstrapKeyBundle(
      findEncryptedKeyBundlePath(ceremonyDir),
    );

    session = await authenticateProductionCeremonyFromOwnerTty({
      ceremonyDir,
      connectionString,
      pinnedPublicKeyRawHex: pub.public_key_raw_hex,
      readOfflineBundleDigestHex: () =>
        readLine('Type production bundle digest from offline/witnessed media (64 hex): '),
    });

    const bootstrapPassphrase = await readSecret(
      'Owner bootstrap passphrase (encrypted key, not echoed): ',
    );
    const password = await readSecret('New Owner admin password (not echoed): ');
    const passwordConfirm = await readSecret('Confirm Owner admin password: ');

    const result = await orchestrateProductionOwnerBootstrapCeremony({
      pool: session.verifiedPool.pool,
      productionTrust: session.productionTrust,
      encryptedKeyBundle: encryptedBundle,
      bootstrapPassphrase,
      password,
      passwordConfirm,
      apply: true,
      deploymentEnvIsProduction: true,
      ownerProductionBootstrapEnabled: true,
      ownerProductionBootstrapApply: true,
    });

    printJson({
      ok: true,
      command,
      trust_class: PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS,
      applied: true,
      forceApply: false,
      adminUserId: result.adminUserId,
      emailMasked: maskEmail(result.email),
      grantId: result.grantId,
      attemptId: result.attemptId,
    });
  } catch (error: unknown) {
    printJson({
      ok: false,
      command,
      refuseCode: 'APPLY_FAILED',
      message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  } finally {
    await session?.close();
  }
}

async function runAuthenticatedPreflightOnlyCommand(argv: string[], command: string): Promise<void> {
  const fail = (refuseCode: string, message: string): void => {
    printJson({
      ok: false,
      command,
      mode: 'authenticated-preflight-only',
      refuseCode,
      message,
      operationalDbMutation: false,
    });
    process.exitCode = 1;
  };

  if (envTrue('OWNER_PRODUCTION_BOOTSTRAP_APPLY')) {
    fail(
      'OWNER_PRODUCTION_BOOTSTRAP_APPLY_SET',
      'OWNER_PRODUCTION_BOOTSTRAP_APPLY is enabled - unset before read-only authenticated preflight',
    );
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail('INTERACTIVE_TTY_REQUIRED', 'authenticated preflight requires a real interactive TTY');
    return;
  }
  const profileOnlyOverrides = [
    '--ca-file',
    '--tls-server-name',
    '--database',
    '--admin-user-id',
    '--email',
    '--system-identifier',
  ].filter((flag) => argv.includes(flag));
  if (profileOnlyOverrides.length > 0) {
    fail(
      'PROFILE_ONLY_PARAMETER',
      `CA / tls_server_name / database / system_identifier / intended admin come from the ceremony dir only; remove: ${profileOnlyOverrides.join(', ')}`,
    );
    return;
  }
  const ceremonyDir = argValue(argv, '--ceremony-dir');
  if (ceremonyDir === null || ceremonyDir.trim() === '') {
    fail('CEREMONY_DIR_REQUIRED', '--ceremony-dir required for --authenticated-preflight-only');
    return;
  }
  const proxyHost = argValue(argv, '--proxy-host') ?? process.env.RAILWAY_TCP_PROXY_DOMAIN ?? '';
  if (proxyHost.trim() === '') {
    fail('PROXY_HOST_REQUIRED', 'pass --proxy-host or set RAILWAY_TCP_PROXY_DOMAIN');
    return;
  }

  let session: AuthenticatedProductionCeremonySession | null = null;
  try {
    const proxyPort = parsePort(argValue(argv, '--proxy-port'), 'RAILWAY_TCP_PROXY_PORT');
    const dbUser = resolveDbUser(argv);
    const dbPassword = resolveDbPassword();
    const pub = loadProductionPublicKey(ceremonyDir);
    const profile = loadProductionEndpointProfile(ceremonyDir);
    const connectionString = await buildProductionConnectionString({
      proxyHost,
      proxyPort,
      database: profile.expected_database_name,
      user: dbUser,
      password: dbPassword,
    });

    session = await authenticateProductionCeremonyFromOwnerTty({
      ceremonyDir,
      connectionString,
      pinnedPublicKeyRawHex: pub.public_key_raw_hex,
      readOfflineBundleDigestHex: () =>
        readLine('Type production bundle digest from offline/witnessed media (64 hex): '),
    });

    const result = await runAuthenticatedProductionOwnerBootstrapPreflightOnly({
      productionTrust: session.productionTrust,
      pool: session.verifiedPool.pool,
      ownerKeyOfflineBackupsReady: false,
    });
    printJson({
      ok: result.refuseCode === null,
      command,
      mode: 'authenticated-preflight-only',
      authenticated: true,
      trust_class: PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS,
      forceApply: false,
      applyDefault: false,
      operationalDbMutation: false,
      intendedAdminEmailMasked: maskEmail(session.productionTrust.intendedAdminEmail),
      result,
    });
    if (result.refuseCode !== null) process.exitCode = 1;
  } catch (error: unknown) {
    fail('AUTHENTICATED_PREFLIGHT_FAILED', error instanceof Error ? error.message : String(error));
  } finally {
    await session?.close();
  }
}

async function runHydrateIntendedAdminCommand(argv: string[]): Promise<void> {
  const command = 'hydrate-intended-admin';
  const fail = (refuseCode: string, message: string): void => {
    printJson({ ok: false, command, refuseCode, message, operationalDbMutation: false });
    process.exitCode = 1;
  };
  if (envTrue('OWNER_PRODUCTION_BOOTSTRAP_APPLY')) {
    fail('OWNER_PRODUCTION_BOOTSTRAP_APPLY_SET', 'unset OWNER_PRODUCTION_BOOTSTRAP_APPLY first');
    return;
  }
  const ceremonyDir = argValue(argv, '--ceremony-dir');
  if (ceremonyDir === null || ceremonyDir.trim() === '') {
    fail('CEREMONY_DIR_REQUIRED', '--ceremony-dir required');
    return;
  }
  const proxyHost = argValue(argv, '--proxy-host') ?? process.env.RAILWAY_TCP_PROXY_DOMAIN ?? '';
  if (proxyHost.trim() === '') {
    fail('PROXY_HOST_REQUIRED', 'pass --proxy-host or set RAILWAY_TCP_PROXY_DOMAIN');
    return;
  }

  let bootstrap: Awaited<ReturnType<typeof createProductionOwnerBootstrapPool>> | null = null;
  try {
    const proxyPort = parsePort(argValue(argv, '--proxy-port'), 'RAILWAY_TCP_PROXY_PORT');
    const dbUser = resolveDbUser(argv);
    const dbPassword = resolveDbPassword();
    const profile = loadProductionEndpointProfile(ceremonyDir);
    const connectionString = await buildProductionConnectionString({
      proxyHost,
      proxyPort,
      database: profile.expected_database_name,
      user: dbUser,
      password: dbPassword,
    });
    bootstrap = await createProductionOwnerBootstrapPool({
      connectionString,
      profile: {
        profileId: profile.profile_id,
        deploymentEnv: 'production',
        expectedDatabaseName: profile.expected_database_name,
        expectedSystemIdentifier: profile.expected_system_identifier!,
        tls: {
          mode: 'verify_full',
          caPem: profile.tls.ca_pem,
          tlsServerName: profile.tls.tls_server_name,
        },
      },
    });
    const adminUserId = argValue(argv, '--admin-user-id');
    const hydrated = await hydrateIntendedExistingAdminBindingFromDatabase({
      ceremonyDir,
      bootstrap,
      ...(adminUserId !== null ? { intendedAdminUserId: adminUserId } : {}),
    });
    printJson({
      ok: true,
      command,
      operationalDbMutation: false,
      adminUserId: hydrated.adminUserId,
      adminStatus: hydrated.adminStatus,
      emailMasked: hydrated.emailMasked,
      bindingWritten: hydrated.bindingWritten,
      bundleMatchesBinding: hydrated.bundleMatchesBinding,
      authority: false,
    });
  } catch (error: unknown) {
    fail('HYDRATE_FAILED', error instanceof Error ? error.message : String(error));
  } finally {
    await bootstrap?.pool.end().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  assertNoSecretArgv(argv);
  const command = argv[0];
  if (command === undefined) usage();

  if (command === 'readiness' || command === 'preflight') {
    const ceremonyDir = argValue(argv, '--ceremony-dir');
    const report = buildProductionOwnerBootstrapReadinessReport({
      ceremonyDir,
    });
    printJson({
      ok: true,
      command,
      trust_class: PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS,
      report,
      missing: missingProductionTrustResources(ceremonyDir),
      applyDefault: false,
      forceApply: false,
      readyForLivePayout: false,
    });
    return;
  }

  if (command === 'generate-keypair') {
    const ceremonyDir = argValue(argv, '--ceremony-dir');
    const keyId = argValue(argv, '--key-id') ?? `owner-bootstrap-${Date.now()}`;
    const repoRoot = argValue(argv, '--repo-root') ?? resolve(process.cwd(), '../../..');
    if (ceremonyDir === null) usage();
    if (!hasFlag(argv, '--phase21-production-owner-bootstrap')) {
      printJson({
        ok: false,
        refuseCode: 'PRODUCTION_CEREMONY_FLAG_REQUIRED',
        message: 'pass --phase21-production-owner-bootstrap explicitly',
      });
      process.exitCode = 1;
      return;
    }
    assertCeremonyDirOutsideRepo(ceremonyDir, repoRoot);
    const passphrase = await readSecret('Owner bootstrap passphrase (min 16, not echoed): ');
    const passphraseConfirm = await readSecret('Confirm passphrase: ');
    const pub = generateProductionBootstrapKeypairFiles({
      ceremonyDir,
      keyId,
      phase21ProductionOwnerBootstrap: true,
      requireInteractiveTty: true,
      passphrase,
      passphraseConfirm,
      repoRootHint: repoRoot,
    });
    printJson({
      ok: true,
      command,
      trust_class: pub.trust_class,
      key_id: pub.key_id,
      public_key_sha256_hex: pub.public_key_sha256_hex,
      encrypted_bundle_path_basename: pub.encrypted_bundle_path_basename,
      ciphertext_sha256_hex: pub.ciphertext_sha256_hex,
      warning: pub.warning,
      private_bytes_emitted: false,
      plaintext_seed_file: false,
      backups_required: 'at least 2 encrypted offline backups; passphrase stored separately',
    });
    return;
  }

  if (command === 'write-profile') {
    const ceremonyDir = argValue(argv, '--ceremony-dir');
    const profilePath = argValue(argv, '--profile-json');
    if (ceremonyDir === null || profilePath === null) usage();
    const { readFileSync } = await import('node:fs');
    const raw = JSON.parse(readFileSync(profilePath, 'utf8'));
    const profile = assertProductionProfileRequiresSystemIdentifier(
      validateCeremonyEndpointProfileV1(raw),
    );
    writeProductionEndpointProfile(ceremonyDir, profile);
    printJson({
      ok: true,
      command,
      profile_id: profile.profile_id,
      deployment_env: profile.deployment_env,
      expected_database_name: profile.expected_database_name,
      expected_system_identifier_present: Boolean(profile.expected_system_identifier),
      tls_mode: profile.tls.mode,
      ca_pem_emitted: false,
    });
    return;
  }

  if (command === 'write-intended-admin') {
    const ceremonyDir = argValue(argv, '--ceremony-dir');
    const adminUserId = argValue(argv, '--admin-user-id');
    const email = argValue(argv, '--email');
    if (ceremonyDir === null || adminUserId === null || email === null) usage();
    writeIntendedExistingAdminBinding(ceremonyDir, {
      enrollment_mode: 'CLAIM_EXISTING_ADMIN',
      intended_admin_user_id: adminUserId,
      intended_admin_email: email,
      note: 'locator_only_not_authority',
    });
    printJson({
      ok: true,
      command,
      enrollment_mode: 'CLAIM_EXISTING_ADMIN',
      intended_admin_user_id: adminUserId,
      authority: false,
    });
    return;
  }

  if (command === 'draft-seal') {
    const ceremonyDir = argValue(argv, '--ceremony-dir');
    const authorizer = argValue(argv, '--authorizer');
    const witnessName = argValue(argv, '--witness-name');
    const witnessRef = argValue(argv, '--witness-attestation-ref');
    if (ceremonyDir === null || authorizer === null || witnessName === null || witnessRef === null) {
      usage();
    }
    const seal = draftProductionCeremonySeal({
      ceremonyDir,
      authorizerDisplayName: authorizer,
      witnesses: [
        {
          display_name: witnessName,
          role: 'independent_witness',
          attestation_ref: witnessRef,
        },
      ],
    });
    printJson({
      ok: true,
      command,
      ceremony_id: seal.ceremony_id,
      witness_count: seal.witnesses.length,
      profile_digest_hex: seal.profile_digest_hex,
      public_key_sha256_hex: seal.public_key_sha256_hex,
    });
    return;
  }

  if (command === 'record-channel-b') {
    const ceremonyDir = argValue(argv, '--ceremony-dir');
    if (ceremonyDir === null) usage();
    const digest = await readLine(
      'Type Channel B production bundle digest (64 hex, documentary record): ',
    );
    const record = recordProductionChannelBDigest({
      ceremonyDir,
      ownerTypedDigestHex: digest,
    });
    printJson({
      ok: true,
      command,
      recorded_via: record.recorded_via,
      digest_recorded: true,
    });
    return;
  }

  if (command === 'validate' || command === 'verify') {
    const ceremonyDir = argValue(argv, '--ceremony-dir');
    if (ceremonyDir === null) usage();
    try {
      const structural = validateProductionCeremonyBundleStructurally(ceremonyDir);
      printJson({
        ok: true,
        command,
        structural_only: true,
        provenance_authenticated: structural.provenanceAuthenticated,
        bundle_digest_hex: structural.bundleDigestHex,
        intended_admin_user_id: structural.intendedAdmin.intended_admin_user_id,
        enrollment_mode: structural.intendedAdmin.enrollment_mode,
        witness_model: structural.witnessModel,
        witness_cryptographic_identity_proven: structural.witnessCryptographicIdentityProven,
        notes: [
          'STRUCTURAL validation only — not enrollment authority',
          'Operational Layer C/D requires authenticateProductionCeremonyFromOwnerTty (live Owner TTY)',
          'Same-host Channel B file is documentary only',
        ],
        readyForProductionOwnerBootstrapCeremony: false,
      });
    } catch (error: unknown) {
      printJson({
        ok: false,
        command,
        message: error instanceof Error ? error.message : String(error),
        missing: missingProductionTrustResources(ceremonyDir),
      });
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'enroll-existing' || command === 'run') {
    const applyFlag = hasFlag(argv, '--apply');
    const preflightFlag = hasFlag(argv, '--preflight-only');
    const authenticatedPreflightFlag = hasFlag(argv, '--authenticated-preflight-only');
    const modeCount = [applyFlag, preflightFlag, authenticatedPreflightFlag].filter(Boolean).length;
    if (modeCount > 1) {
      printJson({
        ok: false,
        command,
        refuseCode: 'MUTUALLY_EXCLUSIVE_MODES',
        message:
          'pass exactly one of --preflight-only | --authenticated-preflight-only | --apply',
      });
      process.exitCode = 1;
      return;
    }
    if (modeCount === 0) {
      printJson({
        ok: false,
        command,
        refuseCode: 'MODE_REQUIRED',
        message:
          'run/enroll-existing require exactly one of --preflight-only (unauthenticated read-only), --authenticated-preflight-only (live Owner TTY, read-only) or --apply (gated mutation)',
        trust_class: PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS,
        forceApply: false,
        applyDefault: false,
        orchestrator: 'orchestrateProductionOwnerBootstrapCeremony',
        preflight: 'runProductionOwnerBootstrapPreflightOnly',
        authenticatedPreflight: 'runAuthenticatedProductionOwnerBootstrapPreflightOnly',
      });
      process.exitCode = 1;
      return;
    }
    if (preflightFlag) {
      await runPreflightOnlyCommand(argv);
      return;
    }
    if (authenticatedPreflightFlag) {
      await runAuthenticatedPreflightOnlyCommand(argv, command);
      return;
    }
    await runApplyCommand(argv, command);
    return;
  }

  if (command === 'hydrate-intended-admin') {
    await runHydrateIntendedAdminCommand(argv);
    return;
  }

  usage();
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
});
