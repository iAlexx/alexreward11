import { WithdrawalDomainError } from './errors.js';

export interface SignerClientSignResult {
  readonly withdrawalAttemptId: string;
  readonly withdrawalId: string;
  readonly canonicalMessageHash: string;
  readonly signedMessageHash: string;
  readonly publicKeyFingerprint: string;
  readonly walletAddressRaw: string;
  readonly signatureBase64: string;
  readonly keySpec: string;
  readonly signingAlgorithm: string;
  readonly externalMessageBocBase64: string;
}

export interface SignerSigningIdentity {
  readonly publicKeyHex: string;
  readonly publicKeyFingerprint: string;
  readonly walletAddressRaw: string;
  readonly signingReady: boolean;
  readonly custodyState: string;
}

export interface SignerClientDeps {
  readonly baseUrl: string;
  readonly serviceToken: string;
  readonly fetchImpl?: typeof fetch;
}

function asNonEmptyString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * HTTP client for apps/signer.
 * Sign sends only withdrawalAttemptId — never recipient/amount/message bytes.
 */
export class SignerHttpClient {
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(deps: SignerClientDeps) {
    this.baseUrl = deps.baseUrl.replace(/\/$/, '');
    this.serviceToken = deps.serviceToken;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  async getSigningIdentity(): Promise<SignerSigningIdentity> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/signing-identity`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${this.serviceToken}`,
      },
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const code = typeof body.error === 'string' ? body.error : 'SIGNER_HTTP_ERROR';
      const message =
        typeof body.message === 'string' ? body.message : `Signer HTTP ${response.status}`;
      throw new WithdrawalDomainError('EXTERNAL_RESOURCE_REQUIRED', `${code}: ${message}`, {
        details: { httpStatus: response.status, signerError: code },
      });
    }
    const publicKeyHex = asNonEmptyString(body.publicKeyHex);
    if (!/^[0-9a-fA-F]{64}$/.test(publicKeyHex)) {
      throw new WithdrawalDomainError(
        'VALIDATION',
        'Signer identity response missing valid publicKeyHex',
      );
    }
    return {
      publicKeyHex: publicKeyHex.toLowerCase(),
      publicKeyFingerprint: asNonEmptyString(body.publicKeyFingerprint),
      walletAddressRaw: asNonEmptyString(body.walletAddressRaw),
      signingReady: body.signingReady === true,
      custodyState: asNonEmptyString(body.custodyState, 'unknown'),
    };
  }

  async signWithdrawalAttempt(withdrawalAttemptId: string): Promise<SignerClientSignResult> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/sign-withdrawal-attempt`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.serviceToken}`,
      },
      body: JSON.stringify({ withdrawalAttemptId }),
    });

    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const code = typeof body.error === 'string' ? body.error : 'SIGNER_HTTP_ERROR';
      const message =
        typeof body.message === 'string' ? body.message : `Signer HTTP ${response.status}`;
      throw new WithdrawalDomainError('EXTERNAL_RESOURCE_REQUIRED', `${code}: ${message}`, {
        details: { httpStatus: response.status, signerError: code },
      });
    }

    const boc = body.externalMessageBocBase64;
    if (typeof boc !== 'string' || boc.trim() === '') {
      throw new WithdrawalDomainError(
        'VALIDATION',
        'Signer response missing externalMessageBocBase64',
      );
    }

    return {
      withdrawalAttemptId: asNonEmptyString(body.withdrawalAttemptId, withdrawalAttemptId),
      withdrawalId: asNonEmptyString(body.withdrawalId),
      canonicalMessageHash: asNonEmptyString(body.canonicalMessageHash),
      signedMessageHash: asNonEmptyString(body.signedMessageHash),
      publicKeyFingerprint: asNonEmptyString(body.publicKeyFingerprint),
      walletAddressRaw: asNonEmptyString(body.walletAddressRaw),
      signatureBase64: asNonEmptyString(body.signatureBase64),
      keySpec: asNonEmptyString(body.keySpec, asNonEmptyString(body.kmsKeySpec)),
      signingAlgorithm: asNonEmptyString(body.signingAlgorithm),
      externalMessageBocBase64: boc,
    };
  }
}
