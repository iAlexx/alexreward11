/**
 * Self-hosted encrypted Ed25519 signing provider (FALLBACK_ENCRYPTED).
 * Boots LOCKED. Usable private material exists only in process memory after unlock.
 */
import { sign } from '@ton/crypto';

import {
  decryptKeyBundle,
  loadKeyBundleFile,
  publicKeyFingerprintHex,
  scrubBuffer,
  type DecryptedSigningMaterial,
  type EncryptedKeyBundleV1,
} from './encrypted-key-bundle.js';
import { SignerError } from './errors.js';
import { addressesEqual, deriveWalletV5R1 } from './wallet-v5r1.js';
import type {
  LockableSignPort,
  SignerCustodyState,
  SigningKeyDescription,
} from './signing-key-provider.js';

export interface EncryptedLocalSigningProviderOptions {
  /** Path to authenticated encrypted key bundle (not secret). */
  readonly bundlePath?: string;
  /** In-memory bundle for tests (mutually exclusive with bundlePath at unlock). */
  readonly bundle?: EncryptedKeyBundleV1;
  /** Authoritative Hot Wallet raw address that must match derived identity. */
  readonly expectedHotWalletAddressRaw?: string | null;
  /** Expected public key fingerprint (signer_reference). */
  readonly expectedPublicKeyFingerprint?: string | null;
  readonly expectedNetworkGlobalId?: number;
}

export class EncryptedLocalSigningProvider implements LockableSignPort {
  readonly kind = 'fallback_encrypted' as const;
  private state: SignerCustodyState = 'LOCKED';
  private material: DecryptedSigningMaterial | undefined;
  private readonly opts: EncryptedLocalSigningProviderOptions;

  constructor(opts: EncryptedLocalSigningProviderOptions = {}) {
    this.opts = opts;
  }

  get custodyState(): SignerCustodyState {
    return this.state;
  }

  isSigningReady(): boolean {
    return this.state === 'UNLOCKED' && this.material !== undefined;
  }

  async unlock(passphrase: string): Promise<void> {
    const bundle =
      this.opts.bundle ??
      (this.opts.bundlePath !== undefined
        ? loadKeyBundleFile(this.opts.bundlePath)
        : (() => {
            throw new SignerError('KEY_BUNDLE_MISSING', 'No encrypted key bundle configured');
          })());

    const expectedNet = this.opts.expectedNetworkGlobalId ?? -3;
    if (bundle.networkGlobalId !== expectedNet) {
      throw new SignerError('KEY_IDENTITY_MISMATCH', 'Bundle networkGlobalId mismatch', {
        bundleNetworkGlobalId: bundle.networkGlobalId,
        expected: expectedNet,
      });
    }

    let material: DecryptedSigningMaterial;
    try {
      material = decryptKeyBundle(bundle, passphrase);
    } catch (error) {
      this.relock();
      throw error;
    }

    if (
      this.opts.expectedPublicKeyFingerprint !== undefined &&
      this.opts.expectedPublicKeyFingerprint !== null &&
      material.publicKeyFingerprint !== this.opts.expectedPublicKeyFingerprint
    ) {
      scrubBuffer(material.seed);
      scrubBuffer(material.secretKey);
      throw new SignerError(
        'KEY_IDENTITY_MISMATCH',
        'Public key fingerprint does not match expected Hot Wallet',
      );
    }

    if (
      this.opts.expectedHotWalletAddressRaw !== undefined &&
      this.opts.expectedHotWalletAddressRaw !== null &&
      !addressesEqual(material.addressRaw, this.opts.expectedHotWalletAddressRaw)
    ) {
      scrubBuffer(material.seed);
      scrubBuffer(material.secretKey);
      throw new SignerError(
        'KEY_IDENTITY_MISMATCH',
        'Derived Wallet V5 R1 address does not match Hot Wallet',
      );
    }

    // Re-derive address for defense in depth
    const derived = deriveWalletV5R1({
      publicKey: material.publicKey,
      networkGlobalId: material.networkGlobalId,
      workchain: material.workchain,
    });
    if (!addressesEqual(derived.addressRaw, material.addressRaw)) {
      scrubBuffer(material.seed);
      scrubBuffer(material.secretKey);
      throw new SignerError('KEY_IDENTITY_MISMATCH', 'Wallet V5 R1 re-derivation failed');
    }

    this.relock();
    this.material = material;
    this.state = 'UNLOCKED';
  }

  /**
   * Best-effort destroy of in-memory signing material.
   * JavaScript/Node.js cannot provide a mathematical guarantee of perfect zeroization.
   */
  relock(): void {
    if (this.material !== undefined) {
      scrubBuffer(this.material.seed);
      scrubBuffer(this.material.secretKey);
      scrubBuffer(this.material.publicKey);
    }
    this.material = undefined;
    this.state = 'LOCKED';
  }

  async getPublicKey(): Promise<Buffer> {
    this.assertUnlocked();
    return Buffer.from(this.material!.publicKey);
  }

  async signEd25519RawMessage(message: Buffer): Promise<Buffer> {
    this.assertUnlocked();
    return Buffer.from(sign(message, this.material!.secretKey));
  }

  async describe(): Promise<SigningKeyDescription> {
    return {
      keySpec: 'SELF_HOSTED_ENCRYPTED_ED25519',
      keyUsage: 'SIGN_VERIFY',
      signingAlgorithm: 'ED25519_SHA_512',
      messageType: 'RAW',
      provider: 'EncryptedLocalSigningProvider',
    };
  }

  publicKeyFingerprint(): string {
    this.assertUnlocked();
    return publicKeyFingerprintHex(this.material!.publicKey);
  }

  private assertUnlocked(): void {
    if (this.state !== 'UNLOCKED' || this.material === undefined) {
      throw new SignerError(
        'SIGNER_LOCKED',
        'Signer is LOCKED; signing requires explicit local unlock',
      );
    }
  }
}
