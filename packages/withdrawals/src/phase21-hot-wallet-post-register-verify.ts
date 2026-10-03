/**
 * Read-only post-register verification of the intended Mainnet Hot Wallet row.
 */
import type { PoolClient } from 'pg';

import { tonAddressesEqual } from '@alex-rewards/ton';

import { PHASE21_WALLET_VERSION } from './phase21-config.js';

export class Phase21HotWalletPostRegisterVerifyError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'Phase21HotWalletPostRegisterVerifyError';
    this.code = code;
    this.details = details;
  }
}

export type Phase21HotWalletPostRegisterExpected = {
  readonly address: string;
  readonly signerReference: string;
  readonly payoutJettonWalletAddress: string;
  readonly friendlyAddress?: string | null;
  readonly hotWalletId?: string | null;
};

export type Phase21HotWalletPostRegisterVerifyResult = {
  readonly ok: true;
  readonly readOnly: true;
  readonly hotWalletId: string;
  readonly networkCode: 'TON_MAINNET';
  readonly walletVersion: string;
  readonly signerType: 'FALLBACK_ENCRYPTED';
  readonly status: 'ACTIVE';
  readonly address: string;
  readonly friendlyAddress: string | null;
  readonly signerReferenceFingerprintPrefix: string;
  readonly payoutJettonWalletAddress: string;
  readonly readyForLivePayout: false;
  readonly sanitized: true;
};

export async function verifyPhase21HotWalletRegistrationReadOnly(
  client: PoolClient,
  expected: Phase21HotWalletPostRegisterExpected,
): Promise<Phase21HotWalletPostRegisterVerifyResult> {
  await client.query('BEGIN READ ONLY');
  try {
    const ro = await client.query<{ transaction_read_only: string }>(
      `SHOW transaction_read_only`,
    );
    const flag = (ro.rows[0]?.transaction_read_only ?? '').toLowerCase();
    if (flag !== 'on') {
      throw new Phase21HotWalletPostRegisterVerifyError(
        'READ_ONLY_TRANSACTION_REQUIRED',
        'SHOW transaction_read_only must be on for post-register verify',
        { transaction_read_only: flag },
      );
    }

    const network = await client.query<{ id: string }>(
      `SELECT id FROM networks WHERE code = 'TON_MAINNET' LIMIT 1`,
    );
    const networkId = network.rows[0]?.id;
    if (networkId === undefined) {
      throw new Phase21HotWalletPostRegisterVerifyError(
        'NETWORK_MISSING',
        'TON_MAINNET network missing',
        {},
      );
    }

    const rows = await client.query<{
      id: string;
      address: string;
      friendly_address: string | null;
      wallet_version: string;
      signer_type: string;
      signer_reference: string;
      status: string;
      payout_jetton_wallet_address: string | null;
    }>(
      `SELECT id, address, friendly_address, wallet_version,
              signer_type::text AS signer_type, signer_reference,
              status::text AS status, payout_jetton_wallet_address
       FROM hot_wallets
       WHERE network_id = $1::uuid
         AND status = 'ACTIVE'
         AND signer_type = 'FALLBACK_ENCRYPTED'
         AND wallet_version = $2`,
      [networkId, PHASE21_WALLET_VERSION],
    );

    if (rows.rows.length !== 1) {
      throw new Phase21HotWalletPostRegisterVerifyError(
        'HOT_WALLET_COUNT_MISMATCH',
        'expected exactly one ACTIVE FALLBACK_ENCRYPTED v5R1 Mainnet hot wallet',
        { count: rows.rows.length },
      );
    }

    const row = rows.rows[0]!;
    if (expected.hotWalletId !== undefined && expected.hotWalletId !== null) {
      if (row.id !== expected.hotWalletId) {
        throw new Phase21HotWalletPostRegisterVerifyError(
          'HOT_WALLET_ID_MISMATCH',
          'registered hot wallet id mismatch',
          {},
        );
      }
    }
    if (
      !tonAddressesEqual(row.address, expected.address) &&
      !(row.friendly_address !== null && tonAddressesEqual(row.friendly_address, expected.address))
    ) {
      throw new Phase21HotWalletPostRegisterVerifyError(
        'HOT_WALLET_ADDRESS_MISMATCH',
        'registered hot wallet address mismatch',
        {},
      );
    }
    if (row.signer_reference.trim().toLowerCase() !== expected.signerReference.trim().toLowerCase()) {
      throw new Phase21HotWalletPostRegisterVerifyError(
        'HOT_WALLET_SIGNER_REFERENCE_MISMATCH',
        'registered signer_reference mismatch',
        {},
      );
    }
    if (
      row.payout_jetton_wallet_address === null ||
      !tonAddressesEqual(row.payout_jetton_wallet_address, expected.payoutJettonWalletAddress)
    ) {
      throw new Phase21HotWalletPostRegisterVerifyError(
        'HOT_WALLET_PAYOUT_JETTON_MISMATCH',
        'registered payout jetton wallet mismatch',
        {},
      );
    }
    if (
      expected.friendlyAddress !== undefined &&
      expected.friendlyAddress !== null &&
      expected.friendlyAddress.trim() !== ''
    ) {
      if (
        row.friendly_address === null ||
        !tonAddressesEqual(row.friendly_address, expected.friendlyAddress)
      ) {
        throw new Phase21HotWalletPostRegisterVerifyError(
          'HOT_WALLET_FRIENDLY_MISMATCH',
          'registered friendly address mismatch',
          {},
        );
      }
    }

    return {
      ok: true,
      readOnly: true,
      hotWalletId: row.id,
      networkCode: 'TON_MAINNET',
      walletVersion: row.wallet_version,
      signerType: 'FALLBACK_ENCRYPTED',
      status: 'ACTIVE',
      address: row.address,
      friendlyAddress: row.friendly_address,
      signerReferenceFingerprintPrefix: row.signer_reference.slice(0, 16) + '…',
      payoutJettonWalletAddress: row.payout_jetton_wallet_address,
      readyForLivePayout: false,
      sanitized: true,
    };
  } finally {
    await client.query('ROLLBACK');
  }
}
