/**
 * Re-export historical filename for transitional imports.
 * Prefer `./signing-key-provider.js`.
 */
export type {
  KmsKeyDescription,
  SignPort,
  SigningKeyDescription,
  LockableSignPort,
  SignerCustodyState,
} from './signing-key-provider.js';
