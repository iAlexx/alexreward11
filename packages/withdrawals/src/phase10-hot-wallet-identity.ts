/**
 * Read-only authoritative Hot Wallet identity for Phase 10 live probes.
 * Exposes public-key fingerprint (signer_reference) and raw address only.
 * Never returns private key material, passphrases, or API secrets.
 */

import type { Pool, PoolClient } from 'pg';

import { isPool } from './db.js';

export interface Phase10AuthoritativeHotWalletIdentity {
  readonly hotWalletId: string;
  readonly addressRaw: string;
  /** Public signer fingerprint / reference from hot_wallets.signer_reference. */
  readonly signerReference: string;
  readonly payoutJettonWalletAddress: string | null;
  readonly signerType: string;
  readonly networkCode: string;
}

async function withClient<T>(
  db: Pool | PoolClient,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!isPool(db)) return fn(db);
  const client = await db.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/**
 * Load the ACTIVE FALLBACK_ENCRYPTED Hot Wallet for TON_TESTNET (real-mode identity).
 * Returns null when absent or ambiguous — callers must treat absence as a live blocker.
 */
export async function loadPhase10AuthoritativeHotWalletIdentity(
  db: Pool | PoolClient,
  options?: { readonly networkCode?: string },
): Promise<Phase10AuthoritativeHotWalletIdentity | null> {
  const networkCode = options?.networkCode?.trim() || 'TON_TESTNET';
  return withClient(db, async (client) => {
    const rows = await client.query<{
      id: string;
      address: string;
      signer_reference: string;
      payout_jetton_wallet_address: string | null;
      signer_type: string;
      network_code: string;
    }>(
      `SELECT hw.id, hw.address, hw.signer_reference, hw.payout_jetton_wallet_address,
              hw.signer_type::text AS signer_type, n.code AS network_code
       FROM hot_wallets hw
       JOIN networks n ON n.id = hw.network_id
       WHERE n.code = $1
         AND hw.status = 'ACTIVE'
         AND hw.signer_type = 'FALLBACK_ENCRYPTED'
         AND hw.signer_reference NOT LIKE 'TEST_ONLY_FAKE%'`,
      [networkCode],
    );
    if ((rows.rowCount ?? 0) !== 1) return null;
    const row = rows.rows[0]!;
    if (row.signer_reference.trim() === '' || row.address.trim() === '') return null;
    return {
      hotWalletId: row.id,
      addressRaw: row.address.trim(),
      signerReference: row.signer_reference.trim(),
      payoutJettonWalletAddress: row.payout_jetton_wallet_address,
      signerType: row.signer_type,
      networkCode: row.network_code,
    };
  });
}
