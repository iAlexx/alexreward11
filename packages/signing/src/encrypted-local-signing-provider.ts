/**
 * Self-hosted encrypted Ed25519 signing provider (FALLBACK_ENCRYPTED).
 * Boots LOCKED. Usable private material exists only in process memory after unlock.
 *
 * Fail-closed rule: ANY unlock failure leaves custodyState=LOCKED and signingReady=false,
 * including when the provider was already UNLOCKED (prior key material is destroyed).
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

function scrubMaterial(material: DecryptedSigningMaterial | undefined): void {
  if (material === undefined) return;
  scrubBuffer(material.seed);
  scrubBuffer(material.secretKey);
  scrubBuffer(material.publicKey);
}

export class EncryptedLocalSigningProvider implements LockableSignPort {
  readonly kind = 'fallback_encrypted' as const;
  private state: SignerCustodyState = 'LOCKED';
  private material: DecryptedSigningMaterial | undefined;
  private readonly opts: EncryptedLocalSigningProviderOptions;
  /** Optional runtime bundle override (e.g. operator swap / tests). Does not unlock. */
  private bundleOverride: EncryptedKeyBundleV1 | undefined;

  constructor(opts: EncryptedLocalSigningProviderOptions = {}) {
    this.opts = opts;
  }

  get custodyState(): SignerCustodyState {
    return this.state;
  }

  isSigningReady(): boolean {
    return this.state === 'UNLOCKED' && this.material !== undefined;
  }

  /**
   * Replace the encrypted bundle reference without unlocking.
   * Does not mutate financial records or custody state by itself.
   */
  replaceBundle(bundle: EncryptedKeyBundleV1): void {
    this.bundleOverride = bundle;
  }

  async unlock(passphrase: string): Promise<void> {
    let candidate: DecryptedSigningMaterial | undefined;
    try {
      const bundle = this.resolveBundle();

      const expectedNet = this.opts.expectedNetworkGlobalId ?? -3;
      if (bundle.networkGlobalId !== expectedNet) {
        throw new SignerError('KEY_IDENTITY_MISMATCH', 'Bundle networkGlobalId mismatch', {
          bundleNetworkGlobalId: bundle.networkGlobalId,
          expected: expectedNet,
        });
      }

      candidate = decryptKeyBundle(bundle, passphrase);

      if (
        this.opts.expectedPublicKeyFingerprint !== undefined &&
        this.opts.expectedPublicKeyFingerprint !== null &&
        candidate.publicKeyFingerprint !== this.opts.expectedPublicKeyFingerprint
      ) {
        throw new SignerError(
          'KEY_IDENTITY_MISMATCH',
          'Public key fingerprint does not match expected Hot Wallet',
        );
      }

      if (
        this.opts.expectedHotWalletAddressRaw !== undefined &&
        this.opts.expectedHotWalletAddressRaw !== null &&
        !addressesEqual(candidate.addressRaw, this.opts.expectedHotWalletAddressRaw)
      ) {
        throw new SignerError(
          'KEY_IDENTITY_MISMATCH',
          'Derived Wallet V5 R1 address does not match Hot Wallet',
        );
      }

      const derived = deriveWalletV5R1({
        publicKey: candidate.publicKey,
        networkGlobalId: candidate.networkGlobalId,
        workchain: candidate.workchain,
      });
      if (!addressesEqual(derived.addressRaw, candidate.addressRaw)) {
        throw new SignerError('KEY_IDENTITY_MISMATCH', 'Wallet V5 R1 re-derivation failed');
      }

      // Success path: destroy any previously unlocked material, then install candidate.
      this.relock();
      this.material = candidate;
      candidate = undefined;
      this.state = 'UNLOCKED';
    } catch (error) {
      scrubMaterial(candidate);
      // Fail closed: destroy any previously usable key and remain LOCKED.
      this.relock();
      throw error;
    }
  }

  /**
   * Best-effort destroy of in-memory signing material.
   * JavaScript/Node.js cannot provide a mathematical guarantee of perfect zeroization.
   */
  relock(): void {
    scrubMaterial(this.material);
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

  private resolveBundle(): EncryptedKeyBundleV1 {
    if (this.bundleOverride !== undefined) {
      return this.bundleOverride;
    }
    if (this.opts.bundle !== undefined) {
      return this.opts.bundle;
    }
    if (this.opts.bundlePath !== undefined) {
      return loadKeyBundleFile(this.opts.bundlePath);
    }
    throw new SignerError('KEY_BUNDLE_MISSING', 'No encrypted key bundle configured');
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
