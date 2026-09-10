import { createHash } from 'node:crypto';

import { Address, internal, type Cell } from '@ton/core';
import { signVerify } from '@ton/crypto';
import { WalletContractV5R1 } from '@ton/ton';
import type { Pool } from 'pg';

import {
  buildCanonicalSigningMessageAsync,
  buildJettonTransferBodyForIntent,
  SPIKE_JETTON_ATTACHED_TON,
  SPIKE_SEND_MODE,
  type CanonicalPayoutIntent,
} from './canonical-message.js';
import type { SignerRuntimeConfig } from './config.js';
import { SignerError } from './errors.js';
import {
  buildExternalInMessage,
  normalizeExternalInMessageHash,
  parseExternalInMessageFromBoc,
  walletStateInitForSeqno,
} from './external-message.js';
import type { SignPort, LockableSignPort } from './signing-key-provider.js';
import { publicKeyFingerprint } from './local-ephemeral-kms.js';
import { assertSigningPolicy } from './policy.js';
import { loadSigningView } from './read-model.js';
import { addressesEqual, deriveWalletV5R1 } from './wallet-v5r1.js';

export interface SignWithdrawalAttemptResult {
  readonly withdrawalAttemptId: string;
  readonly withdrawalId: string;
  readonly canonicalMessageHash: string;
  /** Alias of canonicalMessageHash: hash signed by the Ed25519 key. */
  readonly canonicalSigningHash: string;
  /**
   * @deprecated Chain lookup identity alias. Equals normalizedExternalMessageHash,
   * never SHA256(signature).
   */
  readonly signedMessageHash: string;
  readonly publicKeyFingerprint: string;
  readonly walletAddressRaw: string;
  readonly signatureBase64: string;
  readonly keySpec: string;
  /** @deprecated alias of keySpec — historical Phase 9 field name */
  readonly kmsKeySpec: string;
  readonly signingAlgorithm: string;
  /** Base64 BOC of the signed Wallet V5 R1 request body (not broadcastable alone). */
  readonly signedWalletRequestBocBase64: string;
  /**
   * Base64 BOC of the final External-In message.
   * Returned for broadcast outside apps/signer (signer never broadcasts).
   */
  readonly externalMessageBocBase64: string;
  /** Hash of the serialized final External-In message cell. */
  readonly externalMessageCellHash: string;
  /** Tonkeeper-normalized External-In message hash used for chain lookup. */
  readonly normalizedExternalMessageHash: string;
  /** SHA256(signature), retained only as a diagnostic fingerprint. */
  readonly signatureFingerprintHash?: string;
}

export interface SignWithdrawalAttemptInput {
  readonly pool: Pool;
  readonly withdrawalAttemptId: string;
  readonly signPort: SignPort;
  readonly config: SignerRuntimeConfig;
}

function intentFromRow(
  row: Awaited<ReturnType<typeof loadSigningView>>,
  publicKey: Buffer,
  config: SignerRuntimeConfig,
): CanonicalPayoutIntent {
  return {
    publicKey,
    networkGlobalId: config.networkGlobalId,
    workchain: config.workchain,
    subwalletNumber: 0,
    seqno: Number(row.expected_seqno),
    validUntil: Math.floor(row.valid_until.getTime() / 1000),
    queryId: BigInt(row.query_id),
    netAmountAtomic: BigInt(row.net_amount_atomic),
    recipientAddress: row.recipient_raw_address,
    hotWalletAddress: row.hot_wallet_address,
    payoutJettonWalletAddress: row.payout_jetton_wallet_address!,
    jettonMasterIdentity: row.asset_contract_identity!,
  };
}

export async function signWithdrawalAttempt(
  input: SignWithdrawalAttemptInput,
): Promise<SignWithdrawalAttemptResult> {
  const lockable = input.signPort as LockableSignPort;
  if (typeof lockable.isSigningReady === 'function' && !lockable.isSigningReady()) {
    throw new SignerError(
      'SIGNER_LOCKED',
      'Signer is LOCKED; signing requires explicit local unlock',
    );
  }

  const row = await loadSigningView(input.pool, input.withdrawalAttemptId);
  assertSigningPolicy(row, input.config);

  const publicKey = await input.signPort.getPublicKey();
  const derived = deriveWalletV5R1({
    publicKey,
    networkGlobalId: input.config.networkGlobalId,
    workchain: input.config.workchain,
  });

  if (!addressesEqual(derived.addressRaw, row.hot_wallet_address)) {
    throw new SignerError(
      'WALLET_MISMATCH',
      'Derived Wallet V5 R1 address does not match Hot Wallet',
      {
        derived: derived.addressRaw,
        hotWallet: row.hot_wallet_address,
      },
    );
  }

  const intent = intentFromRow(row, publicKey, input.config);
  const canonical = await buildCanonicalSigningMessageAsync(intent);

  if (row.canonical_message_hash !== canonical.canonicalMessageHashHex) {
    throw new SignerError(
      'CANONICAL_HASH_MISMATCH',
      'Recomputed canonical hash does not match authoritative attempt hash',
      {
        stored: row.canonical_message_hash,
        recomputed: canonical.canonicalMessageHashHex,
      },
    );
  }

  const description = await input.signPort.describe();
  let signature!: Buffer;
  let signingHash!: Buffer;

  const wallet = WalletContractV5R1.create({
    publicKey,
    workchain: intent.workchain,
    walletId: { networkGlobalId: intent.networkGlobalId },
  });

  const signedWalletRequestBody: Cell = await wallet.createTransfer({
    seqno: intent.seqno,
    timeout: intent.validUntil,
    sendMode: SPIKE_SEND_MODE,
    messages: [
      internal({
        to: Address.parse(intent.payoutJettonWalletAddress),
        value: SPIKE_JETTON_ATTACHED_TON,
        bounce: true,
        body: buildJettonTransferBodyForIntent(intent),
      }),
    ],
    authType: 'external',
    signer: async (messageCell: Cell) => {
      signingHash = Buffer.from(messageCell.hash());
      signature = await input.signPort.signEd25519RawMessage(signingHash);
      if (signature.length !== 64) {
        throw new SignerError('SIGNATURE_VERIFY_FAILED', 'Ed25519 signature must be 64 bytes');
      }
      return signature;
    },
  });

  if (signingHash.toString('hex') !== canonical.canonicalMessageHashHex) {
    throw new SignerError(
      'CANONICAL_HASH_MISMATCH',
      'Signing hash drifted from canonical reconstruction',
    );
  }

  if (!signVerify(signingHash, signature, publicKey)) {
    throw new SignerError('SIGNATURE_VERIFY_FAILED', 'Local Ed25519 verification failed');
  }

  const stateInit = walletStateInitForSeqno(intent.seqno, wallet.init);
  const externalMessageCell = buildExternalInMessage({
    walletAddress: wallet.address,
    signedWalletRequestBody,
    ...(stateInit === undefined ? {} : { stateInit }),
  });
  const signedWalletRequestBocBase64 = signedWalletRequestBody.toBoc().toString('base64');
  const externalMessageBocBase64 = externalMessageCell.toBoc().toString('base64');
  const parsedExternalMessage = parseExternalInMessageFromBoc(externalMessageBocBase64);
  const externalMessageCellHash = externalMessageCell.hash().toString('hex');
  const normalizedExternalMessageHash =
    normalizeExternalInMessageHash(parsedExternalMessage).toString('hex');
  const signatureFingerprintHash = createHash('sha256').update(signature).digest('hex');

  return {
    withdrawalAttemptId: row.withdrawal_attempt_id,
    withdrawalId: row.withdrawal_id,
    canonicalMessageHash: canonical.canonicalMessageHashHex,
    canonicalSigningHash: canonical.canonicalMessageHashHex,
    // Deprecated persistence alias; chain identity is the normalized External-In hash.
    signedMessageHash: normalizedExternalMessageHash,
    publicKeyFingerprint: publicKeyFingerprint(publicKey),
    walletAddressRaw: derived.addressRaw,
    signatureBase64: signature.toString('base64'),
    keySpec: description.keySpec,
    kmsKeySpec: description.keySpec,
    signingAlgorithm: description.signingAlgorithm,
    signedWalletRequestBocBase64,
    externalMessageBocBase64,
    externalMessageCellHash,
    normalizedExternalMessageHash,
    signatureFingerprintHash,
  };
}

export async function reconstructCanonicalHash(
  input: Omit<SignWithdrawalAttemptInput, 'signPort'> & { publicKey: Buffer },
): Promise<string> {
  const row = await loadSigningView(input.pool, input.withdrawalAttemptId);
  assertSigningPolicy(row, input.config);
  const intent = intentFromRow(row, input.publicKey, input.config);
  const canonical = await buildCanonicalSigningMessageAsync(intent);
  return canonical.canonicalMessageHashHex;
}
