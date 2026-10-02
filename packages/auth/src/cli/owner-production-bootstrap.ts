#!/usr/bin/env node
/**
 * Production Owner-bootstrap ceremony CLI (Phase 21 Step 4A.2).
 * Default: read-only / dry validation. Mutation requires multi-gate --apply.
 * Does NOT weaken owner-bootstrap-ceremony (isolated-only).
 * DO NOT reuse Hot Wallet keys. DO NOT accept secrets via argv/env.
 */
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { stdin as stdinFd, stdout as stdoutFd } from 'node:process';

import {
  assertCeremonyDirOutsideRepo,
  assertProductionProfileRequiresSystemIdentifier,
  buildProductionOwnerBootstrapReadinessReport,
  draftProductionCeremonySeal,
  generateProductionBootstrapKeypairFiles,
  missingProductionTrustResources,
  recordProductionChannelBDigest,
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
        'usage: owner-production-bootstrap <preflight|generate-keypair|write-profile|write-intended-admin|draft-seal|record-channel-b|validate|readiness|enroll-existing|run|verify> ...',
      notes: [
        'run/enroll-existing mutation is gated; Step4A.2 refuses operational apply',
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
    const gatesOk =
      applyFlag &&
      process.env.DEPLOYMENT_ENV === 'production' &&
      envTrue('OWNER_PRODUCTION_BOOTSTRAP_ENABLED') &&
      envTrue('OWNER_PRODUCTION_BOOTSTRAP_APPLY');
    try {
      if (gatesOk) {
        assertProductionCeremonyApplyGates({
          apply: true,
          deploymentEnvIsProduction: true,
          ownerProductionBootstrapEnabled: true,
          ownerProductionBootstrapApply: true,
        });
      }
    } catch {
      // fall through to refuse messaging
    }
    printJson({
      ok: false,
      command,
      refuseCode: gatesOk ? 'STEP4A2_SOURCE_ONLY_REFUSES_APPLY' : 'APPLY_GATES_REQUIRED',
      message: gatesOk
        ? 'Step4A.2 implements operator orchestrator source path but refuses operational apply — no real Owner ceremony'
        : 'Requires DEPLOYMENT_ENV=production + OWNER_PRODUCTION_BOOTSTRAP_ENABLED=true + OWNER_PRODUCTION_BOOTSTRAP_APPLY=1 + --apply',
      trust_class: PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS,
      forceApply: false,
      applyDefault: false,
      applied: false,
      orchestrator: 'orchestrateProductionOwnerBootstrapCeremony',
      secrets: 'interactive_TTY_only',
    });
    process.exitCode = 1;
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
