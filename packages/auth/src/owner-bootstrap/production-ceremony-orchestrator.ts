/**
 * Production Owner-bootstrap ceremony orchestrator (Phase 21 Step 4B).
 * Owner-workstation only. Decrypts encrypted bootstrap key in memory for signing,
 * then zeroizes. Never accepts secrets via env/argv. Apply requires multi-gate --apply.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';

import { AuthDomainError } from '../errors.js';
import { assertPasswordPolicy } from '../admin-password.js';
import { assertTotpCodeFormat, verifyTotpCode } from '../admin-totp.js';
import { bytesToHex, hexToBytes, publicKeyFromPrivateSeed } from './ed25519.js';
import {
  buildTestGrantPayload,
  fingerprintPublicKey,
  signGrantEnvelope,
  type CeremonyAuthority,
  type OwnerBootstrapGrantEnvelope,
} from './grant.js';
import {
  decryptOwnerBootstrapPrivateSeed,
  zeroizeBytes,
  type OwnerBootstrapEncryptedKeyBundleV1,
} from './owner-bootstrap-encrypted-key.js';
import {
  assertAuthenticatedProductionBootstrapTrust,
  type AuthenticatedProductionBootstrapTrust,
} from './authenticated-production-trust.js';
import {
  createEnrollmentChannelKeypair,
  signChannelPop,
  signFinalCredReq,
  signOwnerRedeemChallenge,
} from './redeem.js';
import {
  startProductionOwnerBootstrapAttempt,
  submitProductionOwnerBootstrapPop,
  completeProductionOwnerBootstrapEnrollment,
} from './production-lifecycle.js';
import { preflightProductionOwnerBootstrapSchema } from './production-schema-preflight.js';
import {
  preflightClaimExistingAdmin,
  assertClaimExistingAdminEligible,
} from './claim-existing-admin.js';
import { PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS } from './production-trust-class.js';

export interface ProductionCeremonyOrchestratorInput {
  readonly pool: Pool;
  readonly productionTrust: AuthenticatedProductionBootstrapTrust;
  readonly encryptedKeyBundle: OwnerBootstrapEncryptedKeyBundleV1;
  readonly bootstrapPassphrase: string;
  readonly password: string;
  readonly passwordConfirm: string;
  /** Required: Owner-enrolled TOTP secret (caller keeps ownership of its own buffer). */
  readonly totpSecretBytes?: Uint8Array;
  /** Required: live 6-digit code the Owner typed from their authenticator. */
  readonly totpConfirmCode?: string;
  /** Must be true only with CLI --apply + env gates. */
  readonly apply: boolean;
  readonly deploymentEnvIsProduction: boolean;
  readonly ownerProductionBootstrapEnabled: boolean;
  readonly ownerProductionBootstrapApply: boolean;
  readonly subjectDisplay?: string;
}

export interface ProductionCeremonyOrchestratorResult {
  readonly adminUserId: string;
  readonly email: string;
  readonly grantId: string;
  readonly attemptId: string;
  readonly applied: true;
}

export function assertProductionCeremonyApplyGates(input: {
  readonly apply: boolean;
  readonly deploymentEnvIsProduction: boolean;
  readonly ownerProductionBootstrapEnabled: boolean;
  readonly ownerProductionBootstrapApply: boolean;
}): void {
  if (!input.apply) {
    throw new AuthDomainError('FORBIDDEN', 'APPLY_GATES_REQUIRED: pass --apply');
  }
  if (!input.deploymentEnvIsProduction) {
    throw new AuthDomainError('FORBIDDEN', 'DEPLOYMENT_ENV must be production');
  }
  if (!input.ownerProductionBootstrapEnabled) {
    throw new AuthDomainError('FORBIDDEN', 'OWNER_PRODUCTION_BOOTSTRAP_ENABLED must be true');
  }
  if (!input.ownerProductionBootstrapApply) {
    throw new AuthDomainError('FORBIDDEN', 'OWNER_PRODUCTION_BOOTSTRAP_APPLY must be 1');
  }
}

/**
 * Full production CLAIM_EXISTING_ADMIN lifecycle.
 * Does not accept forceApply. Secrets must already be collected via interactive TTY by caller.
 */
export async function orchestrateProductionOwnerBootstrapCeremony(
  input: ProductionCeremonyOrchestratorInput,
): Promise<ProductionCeremonyOrchestratorResult> {
  assertAuthenticatedProductionBootstrapTrust(input.productionTrust);
  if (input.productionTrust.trustClass !== PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS) {
    throw new AuthDomainError('FORBIDDEN', 'production trust class required');
  }

  assertProductionCeremonyApplyGates({
    apply: input.apply,
    deploymentEnvIsProduction: input.deploymentEnvIsProduction,
    ownerProductionBootstrapEnabled: input.ownerProductionBootstrapEnabled,
    ownerProductionBootstrapApply: input.ownerProductionBootstrapApply,
  });

  if (process.env.PASSWORD || process.env.TOTP || process.env.OWNER_BOOTSTRAP_PASSPHRASE) {
    throw new AuthDomainError('FORBIDDEN', 'secrets via env forbidden');
  }

  assertPasswordPolicy(input.password);
  if (input.password !== input.passwordConfirm) {
    throw new AuthDomainError('VALIDATION', 'password confirmation mismatch');
  }

  // Production TOTP: the Owner must have enrolled the secret in an authenticator and typed a
  // live code. This is verified BEFORE any database access, decryption or grant creation, so a
  // wrong/missing code can never leave a partial lifecycle. Never auto-generated/auto-confirmed.
  const totpConfirmCode = requireProductionTotpConfirmation(input);
  const totpSecret = new Uint8Array(input.totpSecretBytes as Uint8Array);

  try {
    return await runVerifiedOrchestration(input, totpSecret, totpConfirmCode);
  } finally {
    zeroizeBytes(totpSecret);
  }
}

function requireProductionTotpConfirmation(input: ProductionCeremonyOrchestratorInput): string {
  if (input.productionTrust.trustClass !== PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS) {
    throw new AuthDomainError('FORBIDDEN', 'production trust class required');
  }
  const secret = input.totpSecretBytes;
  if (secret === undefined || secret.byteLength === 0) {
    throw new AuthDomainError(
      'VALIDATION',
      'PRODUCTION_TOTP_SECRET_REQUIRED: Owner-enrolled TOTP secret is mandatory (no auto-generation)',
    );
  }
  const code = input.totpConfirmCode;
  if (code === undefined || code.trim() === '') {
    throw new AuthDomainError(
      'VALIDATION',
      'PRODUCTION_TOTP_CODE_REQUIRED: Owner-typed 6-digit TOTP code is mandatory (no auto-confirm)',
    );
  }
  assertTotpCodeFormat(code);
  if (!verifyTotpCode(secret, code)) {
    throw new AuthDomainError('FORBIDDEN', 'TOTP confirmation failed');
  }
  return code.trim();
}

async function runVerifiedOrchestration(
  input: ProductionCeremonyOrchestratorInput,
  totpSecret: Uint8Array,
  totpConfirmCode: string,
): Promise<ProductionCeremonyOrchestratorResult> {
  const client = await input.pool.connect();
  try {
    const schema = await preflightProductionOwnerBootstrapSchema(client);
    if (!schema.schemaReady) {
      throw new AuthDomainError(
        'FORBIDDEN',
        schema.refuseCode ?? 'PRODUCTION_OWNER_BOOTSTRAP_SCHEMA_READY=NO',
      );
    }
    const eligibility = await preflightClaimExistingAdmin(client, {
      intendedAdminUserId: input.productionTrust.intendedAdminUserId,
      intendedAdminEmail: input.productionTrust.intendedAdminEmail,
      lockForUpdate: false,
    });
    assertClaimExistingAdminEligible(eligibility);
  } finally {
    client.release();
  }

  let seed: Uint8Array | null = null;
  let channelSk: Uint8Array | null = null;
  try {
    seed = decryptOwnerBootstrapPrivateSeed(input.encryptedKeyBundle, input.bootstrapPassphrase);
    const pub = publicKeyFromPrivateSeed(seed);
    const fp = fingerprintPublicKey(pub);
    if (fp !== input.productionTrust.publicKeyFingerprintHex) {
      throw new AuthDomainError(
        'FORBIDDEN',
        'decrypted public key fingerprint mismatch root-bound bundle',
      );
    }
    if (bytesToHex(pub) !== input.encryptedKeyBundle.public_key_raw_hex) {
      throw new AuthDomainError('FORBIDDEN', 'decrypted public key mismatch');
    }

    const authority: CeremonyAuthority = {
      keyId: input.encryptedKeyBundle.key_id,
      publicKey: pub,
      privateKey: seed,
      fingerprintHex: fp,
    };
    if (authority.keyId !== input.productionTrust.keyId) {
      throw new AuthDomainError('FORBIDDEN', 'encrypted key_id != authenticated bundle key_id');
    }

    const now = Math.floor(Date.now() / 1000);
    const basePayload = buildTestGrantPayload({
      authority,
      endpointProfileId: input.productionTrust.endpointProfileId,
      deploymentEnv: 'production',
      intendedAdminEmail: input.productionTrust.intendedAdminEmail,
      nowSec: now,
      lifetimeSec: 900,
    });
    const grantEnvelope: OwnerBootstrapGrantEnvelope = signGrantEnvelope(
      {
        ...basePayload,
        owner_identity_ref: {
          ...basePayload.owner_identity_ref,
          ceremony_id: input.productionTrust.bundle.ceremony_id,
          evidence_fingerprint: input.productionTrust.bundleDigestHex,
          subject_display: input.subjectDisplay ?? 'Production Owner',
        },
      },
      authority,
    );

    const channel = createEnrollmentChannelKeypair();
    channelSk = new Uint8Array(channel.privateKey);

    const started = await startProductionOwnerBootstrapAttempt(input.pool, {
      grantEnvelope,
      channelPublicKey: channel.publicKey,
      productionTrust: input.productionTrust,
    });

    const challengeBytes = hexToBytes(started.challengeBytesHex);
    const sigRedeem = signOwnerRedeemChallenge(authority, challengeBytes);
    const noncePop = bytesToHex(randomBytes(32));
    const sigChannelPop = signChannelPop(channelSk, {
      attemptId: started.attemptId,
      challengeId: started.challengeId,
      grantId: started.grantId,
      channelFpHex: started.channelFp,
      clientUnixTime: now,
      nonce32: hexToBytes(noncePop),
    });
    const pop = await submitProductionOwnerBootstrapPop(input.pool, {
      attemptId: started.attemptId,
      challengeId: started.challengeId,
      keyId: started.keyId,
      sigRedeemB64: sigRedeem,
      clientUnixTime: now,
      nonce32Hex: noncePop,
      sigChannelPopB64: sigChannelPop,
      productionTrust: input.productionTrust,
    });

    const nonceCred = bytesToHex(randomBytes(32));
    const publicHeader = {
      v: 1 as const,
      purpose: 'FIRST_OWNER_CREDENTIAL_SETUP' as const,
      grant_id: started.grantId,
      attempt_id: started.attemptId,
      challenge_id: started.challengeId,
      ticket_id: pop.ticketId,
      channel_fp: started.channelFp,
      intended_subject: input.productionTrust.intendedAdminEmail,
      credential_setup: {
        password_encoding: 'utf8' as const,
        totp_secret_encoding: 'base32_nopad_uppercase' as const,
        totp_digits: 6 as const,
        totp_period_seconds: 30 as const,
        totp_algorithm: 'SHA1' as const,
      },
      client_unix_time: now,
      nonce32: nonceCred,
    };
    const sigCred = signFinalCredReq(channelSk, {
      publicHeader,
      passwordUtf8: Buffer.from(input.password, 'utf8'),
      totpSecretBytes: totpSecret,
    });

    const completed = await completeProductionOwnerBootstrapEnrollment(input.pool, {
      attemptId: started.attemptId,
      challengeId: started.challengeId,
      ticketId: pop.ticketId,
      enrollmentTicket: pop.enrollmentTicket,
      intendedSubject: input.productionTrust.intendedAdminEmail,
      password: input.password,
      totpSecretBytes: totpSecret,
      totpConfirmCode,
      clientUnixTime: now,
      nonce32Hex: nonceCred,
      sigChannelCredB64: sigCred,
      productionTrust: input.productionTrust,
    });

    return {
      adminUserId: completed.adminUserId,
      email: completed.email,
      grantId: started.grantId,
      attemptId: started.attemptId,
      applied: true,
    };
  } finally {
    if (seed !== null) zeroizeBytes(seed);
    if (channelSk !== null) zeroizeBytes(channelSk);
  }
}

/** Load encrypted Owner key bundle JSON from path (ciphertext only). */
export function loadEncryptedOwnerBootstrapKeyBundle(
  path: string,
): OwnerBootstrapEncryptedKeyBundleV1 {
  const raw = JSON.parse(readFileSync(resolve(path), 'utf8')) as OwnerBootstrapEncryptedKeyBundleV1;
  if (raw.formatVersion !== 1) {
    throw new AuthDomainError('FORBIDDEN', 'unsupported encrypted key format');
  }
  return raw;
}
