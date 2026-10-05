/**
 * Isolated Option C enrollment runner — official Stage B sequence only.
 * Requires a ceremony package that passes assertIsolatedCeremonyAllowsEnrollment.
 */
import { randomBytes } from 'node:crypto';

import { AuthDomainError } from '../errors.js';
import { bytesToHex, hexToBytes } from './ed25519.js';
import {
  buildTestGrantPayload,
  signGrantEnvelope,
  type CeremonyAuthority,
  type OwnerBootstrapGrantEnvelope,
  type OwnerBootstrapGrantPayload,
} from './grant.js';
import {
  assertConnectionUrlAllowedForIsolatedCeremony,
  assertIsolatedCeremonyAllowsEnrollment,
  loadCeremonyAuthorityFromDir,
} from './isolated-ceremony-gate.js';
import {
  bootstrapEndpointProfileFromIsolatedCeremonyWire,
  type IsolatedCeremonyEndpointProfileV1,
} from './isolated-ceremony-profile-v1.js';
import {
  createBootstrapTrustMaterial,
  createOwnerBootstrapPool,
  type OwnerBootstrapPool,
} from './pool.js';
import {
  completeOwnerBootstrapEnrollment,
  createEnrollmentChannelKeypair,
  generateTotpCode,
  generateTotpSecretBytes,
  signChannelPop,
  signFinalCredReq,
  signOwnerRedeemChallenge,
  startOwnerBootstrapAttempt,
  submitOwnerBootstrapPop,
  type BootstrapTrustMaterial,
  type CompleteEnrollmentResult,
} from './redeem.js';
import type { CeremonySealV1 } from './ceremony-seal-v1.js';

export function buildIsolatedCeremonyGrantPayload(input: {
  readonly authority: CeremonyAuthority;
  readonly seal: CeremonySealV1;
  readonly sealContentDigestHex: string;
  readonly profile: IsolatedCeremonyEndpointProfileV1;
  readonly intendedAdminEmail: string;
  readonly subjectDisplay: string;
  readonly nowSec?: number;
  readonly lifetimeSec?: number;
}): OwnerBootstrapGrantPayload {
  const now = input.nowSec ?? Math.floor(Date.now() / 1000);
  const lifetime = input.lifetimeSec ?? 900;
  // Reuse schema builder then overwrite identity fields bound to the real seal.
  const base = buildTestGrantPayload({
    authority: input.authority,
    endpointProfileId: input.profile.profile_id,
    deploymentEnv: 'isolated_test',
    intendedAdminEmail: input.intendedAdminEmail,
    nowSec: now,
    lifetimeSec: lifetime,
  });
  return {
    ...base,
    endpoint_profile_id: input.profile.profile_id,
    owner_identity_ref: {
      kind: 'human_owner_ceremony',
      subject_display: input.subjectDisplay,
      ceremony_id: input.seal.ceremony_id,
      evidence_fingerprint: input.sealContentDigestHex,
      intended_admin_email: input.intendedAdminEmail,
    },
  };
}

export async function openIsolatedCeremonyBootstrap(input: {
  readonly connectionString: string;
  readonly profile: IsolatedCeremonyEndpointProfileV1;
  readonly authority: CeremonyAuthority;
  readonly expectedDatabase: string;
}): Promise<{
  readonly bootstrap: OwnerBootstrapPool;
  readonly trust: BootstrapTrustMaterial;
}> {
  const urlFacts = assertConnectionUrlAllowedForIsolatedCeremony(input.connectionString);
  if (urlFacts.database !== input.expectedDatabase) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'cross-DB rejection: URL database does not match --expected-database',
    );
  }
  if (urlFacts.database !== input.profile.expected_database_name) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'cross-DB rejection: URL database does not match ceremony profile',
    );
  }
  if (urlFacts.port !== input.profile.expected_port) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'URL port does not match ceremony profile expected_port',
    );
  }
  const endpoint = bootstrapEndpointProfileFromIsolatedCeremonyWire(input.profile);
  const bootstrap = await createOwnerBootstrapPool({
    connectionString: input.connectionString,
    profile: endpoint,
  });
  const trust = createBootstrapTrustMaterial(
    bootstrap,
    new Map([[input.authority.keyId, input.authority.publicKey]]),
  );
  return { bootstrap, trust };
}

export async function runIsolatedOptionCEnrollment(input: {
  readonly ceremonyDir: string;
  readonly connectionString: string;
  readonly expectedDatabase: string;
  readonly intendedAdminEmail: string;
  readonly subjectDisplay: string;
  readonly password: string;
  readonly totpSecretBytes?: Uint8Array;
}): Promise<{
  readonly result: CompleteEnrollmentResult;
  readonly grantEnvelope: OwnerBootstrapGrantEnvelope;
  readonly pool: OwnerBootstrapPool['pool'];
  readonly close: () => Promise<void>;
}> {
  const gated = assertIsolatedCeremonyAllowsEnrollment(input.ceremonyDir);
  const authority = loadCeremonyAuthorityFromDir(input.ceremonyDir);
  const opened = await openIsolatedCeremonyBootstrap({
    connectionString: input.connectionString,
    profile: gated.profile,
    authority,
    expectedDatabase: input.expectedDatabase,
  });
  const pool = opened.bootstrap.pool;
  const trust = opened.trust;
  try {
    const payload = buildIsolatedCeremonyGrantPayload({
      authority,
      seal: gated.seal,
      sealContentDigestHex: gated.sealContentDigestHex,
      profile: gated.profile,
      intendedAdminEmail: input.intendedAdminEmail,
      subjectDisplay: input.subjectDisplay,
    });
    const grantEnvelope = signGrantEnvelope(payload, authority);
    const channel = createEnrollmentChannelKeypair();
    const started = await startOwnerBootstrapAttempt(pool, {
      grantEnvelope,
      channelPublicKey: channel.publicKey,
      trust,
    });
    const challengeBytes = hexToBytes(started.challengeBytesHex);
    const sigRedeem = signOwnerRedeemChallenge(authority, challengeBytes);
    const noncePop = bytesToHex(randomBytes(32));
    const now = Math.floor(Date.now() / 1000);
    const sigChannelPop = signChannelPop(channel.privateKey, {
      attemptId: started.attemptId,
      challengeId: started.challengeId,
      grantId: started.grantId,
      channelFpHex: started.channelFp,
      clientUnixTime: now,
      nonce32: hexToBytes(noncePop),
    });
    const pop = await submitOwnerBootstrapPop(pool, {
      attemptId: started.attemptId,
      challengeId: started.challengeId,
      keyId: started.keyId,
      sigRedeemB64: sigRedeem,
      clientUnixTime: now,
      nonce32Hex: noncePop,
      sigChannelPopB64: sigChannelPop,
      trust,
    });
    const totpSecret = input.totpSecretBytes ?? generateTotpSecretBytes();
    const code = generateTotpCode(totpSecret);
    const nonceCred = bytesToHex(randomBytes(32));
    const publicHeader = {
      v: 1 as const,
      purpose: 'FIRST_OWNER_CREDENTIAL_SETUP' as const,
      grant_id: started.grantId,
      attempt_id: started.attemptId,
      challenge_id: started.challengeId,
      ticket_id: pop.ticketId,
      channel_fp: started.channelFp,
      intended_subject: input.intendedAdminEmail,
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
    const sigCred = signFinalCredReq(channel.privateKey, {
      publicHeader,
      passwordUtf8: Buffer.from(input.password, 'utf8'),
      totpSecretBytes: totpSecret,
    });
    const result = await completeOwnerBootstrapEnrollment(pool, {
      attemptId: started.attemptId,
      challengeId: started.challengeId,
      ticketId: pop.ticketId,
      enrollmentTicket: pop.enrollmentTicket,
      intendedSubject: input.intendedAdminEmail,
      password: input.password,
      totpSecretBytes: totpSecret,
      totpConfirmCode: code,
      clientUnixTime: now,
      nonce32Hex: nonceCred,
      sigChannelCredB64: sigCred,
      trust,
    });
    return {
      result,
      grantEnvelope,
      pool,
      close: async () => {
        await pool.end();
      },
    };
  } catch (err) {
    await pool.end();
    throw err;
  }
}
