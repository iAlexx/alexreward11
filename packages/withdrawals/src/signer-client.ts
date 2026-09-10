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

export interface SignerClientDeps {
  readonly baseUrl: string;
  readonly serviceToken: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * HTTP client for apps/signer POST /v1/sign-withdrawal-attempt.
 * Sends only withdrawalAttemptId — never recipient/amount/message bytes.
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
      withdrawalAttemptId: String(body.withdrawalAttemptId ?? withdrawalAttemptId),
      withdrawalId: String(body.withdrawalId ?? ''),
      canonicalMessageHash: String(body.canonicalMessageHash ?? ''),
      signedMessageHash: String(body.signedMessageHash ?? ''),
      publicKeyFingerprint: String(body.publicKeyFingerprint ?? ''),
      walletAddressRaw: String(body.walletAddressRaw ?? ''),
      signatureBase64: String(body.signatureBase64 ?? ''),
      keySpec: String(body.keySpec ?? body.kmsKeySpec ?? ''),
      signingAlgorithm: String(body.signingAlgorithm ?? ''),
      externalMessageBocBase64: boc,
    };
  }
}
