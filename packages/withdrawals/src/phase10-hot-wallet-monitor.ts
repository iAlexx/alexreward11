import { readFile } from 'node:fs/promises';

import type { TonChainProvider } from '@alex-rewards/ton';
import type { Pool, PoolClient } from 'pg';

import { isPool } from './db.js';

export const PHASE10_HOT_WALLET_CHAIN_HISTORY_PROOF_REQUIRED = 'CHAIN_HISTORY_PROOF_REQUIRED' as const;

export interface Phase10HotWalletBalanceObservations {
  readonly tonNanotons?: string | null;
  readonly jettonAtomic?: string | null;
  readonly observedAt?: string | null;
  readonly source?: 'injected' | 'provider';
}

export interface Phase10HotWalletBalanceBaseline {
  readonly tonNanotons?: string | null;
  readonly jettonAtomic?: string | null;
}

export interface Phase10HotWalletMonitorInput {
  readonly networkCode?: string;
  /** Prefer FALLBACK_ENCRYPTED when fakeChainEnabled is false. */
  readonly fakeChainEnabled?: boolean;
  readonly jettonMasterIdentity?: string | null;
  /** Injected observations — default path never calls external providers. */
  readonly balanceObservations?: Phase10HotWalletBalanceObservations | null;
  /** Optional provider for live read-only observe path only. */
  readonly provider?: TonChainProvider | null;
  /** When true and provider is set, fetch native TON + Jetton balances via provider. */
  readonly observeProvider?: boolean;
  /** Optional campaign evidence JSON path for expected confirmed payout counts. */
  readonly campaignEvidencePath?: string | null;
  /** Optional minimum gas reserve (nanotons) to flag sufficiency. */
  readonly minGasReserveNanotons?: string | null;
  /** Optional next payout jetton amount (atomic) to flag sufficiency. */
  readonly nextPayoutJettonAtomic?: string | null;
  /** Optional baseline balances for delta/drift reporting. */
  readonly balanceBaseline?: Phase10HotWalletBalanceBaseline | null;
  /**
   * When true, caller asserts unexpected-outgoing history was proven elsewhere.
   * Default false → emit CHAIN_HISTORY_PROOF_REQUIRED (never silent PASS).
   */
  readonly unexpectedOutgoingHistoryProven?: boolean;
}

export interface Phase10HotWalletMonitorReport {
  readonly observedAt: string;
  readonly hotWallet: {
    readonly id: string;
    readonly address: string;
    readonly friendlyAddress: string | null;
    readonly signerType: string;
    readonly status: string;
    readonly walletVersion: string;
    readonly payoutJettonWalletAddress: string | null;
    readonly networkId: string;
  } | null;
  readonly jettonWalletConfigured: boolean;
  readonly jettonMasterConfigured: boolean;
  readonly jettonMasterIdentity: string | null;
  readonly unresolvedSubmittedOrUnknownAttempts: number;
  readonly confirmedOutgoingCount: number;
  readonly expectedConfirmedCampaignPayouts: number | null;
  readonly gasReserve: {
    readonly minRequiredNanotons: string | null;
    readonly observedNanotons: string | null;
    readonly sufficient: boolean | null;
  };
  readonly jettonForNextPayout: {
    readonly requiredAtomic: string | null;
    readonly observedAtomic: string | null;
    readonly sufficient: boolean | null;
  };
  readonly balanceDelta: {
    readonly tonNanotons: string | null;
    readonly jettonAtomic: string | null;
    readonly baselinePresent: boolean;
  };
  readonly balances: {
    readonly tonNanotons: string | null;
    readonly jettonAtomic: string | null;
    readonly source: 'injected' | 'provider' | 'none';
    readonly observedAt: string | null;
  };
  readonly chainHistoryProof: {
    readonly status: 'PROOF_REQUIRED' | 'PROVEN_BY_OPERATOR';
    readonly code: 'CHAIN_HISTORY_PROOF_REQUIRED' | null;
  };
  readonly notes: readonly string[];
}

async function withClient<T>(db: Pool | PoolClient, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!isPool(db)) return fn(db);
  const client = await db.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

function bigIntOrNull(value: string | null | undefined): bigint | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function deltaString(current: string | null, baseline: string | null | undefined): string | null {
  const a = bigIntOrNull(current);
  const b = bigIntOrNull(baseline ?? null);
  if (a === null || b === null) return null;
  return (a - b).toString(10);
}

async function readExpectedConfirmedFromCampaign(
  path: string | null | undefined,
): Promise<number | null> {
  if (path === null || path === undefined || path.trim() === '') return null;
  try {
    const raw = await readFile(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const file = parsed as {
      records?: ReadonlyArray<{ finalState?: string; state?: string }>;
      payouts?: ReadonlyArray<{ finalWithdrawalState?: string; state?: string }>;
      plannedCount?: number;
    };
    const pools = [file.records, file.payouts];
    let confirmed = 0;
    let saw = false;
    for (const pool of pools) {
      if (pool === undefined) continue;
      saw = true;
      for (const row of pool) {
        const state =
          ('finalState' in row && typeof row.finalState === 'string' ? row.finalState : null) ??
          ('finalWithdrawalState' in row && typeof row.finalWithdrawalState === 'string'
            ? row.finalWithdrawalState
            : null) ??
          ('state' in row && typeof row.state === 'string' ? row.state : null);
        if (state === 'CONFIRMED') confirmed += 1;
      }
    }
    if (saw) return confirmed;
    if (typeof file.plannedCount === 'number') return file.plannedCount;
    return null;
  } catch {
    return null;
  }
}

/**
 * Read-only hot wallet monitor report.
 * Default path accepts injected balance numbers and does not call external providers.
 * Live provider mode is deliberate (provider + observeProvider) and still never broadcasts.
 */
export async function buildPhase10HotWalletMonitorReport(
  db: Pool | PoolClient,
  input: Phase10HotWalletMonitorInput = {},
): Promise<Phase10HotWalletMonitorReport> {
  return withClient(db, async (client) => {
    const notes: string[] = [];
    const networkCode = (input.networkCode ?? 'TON_TESTNET').trim().toUpperCase();
    const fakeChainEnabled = input.fakeChainEnabled === true;
    const jettonMasterIdentity = input.jettonMasterIdentity?.trim() || null;
    const liveProvider =
      input.provider != null && (input.observeProvider === true || input.balanceObservations == null);

    const network = await client.query<{ id: string }>(
      `SELECT id FROM networks WHERE code = $1`,
      [networkCode],
    );
    const networkId = network.rows[0]?.id;
    if (networkId === undefined) {
      notes.push(`network ${networkCode} not found`);
      notes.push('CHAIN_HISTORY_PROOF_REQUIRED: cannot prove unexpected outgoing transfers');
      return {
        observedAt: new Date().toISOString(),
        hotWallet: null,
        jettonWalletConfigured: false,
        jettonMasterConfigured: jettonMasterIdentity !== null,
        jettonMasterIdentity,
        unresolvedSubmittedOrUnknownAttempts: 0,
        confirmedOutgoingCount: 0,
        expectedConfirmedCampaignPayouts: null,
        gasReserve: {
          minRequiredNanotons: input.minGasReserveNanotons ?? null,
          observedNanotons: null,
          sufficient: null,
        },
        jettonForNextPayout: {
          requiredAtomic: input.nextPayoutJettonAtomic ?? null,
          observedAtomic: null,
          sufficient: null,
        },
        balanceDelta: { tonNanotons: null, jettonAtomic: null, baselinePresent: false },
        balances: {
          tonNanotons: null,
          jettonAtomic: null,
          source: 'none',
          observedAt: null,
        },
        chainHistoryProof: {
          status: 'PROOF_REQUIRED',
          code: 'CHAIN_HISTORY_PROOF_REQUIRED',
        },
        notes,
      };
    }

    const hot = fakeChainEnabled
      ? await client.query<{
          id: string;
          address: string;
          friendly_address: string | null;
          signer_type: string;
          status: string;
          wallet_version: string;
          payout_jetton_wallet_address: string | null;
          network_id: string;
        }>(
          `SELECT id, address, friendly_address, signer_type::text AS signer_type,
                  status::text AS status, wallet_version, payout_jetton_wallet_address, network_id
           FROM hot_wallets
           WHERE network_id = $1::uuid
             AND status = 'ACTIVE'
             AND signer_reference LIKE 'TEST_ONLY_FAKE%'
           ORDER BY created_at ASC
           LIMIT 2`,
          [networkId],
        )
      : await client.query<{
          id: string;
          address: string;
          friendly_address: string | null;
          signer_type: string;
          status: string;
          wallet_version: string;
          payout_jetton_wallet_address: string | null;
          network_id: string;
        }>(
          `SELECT id, address, friendly_address, signer_type::text AS signer_type,
                  status::text AS status, wallet_version, payout_jetton_wallet_address, network_id
           FROM hot_wallets
           WHERE network_id = $1::uuid
             AND status = 'ACTIVE'
             AND signer_type = 'FALLBACK_ENCRYPTED'
           ORDER BY created_at ASC
           LIMIT 2`,
          [networkId],
        );

    if ((hot.rowCount ?? 0) === 0) {
      notes.push('no ACTIVE hot wallet for mode');
    } else if ((hot.rowCount ?? 0) > 1) {
      notes.push('ambiguous ACTIVE hot wallets; reporting first row only');
    }

    const row = hot.rows[0] ?? null;
    const hotWallet =
      row === null
        ? null
        : {
            id: row.id,
            address: row.address,
            friendlyAddress: row.friendly_address,
            signerType: row.signer_type,
            status: row.status,
            walletVersion: row.wallet_version,
            payoutJettonWalletAddress: row.payout_jetton_wallet_address,
            networkId: row.network_id,
          };

    const jettonWalletConfigured =
      hotWallet?.payoutJettonWalletAddress !== null &&
      hotWallet?.payoutJettonWalletAddress !== undefined &&
      hotWallet.payoutJettonWalletAddress.trim() !== '';

    let unresolvedSubmittedOrUnknownAttempts = 0;
    let confirmedOutgoingCount = 0;
    if (hotWallet !== null) {
      const unresolved = await client.query<{ c: number }>(
        `SELECT count(*)::int AS c
         FROM withdrawal_attempts
         WHERE hot_wallet_id = $1::uuid
           AND (
             broadcast_result_state IN ('UNKNOWN', 'RECONCILE_REQUIRED')
             OR (broadcast_submitted_at IS NOT NULL
                 AND broadcast_result_state IN ('PENDING', 'BROADCASTED', 'UNKNOWN', 'RECONCILE_REQUIRED')
                 AND settled_at IS NULL)
           )`,
        [hotWallet.id],
      );
      unresolvedSubmittedOrUnknownAttempts = unresolved.rows[0]?.c ?? 0;
      if (unresolvedSubmittedOrUnknownAttempts > 0) {
        notes.push(
          `unresolved submitted/UNKNOWN/RECONCILE_REQUIRED attempts=${unresolvedSubmittedOrUnknownAttempts}`,
        );
      }

      const confirmed = await client.query<{ c: number }>(
        `SELECT count(*)::int AS c
         FROM withdrawals
         WHERE hot_wallet_id = $1::uuid AND state = 'CONFIRMED'`,
        [hotWallet.id],
      );
      confirmedOutgoingCount = confirmed.rows[0]?.c ?? 0;
    }

    const expectedConfirmedCampaignPayouts = await readExpectedConfirmedFromCampaign(
      input.campaignEvidencePath,
    );
    if (expectedConfirmedCampaignPayouts !== null) {
      notes.push(
        `expected confirmed campaign payouts from evidence=${expectedConfirmedCampaignPayouts}; db confirmedOutgoingCount=${confirmedOutgoingCount}`,
      );
    }

    let tonNanotons: string | null = input.balanceObservations?.tonNanotons ?? null;
    let jettonAtomic: string | null = input.balanceObservations?.jettonAtomic ?? null;
    let balanceSource: 'injected' | 'provider' | 'none' =
      input.balanceObservations != null ? 'injected' : 'none';
    let balanceObservedAt: string | null = input.balanceObservations?.observedAt ?? null;

    if (liveProvider && input.provider != null && hotWallet !== null) {
      try {
        const ton = await input.provider.getAccountBalance(hotWallet.address);
        tonNanotons = ton.balanceNanotons;
        if (jettonMasterIdentity !== null) {
          const jetton = await input.provider.getJettonBalance(
            hotWallet.address,
            jettonMasterIdentity,
          );
          jettonAtomic = jetton.balanceAtomic;
        }
        balanceSource = 'provider';
        balanceObservedAt = new Date().toISOString();
        notes.push('live read-only provider balance observe');
      } catch (error) {
        notes.push(
          `provider observe failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else if (input.provider == null || input.observeProvider !== true) {
      notes.push(
        'default path: balances from injected observations only (no external provider call)',
      );
    }

    const minGas = input.minGasReserveNanotons ?? null;
    const tonBal = bigIntOrNull(tonNanotons);
    const minGasBal = bigIntOrNull(minGas);
    const gasSufficient =
      tonBal !== null && minGasBal !== null ? tonBal >= minGasBal : minGas === null ? null : false;
    if (gasSufficient === false) {
      notes.push('insufficient native TON vs min gas reserve');
    }

    const nextJetton = input.nextPayoutJettonAtomic ?? null;
    const jettonBal = bigIntOrNull(jettonAtomic);
    const nextBal = bigIntOrNull(nextJetton);
    const jettonSufficient =
      jettonBal !== null && nextBal !== null
        ? jettonBal >= nextBal
        : nextJetton === null
          ? null
          : false;
    if (jettonSufficient === false) {
      notes.push('insufficient Jetton balance for next payout amount');
    }

    const baseline = input.balanceBaseline ?? null;
    const baselinePresent = baseline != null;
    const balanceDelta = {
      tonNanotons: deltaString(tonNanotons, baseline?.tonNanotons),
      jettonAtomic: deltaString(jettonAtomic, baseline?.jettonAtomic),
      baselinePresent,
    };
    if (baselinePresent) {
      notes.push(
        `balance delta vs baseline: ton=${balanceDelta.tonNanotons ?? 'n/a'} jetton=${balanceDelta.jettonAtomic ?? 'n/a'}`,
      );
    }

    const historyProven = input.unexpectedOutgoingHistoryProven === true;
    if (!historyProven) {
      notes.push(
        'CHAIN_HISTORY_PROOF_REQUIRED: provider balance observe alone cannot prove unexpected outgoing transfers; never silent PASS',
      );
    }

    return {
      observedAt: new Date().toISOString(),
      hotWallet,
      jettonWalletConfigured,
      jettonMasterConfigured: jettonMasterIdentity !== null,
      jettonMasterIdentity,
      unresolvedSubmittedOrUnknownAttempts,
      confirmedOutgoingCount,
      expectedConfirmedCampaignPayouts,
      gasReserve: {
        minRequiredNanotons: minGas,
        observedNanotons: tonNanotons,
        sufficient: gasSufficient,
      },
      jettonForNextPayout: {
        requiredAtomic: nextJetton,
        observedAtomic: jettonAtomic,
        sufficient: jettonSufficient,
      },
      balanceDelta,
      balances: {
        tonNanotons,
        jettonAtomic,
        source: balanceSource,
        observedAt: balanceObservedAt,
      },
      chainHistoryProof: historyProven
        ? { status: 'PROVEN_BY_OPERATOR', code: null }
        : { status: 'PROOF_REQUIRED', code: 'CHAIN_HISTORY_PROOF_REQUIRED' },
      notes,
    };
  });
}
