import type { CDPSession, Page } from '@playwright/test';

/**
 * Enable Chromium virtual authenticator for WebAuthn registration/assertion.
 */
export async function enableVirtualAuthenticator(page: Page): Promise<CDPSession> {
  const client = await page.context().newCDPSession(page);
  await client.send('WebAuthn.enable');
  await client.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return client;
}

/**
 * Complete WebAuthn registration in-page using a virtual authenticator.
 * Returns a RegistrationResponseJSON-compatible object for the verify API.
 */
export async function createPasskeyCredential(
  page: Page,
  optionsJSON: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return page.evaluate(async (options) => {
    function base64UrlToBuffer(value: string): ArrayBuffer {
      const padded = value.replace(/-/g, '+').replace(/_/g, '/');
      const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
      const binary = atob(padded + pad);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return bytes.buffer;
    }
    function bufferToBase64Url(buffer: ArrayBuffer): string {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (const b of bytes) binary += String.fromCharCode(b);
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    }

    const user = options.user as { id: string; name: string; displayName: string };
    const exclude =
      (options.excludeCredentials as Array<{ id: string; type: string }> | undefined) ?? [];
    const publicKey: PublicKeyCredentialCreationOptions = {
      rp: options.rp as PublicKeyCredentialRpEntity,
      user: {
        id: base64UrlToBuffer(user.id),
        name: user.name,
        displayName: user.displayName,
      },
      challenge: base64UrlToBuffer(options.challenge as string),
      pubKeyCredParams: options.pubKeyCredParams as PublicKeyCredentialParameters[],
      timeout: options.timeout as number | undefined,
      attestation: options.attestation as AttestationConveyancePreference | undefined,
      authenticatorSelection:
        options.authenticatorSelection as AuthenticatorSelectionCriteria | undefined,
      excludeCredentials: exclude.map((c) => ({
        id: base64UrlToBuffer(c.id),
        type: c.type as PublicKeyCredentialType,
      })),
    };

    const credential = (await navigator.credentials.create({
      publicKey,
    })) as PublicKeyCredential | null;
    if (credential === null) throw new Error('credentials.create returned null');
    const response = credential.response as AuthenticatorAttestationResponse;
    return {
      id: credential.id,
      rawId: bufferToBase64Url(credential.rawId),
      type: credential.type,
      clientExtensionResults: credential.getClientExtensionResults(),
      response: {
        clientDataJSON: bufferToBase64Url(response.clientDataJSON),
        attestationObject: bufferToBase64Url(response.attestationObject),
        transports:
          typeof response.getTransports === 'function' ? response.getTransports() : ['internal'],
      },
    };
  }, optionsJSON);
}

/**
 * Complete WebAuthn authentication assertion in-page.
 */
export async function getPasskeyAssertion(
  page: Page,
  optionsJSON: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return page.evaluate(async (options) => {
    function base64UrlToBuffer(value: string): ArrayBuffer {
      const padded = value.replace(/-/g, '+').replace(/_/g, '/');
      const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
      const binary = atob(padded + pad);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return bytes.buffer;
    }
    function bufferToBase64Url(buffer: ArrayBuffer): string {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (const b of bytes) binary += String.fromCharCode(b);
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    }

    const allow =
      (options.allowCredentials as Array<{ id: string; type: string }> | undefined) ?? [];
    const publicKey: PublicKeyCredentialRequestOptions = {
      challenge: base64UrlToBuffer(options.challenge as string),
      timeout: options.timeout as number | undefined,
      rpId: options.rpId as string | undefined,
      userVerification: options.userVerification as UserVerificationRequirement | undefined,
      allowCredentials: allow.map((c) => ({
        id: base64UrlToBuffer(c.id),
        type: c.type as PublicKeyCredentialType,
      })),
    };

    const credential = (await navigator.credentials.get({
      publicKey,
    })) as PublicKeyCredential | null;
    if (credential === null) throw new Error('credentials.get returned null');
    const response = credential.response as AuthenticatorAssertionResponse;
    return {
      id: credential.id,
      rawId: bufferToBase64Url(credential.rawId),
      type: credential.type,
      clientExtensionResults: credential.getClientExtensionResults(),
      response: {
        clientDataJSON: bufferToBase64Url(response.clientDataJSON),
        authenticatorData: bufferToBase64Url(response.authenticatorData),
        signature: bufferToBase64Url(response.signature),
        userHandle: response.userHandle === null ? null : bufferToBase64Url(response.userHandle),
      },
    };
  }, optionsJSON);
}
