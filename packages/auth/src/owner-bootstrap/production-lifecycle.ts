/**
 * Explicit production Owner-bootstrap lifecycle (Phase 21 Step 4A.1).
 * Isolated start/submit/abort/complete remain production-refusing for unbound trust.
 */
import type { Pool } from 'pg';

import { AuthDomainError } from '../errors.js';
import {
  assertAuthenticatedProductionBootstrapTrust,
  isProductionBoundBootstrapTrustMaterial,
  type AuthenticatedProductionBootstrapTrust,
} from './authenticated-production-trust.js';
import {
  abortOwnerBootstrapAttempt,
  completeOwnerBootstrapEnrollment,
  startOwnerBootstrapAttempt,
  submitOwnerBootstrapPop,
  type CompleteEnrollmentInput,
  type CompleteEnrollmentResult,
  type StartAttemptResult,
  type SubmitPopResult,
} from './redeem.js';
import { assertProductionBootstrapTlsAndEndpoint } from './pool.js';
import {
  intendedSubjectFromPayload,
  parseAndVerifyGrantEnvelope,
  type OwnerBootstrapGrantEnvelope,
} from './grant.js';

function refuseUnboundTrust(productionTrust: AuthenticatedProductionBootstrapTrust): void {
  if (!isProductionBoundBootstrapTrustMaterial(productionTrust.trust)) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'production lifecycle requires AuthenticatedProductionBootstrapTrust-bound material',
    );
  }
}

export async function startProductionOwnerBootstrapAttempt(
  pool: Pool,
  input: {
    readonly grantEnvelope: OwnerBootstrapGrantEnvelope | string;
    readonly channelPublicKey: Uint8Array;
    readonly productionTrust: AuthenticatedProductionBootstrapTrust;
  },
): Promise<StartAttemptResult> {
  assertAuthenticatedProductionBootstrapTrust(input.productionTrust);
  refuseUnboundTrust(input.productionTrust);
  const preflightNow = Math.floor(Date.now() / 1000);
  const verified = parseAndVerifyGrantEnvelope(
    input.grantEnvelope,
    input.productionTrust.trust.pinnedPublicKeys,
    preflightNow,
  );
  const payload = verified.envelope.payload;
  if (payload.key_id !== input.productionTrust.keyId) {
    throw new AuthDomainError('FORBIDDEN', 'grant key_id != authenticated bundle key_id');
  }
  if (payload.endpoint_profile_id !== input.productionTrust.endpointProfileId) {
    throw new AuthDomainError('FORBIDDEN', 'grant endpoint_profile_id != authenticated bundle profile');
  }
  if (payload.deployment_env !== 'production') {
    throw new AuthDomainError('FORBIDDEN', 'grant deployment_env must be production');
  }
  const grantEmail = intendedSubjectFromPayload(payload).trim().toLowerCase();
  if (grantEmail !== input.productionTrust.intendedAdminEmail) {
    throw new AuthDomainError('FORBIDDEN', 'grant intended email != root-bound target admin email');
  }
  assertProductionBootstrapTlsAndEndpoint(
    input.productionTrust.trust.endpointProfile,
    'production',
    input.productionTrust.endpointProfileId,
    input.productionTrust.trust.connectionFacts,
  );
  return startOwnerBootstrapAttempt(pool, {
    grantEnvelope: input.grantEnvelope,
    channelPublicKey: input.channelPublicKey,
    trust: input.productionTrust.trust,
  });
}

export async function submitProductionOwnerBootstrapPop(
  pool: Pool,
  input: {
    readonly attemptId: string;
    readonly challengeId: string;
    readonly keyId: string;
    readonly sigRedeemB64: string;
    readonly clientUnixTime: number;
    readonly nonce32Hex: string;
    readonly sigChannelPopB64: string;
    readonly productionTrust: AuthenticatedProductionBootstrapTrust;
  },
): Promise<SubmitPopResult> {
  assertAuthenticatedProductionBootstrapTrust(input.productionTrust);
  refuseUnboundTrust(input.productionTrust);
  if (input.keyId !== input.productionTrust.keyId) {
    throw new AuthDomainError('FORBIDDEN', 'PoP key_id != authenticated bundle key_id');
  }
  return submitOwnerBootstrapPop(pool, {
    attemptId: input.attemptId,
    challengeId: input.challengeId,
    keyId: input.keyId,
    sigRedeemB64: input.sigRedeemB64,
    clientUnixTime: input.clientUnixTime,
    nonce32Hex: input.nonce32Hex,
    sigChannelPopB64: input.sigChannelPopB64,
    trust: input.productionTrust.trust,
  });
}

export async function abortProductionOwnerBootstrapAttempt(
  pool: Pool,
  input: {
    readonly attemptId: string;
    readonly challengeId: string;
    readonly clientUnixTime: number;
    readonly nonce32Hex: string;
    readonly sigChannelAbortB64: string;
    readonly productionTrust: AuthenticatedProductionBootstrapTrust;
  },
): Promise<void> {
  assertAuthenticatedProductionBootstrapTrust(input.productionTrust);
  refuseUnboundTrust(input.productionTrust);
  return abortOwnerBootstrapAttempt(pool, {
    attemptId: input.attemptId,
    challengeId: input.challengeId,
    clientUnixTime: input.clientUnixTime,
    nonce32Hex: input.nonce32Hex,
    sigChannelAbortB64: input.sigChannelAbortB64,
    trust: input.productionTrust.trust,
  });
}

export async function completeProductionOwnerBootstrapEnrollment(
  pool: Pool,
  input: Omit<
    CompleteEnrollmentInput,
    'trust' | 'enrollmentMode' | 'intendedAdminUserId'
  > & {
    readonly productionTrust: AuthenticatedProductionBootstrapTrust;
  },
): Promise<CompleteEnrollmentResult> {
  assertAuthenticatedProductionBootstrapTrust(input.productionTrust);
  refuseUnboundTrust(input.productionTrust);
  if (input.intendedSubject.trim().toLowerCase() !== input.productionTrust.intendedAdminEmail) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'intendedSubject must equal root-bound target admin email',
    );
  }
  const completeInput: CompleteEnrollmentInput = {
    attemptId: input.attemptId,
    challengeId: input.challengeId,
    ticketId: input.ticketId,
    enrollmentTicket: input.enrollmentTicket,
    intendedSubject: input.intendedSubject,
    password: input.password,
    totpSecretBytes: input.totpSecretBytes,
    totpConfirmCode: input.totpConfirmCode,
    clientUnixTime: input.clientUnixTime,
    nonce32Hex: input.nonce32Hex,
    sigChannelCredB64: input.sigChannelCredB64,
    trust: input.productionTrust.trust,
    enrollmentMode: 'CLAIM_EXISTING_ADMIN',
    intendedAdminUserId: input.productionTrust.intendedAdminUserId,
  };
  if (input.displayName !== undefined) {
    (completeInput as { displayName?: string }).displayName = input.displayName;
  }
  if (input.testCredentialPrepDelayMs !== undefined) {
    (completeInput as { testCredentialPrepDelayMs?: number }).testCredentialPrepDelayMs =
      input.testCredentialPrepDelayMs;
  }
  return completeOwnerBootstrapEnrollment(pool, completeInput);
}
