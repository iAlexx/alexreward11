import { WithdrawalDomainError } from './errors.js';
import { createSignerHttpFetch } from './signer-http-fetch.js';
import {
  SIGNER_HTTP_IDENTITY_TIMEOUT_MS,
  SIGNER_HTTP_SIGN_TIMEOUT_MS,
  SIGNER_HTTP_VALID_UNTIL_MARGIN_MS,
  fetchTextWithDeadline,
  resolveSignerHttpTimeoutMs,
} from './signer-http-timeouts.js';

export interface SignerClientSignResult {
  readonly withdrawalAttemptId: string;
  readonly withdrawalId: string;
  readonly canonicalMessageHash: string;
  readonly canonicalSigningHash: string;
  /** @deprecated alias of normalizedExternalMessageHash */
  readonly signedMessageHash: string;
  readonly publicKeyFingerprint: string;
  readonly walletAddressRaw: string;
  readonly signatureBase64: string;
  readonly keySpec: string;
  readonly signingAlgorithm: string;
  readonly signedWalletRequestBocBase64: string;
  readonly externalMessageBocBase64: string;
  readonly externalMessageCellHash: string;
  readonly normalizedExternalMessageHash: string;
  readonly signatureFingerprintHash?: string;
}

export interface SignerSigningIdentity {
  readonly publicKeyHex: string;
  readonly publicKeyFingerprint: string;
  readonly walletAddressRaw: string;
  readonly signingReady: boolean;
  readonly custodyState: string;
}

export interface SignerHttpRequestOptions {
  readonly signal?: AbortSignal;
  /** When set, HTTP deadline is capped to leave margin before this instant. */
  readonly validUntil?: Date;
  readonly nowMs?: number;
  readonly timeoutMs?: number;
  readonly validUntilMarginMs?: number;
}

export interface SignerClientDeps {
  readonly baseUrl: string;
  readonly serviceToken: string;
  readonly fetchImpl?: typeof fetch;
  readonly identityTimeoutMs?: number;
  readonly signTimeoutMs?: number;
  readonly validUntilMarginMs?: number;
  /** Default cancellation signal (e.g. Temporal activity cancellation). */
  readonly signal?: AbortSignal;
}

function asNonEmptyString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function parseJsonObject(text: string): Record<string, unknown> {
  if (text.trim() === '') {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * HTTP client for apps/signer.
 * Sign sends only withdrawalAttemptId — never recipient/amount/message bytes.
 * All requests use bounded deadlines that include response-body consumption.
 */
export class SignerHttpClient {
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly identityTimeoutMs: number;
  private readonly signTimeoutMs: number;
  private readonly validUntilMarginMs: number;
  private readonly defaultSignal: AbortSignal | undefined;

  constructor(deps: SignerClientDeps) {
    this.baseUrl = deps.baseUrl.replace(/\/$/, '');
    this.serviceToken = deps.serviceToken;
    // Signer-only transport: explicit Undici ProxyAgent when HTTP_PROXY is set
    // (Tailscale userspace). Injected fetchImpl always wins (tests / fakes).
    this.fetchImpl = createSignerHttpFetch({
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    });
    this.identityTimeoutMs = deps.identityTimeoutMs ?? SIGNER_HTTP_IDENTITY_TIMEOUT_MS;
    this.signTimeoutMs = deps.signTimeoutMs ?? SIGNER_HTTP_SIGN_TIMEOUT_MS;
    this.validUntilMarginMs = deps.validUntilMarginMs ?? SIGNER_HTTP_VALID_UNTIL_MARGIN_MS;
    this.defaultSignal = deps.signal;
  }

  async getSigningIdentity(options: SignerHttpRequestOptions = {}): Promise<SignerSigningIdentity> {
    const nowMs = options.nowMs ?? Date.now();
    const timeoutMs = resolveSignerHttpTimeoutMs({
      nowMs,
      timeoutMs: options.timeoutMs ?? this.identityTimeoutMs,
      ...(options.validUntil !== undefined
        ? { validUntilMs: options.validUntil.getTime() }
        : {}),
      marginMs: options.validUntilMarginMs ?? this.validUntilMarginMs,
    });
    const identitySignal = options.signal ?? this.defaultSignal;
    const { response, text } = await fetchTextWithDeadline(
      this.fetchImpl,
      `${this.baseUrl}/v1/signing-identity`,
      {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.serviceToken}`,
        },
        ...(identitySignal !== undefined ? { signal: identitySignal } : {}),
      },
      timeoutMs,
    );
    const body = parseJsonObject(text);
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

  async signWithdrawalAttempt(
    withdrawalAttemptId: string,
    options: SignerHttpRequestOptions = {},
  ): Promise<SignerClientSignResult> {
    const nowMs = options.nowMs ?? Date.now();
    const timeoutMs = resolveSignerHttpTimeoutMs({
      nowMs,
      timeoutMs: options.timeoutMs ?? this.signTimeoutMs,
      ...(options.validUntil !== undefined
        ? { validUntilMs: options.validUntil.getTime() }
        : {}),
      marginMs: options.validUntilMarginMs ?? this.validUntilMarginMs,
    });
    const signSignal = options.signal ?? this.defaultSignal;
    const { response, text } = await fetchTextWithDeadline(
      this.fetchImpl,
      `${this.baseUrl}/v1/sign-withdrawal-attempt`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.serviceToken}`,
        },
        body: JSON.stringify({ withdrawalAttemptId }),
        ...(signSignal !== undefined ? { signal: signSignal } : {}),
      },
      timeoutMs,
    );

    const body = parseJsonObject(text);
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
      canonicalSigningHash: asNonEmptyString(
        body.canonicalSigningHash,
        asNonEmptyString(body.canonicalMessageHash),
      ),
      signedMessageHash: asNonEmptyString(
        body.signedMessageHash,
        asNonEmptyString(body.normalizedExternalMessageHash),
      ),
      publicKeyFingerprint: asNonEmptyString(body.publicKeyFingerprint),
      walletAddressRaw: asNonEmptyString(body.walletAddressRaw),
      signatureBase64: asNonEmptyString(body.signatureBase64),
      keySpec: asNonEmptyString(body.keySpec, asNonEmptyString(body.kmsKeySpec)),
      signingAlgorithm: asNonEmptyString(body.signingAlgorithm),
      signedWalletRequestBocBase64: asNonEmptyString(body.signedWalletRequestBocBase64),
      externalMessageBocBase64: boc,
      externalMessageCellHash: asNonEmptyString(body.externalMessageCellHash),
      normalizedExternalMessageHash: asNonEmptyString(
        body.normalizedExternalMessageHash,
        asNonEmptyString(body.signedMessageHash),
      ),
      ...(typeof body.signatureFingerprintHash === 'string'
        ? { signatureFingerprintHash: body.signatureFingerprintHash }
        : {}),
    };
  }
}
