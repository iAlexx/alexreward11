import type { Pool, PoolClient } from 'pg';

import { isPool } from './db.js';

export type Phase10InvariantSeverity = 'PASS' | 'WARN' | 'FAIL';

export interface Phase10InvariantFinding {
  readonly code: string;
  readonly severity: Phase10InvariantSeverity;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface Phase10PayoutInvariantReport {
  readonly withdrawalId: string;
  readonly publicId: string | null;
  readonly state: string | null;
  readonly ok: boolean;
  readonly findings: readonly Phase10InvariantFinding[];
  readonly duplicateEconomicPayoutCount: number;
  readonly duplicateSettlementCount: number;
}

const STATES_REQUIRING_CHAIN_PROOF = new Set([
  'CONFIRMED',
  'CONFIRMING',
  'BROADCASTED',
  'RECONCILE_REQUIRED',
]);

async function withClient<T>(db: Pool | PoolClient, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!isPool(db)) return fn(db);
  const client = await db.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null;
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const v = record[key];
    if (typeof v === 'string' && v.trim() !== '') return v;
    if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  }
  return null;
}

function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function extractTxIdentity(summary: unknown): string | null {
  const record = asRecord(summary);
  if (record === null) return null;
  return readString(
    record,
    'txIdentity',
    'primaryTransactionIdentity',
    'transactionHash',
    'correlation_reference',
  );
}

export interface Phase10IntendedPayoutProofExpected {
  readonly withdrawalId: string;
  readonly attemptId: string | null;
  readonly queryId: string | null;
  readonly recipient: string | null;
  readonly amountAtomic: string | null;
  readonly jettonMaster: string | null;
  readonly hotWallet: string | null;
  readonly senderJettonWallet: string | null;
}

export interface Phase10IntendedPayoutProofOptions {
  /**
   * When true, additionally require live dual-provider acceptance bindings.
   * testPath proofs never qualify.
   */
  readonly requireLiveAcceptanceProof?: boolean;
}

/**
 * Authoritative intended-payout TEP-74 proof — rejects weak correlation.
 * Requires exact field binding when expected values exist. Never accepts
 * blockchain_transactions alone. Never allows networkGlobalId === undefined.
 */
export function isCompleteIntendedPayoutProof(
  summary: unknown,
  expected: Phase10IntendedPayoutProofExpected,
  options: Phase10IntendedPayoutProofOptions = {},
): boolean {
  const record = asRecord(summary);
  if (record === null) return false;

  const proofStage = readString(record, 'proofStage', 'primaryProofStage');
  const complete =
    proofStage === 'COMPLETE' ||
    record.tep74Complete === true ||
    record.fullTep74 === true ||
    record.proofComplete === true;
  if (!complete) return false;

  const withdrawalId = readString(record, 'withdrawalId', 'withdrawal_id');
  const attemptId = readString(record, 'attemptId', 'attempt_id');
  const queryId = readString(record, 'queryId', 'query_id');
  const recipient = readString(
    record,
    'recipient',
    'expectedRecipient',
    'observed_recipient',
  );
  const amount = readString(
    record,
    'amountAtomic',
    'expectedAmountAtomic',
    'amount_atomic',
  );
  const jettonMaster = readString(record, 'jettonMaster', 'jetton_master');
  const hotWallet = readString(record, 'hotWallet', 'hot_wallet');
  const senderJetton = readString(record, 'senderJettonWallet', 'sender_jetton_wallet');
  const success = record.success === true;
  const nonBounce =
    record.bounced === false || record.nonBounce === true || record.non_bounce === true;
  const txIdentity = extractTxIdentity(summary);

  // Required bound fields — never optional for a complete intended-payout proof.
  if (
    !success ||
    !nonBounce ||
    txIdentity === null ||
    withdrawalId === null ||
    queryId === null ||
    recipient === null ||
    amount === null ||
    jettonMaster === null
  ) {
    return false;
  }

  // networkGlobalId must be exactly Testnet (-3); undefined never passes.
  const networkGlobalId =
    typeof record.networkGlobalId === 'number'
      ? record.networkGlobalId
      : typeof record.network_global_id === 'number'
        ? record.network_global_id
        : undefined;
  if (networkGlobalId !== -3) return false;

  if (withdrawalId !== expected.withdrawalId) return false;

  // When expected bindings exist, proof must carry matching values (missing = fail).
  if (expected.attemptId !== null) {
    if (attemptId === null || attemptId !== expected.attemptId) return false;
  }
  if (expected.queryId !== null) {
    if (queryId !== expected.queryId) return false;
  }
  if (expected.recipient !== null) {
    if (!sameAddress(recipient, expected.recipient)) return false;
  }
  if (expected.amountAtomic !== null) {
    if (amount !== expected.amountAtomic) return false;
  }
  if (expected.jettonMaster !== null) {
    if (!sameAddress(jettonMaster, expected.jettonMaster)) return false;
  }
  if (expected.hotWallet !== null) {
    if (hotWallet === null || !sameAddress(hotWallet, expected.hotWallet)) return false;
  }
  if (expected.senderJettonWallet !== null) {
    if (senderJetton === null || !sameAddress(senderJetton, expected.senderJettonWallet)) {
      return false;
    }
  }

  if (options.requireLiveAcceptanceProof === true) {
    if (record.testPath === true) return false;
    if (record.secondaryAgree !== true) return false;

    const primaryProviderIdentity = readString(
      record,
      'primaryProviderIdentity',
      'primaryProviderKind',
      'primary_provider_kind',
      'primaryProvider',
    );
    const secondaryProviderIdentity = readString(
      record,
      'secondaryProviderIdentity',
      'secondaryProviderKind',
      'secondary_provider_kind',
      'secondaryProvider',
    );
    if (primaryProviderIdentity === null || secondaryProviderIdentity === null) return false;

    const secondaryProofStage = readString(record, 'secondaryProofStage', 'secondary_proof_stage');
    const secondaryComplete =
      secondaryProofStage === 'COMPLETE' ||
      record.secondaryTep74Complete === true ||
      record.secondaryProofComplete === true;
    if (!secondaryComplete) return false;

    const secondaryTxIdentity = readString(
      record,
      'secondaryTxIdentity',
      'secondaryTransactionIdentity',
      'secondaryTransactionHash',
      'secondary_tx_identity',
    );
    if (secondaryTxIdentity === null) return false;

    if (record.secondarySuccess !== true) return false;
    const secondaryNonBounce =
      record.secondaryNonBounce === true ||
      record.secondary_non_bounce === true ||
      record.secondaryBounced === false;
    if (!secondaryNonBounce) return false;
  }

  return true;
}

export interface CheckPhase10PayoutInvariantsOptions {
  /** When true, chain proof must satisfy live dual-provider acceptance bindings. */
  readonly requireLiveAcceptanceProof?: boolean;
}

/**
 * Read-only Phase 10 payout invariant checker — fail-closed on weak chain correlation.
 * blockchain_transactions existence alone NEVER yields PASS.
 */
export async function checkPhase10PayoutInvariants(
  db: Pool | PoolClient,
  withdrawalId: string,
  options: CheckPhase10PayoutInvariantsOptions = {},
): Promise<Phase10PayoutInvariantReport> {
  return withClient(db, async (client) => {
    const findings: Phase10InvariantFinding[] = [];
    let duplicateEconomicPayoutCount = 0;
    let duplicateSettlementCount = 0;

    const w = await client.query<{
      id: string;
      public_id: string;
      state: string;
      net_amount_atomic: string;
      reservation_ledger_tx_id: string | null;
      settlement_ledger_tx_id: string | null;
      release_ledger_tx_id: string | null;
      hot_wallet_id: string | null;
      wallet_id: string;
      asset_id: string;
    }>(
      `SELECT id, public_id, state::text AS state, net_amount_atomic::text,
              reservation_ledger_tx_id, settlement_ledger_tx_id, release_ledger_tx_id,
              hot_wallet_id, wallet_id, asset_id
       FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    const row = w.rows[0];
    if (row === undefined) {
      return {
        withdrawalId,
        publicId: null,
        state: null,
        ok: false,
        findings: [
          {
            code: 'WITHDRAWAL_NOT_FOUND',
            severity: 'FAIL',
            message: 'withdrawal not found',
          },
        ],
        duplicateEconomicPayoutCount: 0,
        duplicateSettlementCount: 0,
      };
    }

    // --- Reservation (fail-closed: pointer alone never PASSes) ---
    if (row.reservation_ledger_tx_id === null) {
      findings.push({
        code: 'RESERVATION_MISSING',
        severity: 'FAIL',
        message: 'expected reservation ledger effect missing',
      });
    } else {
      const pointed = await client.query<{
        id: string;
        business_reference_type: string | null;
        business_reference_id: string | null;
        transaction_type: string;
      }>(
        `SELECT id,
                business_reference_type,
                business_reference_id::text AS business_reference_id,
                transaction_type::text AS transaction_type
         FROM ledger_transactions
         WHERE id = $1::uuid`,
        [row.reservation_ledger_tx_id],
      );
      const pointedRow = pointed.rows[0];
      const pointerValid =
        pointedRow !== undefined &&
        pointedRow.transaction_type === 'WITHDRAWAL_RESERVATION' &&
        pointedRow.business_reference_type === 'withdrawal' &&
        pointedRow.business_reference_id === withdrawalId;

      const reservationEffects = await client.query<{ id: string }>(
        `SELECT id
         FROM ledger_transactions
         WHERE business_reference_type = 'withdrawal'
           AND business_reference_id = $1::uuid
           AND transaction_type::text = 'WITHDRAWAL_RESERVATION'
         ORDER BY id ASC`,
        [withdrawalId],
      );
      const effectIds = reservationEffects.rows.map((r) => r.id);
      const effectCount = effectIds.length;

      if (!pointerValid || effectCount === 0) {
        findings.push({
          code: 'RESERVATION_MISSING',
          severity: 'FAIL',
          message:
            'reservation pointer missing, unresolved, or not the authoritative withdrawal reservation',
          details: {
            reservationLedgerTxId: row.reservation_ledger_tx_id,
            pointerValid,
            effectCount,
          },
        });
      } else if (effectCount > 1) {
        findings.push({
          code: 'DUPLICATE_RESERVATION',
          severity: 'FAIL',
          message: `duplicate reservation economic effects=${effectCount}`,
          details: {
            reservationLedgerTxId: row.reservation_ledger_tx_id,
            reservationIds: effectIds,
          },
        });
      } else if (effectIds[0] !== row.reservation_ledger_tx_id) {
        findings.push({
          code: 'RESERVATION_MISSING',
          severity: 'FAIL',
          message: 'reservation pointer does not match the single authoritative reservation effect',
          details: {
            reservationLedgerTxId: row.reservation_ledger_tx_id,
            authoritativeId: effectIds[0],
          },
        });
      } else {
        findings.push({
          code: 'RESERVATION_ONCE',
          severity: 'PASS',
          message: 'exactly one authoritative withdrawal reservation ledger effect',
          details: {
            reservationLedgerTxId: row.reservation_ledger_tx_id,
            effectCount: 1,
          },
        });
      }
    }

    // --- Settlement: CONFIRMED requires settlement; settlement without CONFIRMED is FAIL ---
    if (row.state === 'CONFIRMED') {
      if (row.settlement_ledger_tx_id === null) {
        findings.push({
          code: 'SETTLEMENT_MISSING',
          severity: 'FAIL',
          message: 'CONFIRMED without settlement_ledger_tx_id',
        });
      } else {
        const settleRows = await client.query<{ id: string }>(
          `SELECT id FROM ledger_transactions
           WHERE id = $1::uuid
              OR (
                business_reference_type IN ('withdrawal', 'withdrawal_settlement')
                AND business_reference_id = $2::uuid
                AND transaction_type::text ILIKE '%SETTLE%'
              )`,
          [row.settlement_ledger_tx_id, withdrawalId],
        );
        const distinct = new Set(settleRows.rows.map((r) => r.id));
        if (!distinct.has(row.settlement_ledger_tx_id)) {
          findings.push({
            code: 'SETTLEMENT_POINTER_MISMATCH',
            severity: 'FAIL',
            message: 'settlement pointer does not resolve to a settlement ledger transaction',
          });
        }
        if (distinct.size > 1) {
          duplicateSettlementCount = distinct.size - 1;
          findings.push({
            code: 'DUPLICATE_SETTLEMENT',
            severity: 'FAIL',
            message: `duplicate settlement economic effects=${distinct.size}`,
            details: { settlementIds: [...distinct] },
          });
        } else {
          findings.push({
            code: 'SETTLEMENT_ONCE',
            severity: 'PASS',
            message: 'exactly one settlement ledger effect',
          });
        }

        const feeLines = await client.query<{ c: number }>(
          `SELECT count(*)::int AS c
           FROM ledger_entries e
           JOIN ledger_accounts a ON a.id = e.ledger_account_id
           WHERE e.ledger_transaction_id = $1::uuid
             AND (
               a.account_type::text ILIKE '%FEE%'
               OR a.account_type::text = 'PLATFORM_FEE_REVENUE'
             )`,
          [row.settlement_ledger_tx_id],
        );
        const feeCount = feeLines.rows[0]?.c ?? 0;
        if (feeCount > 1) {
          findings.push({
            code: 'DUPLICATE_FEE_REVENUE',
            severity: 'FAIL',
            message: `fee revenue lines=${feeCount}`,
          });
        } else {
          findings.push({
            code: 'FEE_REVENUE',
            severity: feeCount === 1 ? 'PASS' : 'WARN',
            message:
              feeCount === 1
                ? 'fee revenue represented once on settlement'
                : 'fee revenue line not found on settlement (schema-dependent)',
            details: { feeCount },
          });
        }
      }
    } else if (row.settlement_ledger_tx_id !== null) {
      findings.push({
        code: 'SETTLEMENT_STATE_MISMATCH',
        severity: 'FAIL',
        message: 'settlement present but state is not CONFIRMED',
        details: { state: row.state },
      });
    }

    // --- Attempts / blind resend ---
    const attempts = await client.query<{
      id: string;
      attempt_number: number;
      broadcast_result_state: string;
      broadcast_submitted_at: Date | null;
      broadcast_ambiguity_class: string | null;
      query_id: string;
    }>(
      `SELECT id, attempt_number,
              broadcast_result_state::text AS broadcast_result_state,
              broadcast_submitted_at, broadcast_ambiguity_class,
              query_id::text AS query_id
       FROM withdrawal_attempts
       WHERE withdrawal_id = $1::uuid
       ORDER BY attempt_number ASC`,
      [withdrawalId],
    );

    const submitted = attempts.rows.filter((a) => a.broadcast_submitted_at !== null);
    const unresolvedSubmitted = submitted.filter((a) =>
      ['UNKNOWN', 'RECONCILE_REQUIRED', 'BROADCASTED', 'PENDING'].includes(a.broadcast_result_state),
    );
    let blindResend = false;
    if (submitted.length > 1) {
      const nonpayment = await client.query<{ c: number }>(
        `SELECT count(*)::int AS c
         FROM withdrawal_payout_reconciliations
         WHERE withdrawal_id = $1::uuid
           AND resolution = 'DEFINITIVE_NONPAYMENT'`,
        [withdrawalId],
      );
      if ((nonpayment.rows[0]?.c ?? 0) === 0) {
        blindResend = true;
      }
    }
    for (let i = 0; i < attempts.rows.length; i += 1) {
      const a = attempts.rows[i]!;
      const priorUnresolved = attempts.rows
        .slice(0, i)
        .some(
          (p) =>
            p.broadcast_submitted_at !== null &&
            ['UNKNOWN', 'RECONCILE_REQUIRED', 'BROADCASTED'].includes(p.broadcast_result_state),
        );
      if (priorUnresolved && a.broadcast_submitted_at !== null) {
        blindResend = true;
      }
      if (
        priorUnresolved &&
        a.broadcast_result_state === 'PENDING' &&
        a.broadcast_submitted_at === null
      ) {
        findings.push({
          code: 'ATTEMPT_AFTER_UNRESOLVED',
          severity: 'FAIL',
          message: 'attempt created after unresolved possibly-broadcast attempt',
          details: { attemptId: a.id },
        });
      }
    }
    findings.push({
      code: 'BLIND_RESEND',
      severity: blindResend ? 'FAIL' : 'PASS',
      message: blindResend
        ? 'multiple submitted attempts without definitive non-payment boundary'
        : 'no blind-resend indicators',
      details: {
        submittedAttemptCount: submitted.length,
        unresolvedSubmittedCount: unresolvedSubmitted.length,
      },
    });

    // --- External payout / chain proof ---
    const recipientRow = await client.query<{ recipient: string }>(
      `SELECT COALESCE(raw_address, friendly_address) AS recipient
       FROM user_wallets WHERE id = $1::uuid`,
      [row.wallet_id],
    );
    const hotRow = await client.query<{
      address: string;
      payout_jetton_wallet_address: string | null;
    }>(
      `SELECT address, payout_jetton_wallet_address FROM hot_wallets WHERE id = $1::uuid`,
      [row.hot_wallet_id],
    );
    const assetRow = await client.query<{ contract_identity: string | null }>(
      `SELECT contract_identity FROM assets WHERE id = $1::uuid`,
      [row.asset_id],
    );
    const expectedRecipient = recipientRow.rows[0]?.recipient ?? null;
    const expectedHot = hotRow.rows[0]?.address ?? null;
    const expectedSenderJetton = hotRow.rows[0]?.payout_jetton_wallet_address ?? null;
    const expectedJetton = assetRow.rows[0]?.contract_identity ?? null;
    const latestAttempt = attempts.rows[attempts.rows.length - 1] ?? null;

    const proofs = await client.query<{
      id: string;
      resolution: string;
      evidence_summary: unknown;
      withdrawal_attempt_id: string;
      observed_query_id: string | null;
      observed_amount_atomic: string | null;
      observed_recipient: string | null;
      correlation_reference: string | null;
    }>(
      `SELECT id, resolution::text AS resolution, evidence_summary,
              withdrawal_attempt_id::text AS withdrawal_attempt_id,
              observed_query_id::text AS observed_query_id,
              observed_amount_atomic::text AS observed_amount_atomic,
              observed_recipient,
              correlation_reference
       FROM withdrawal_payout_reconciliations
       WHERE withdrawal_id = $1::uuid
       ORDER BY created_at ASC`,
      [withdrawalId],
    );

    // Informational only — never used to PASS chain proof.
    const chainTx = await client.query<{ c: number }>(
      `SELECT count(*)::int AS c
       FROM blockchain_transactions bt
       JOIN withdrawal_attempts a ON a.id = bt.withdrawal_attempt_id
       WHERE a.withdrawal_id = $1::uuid`,
      [withdrawalId],
    );
    const blockchainTxCount = chainTx.rows[0]?.c ?? 0;

    const intendedProven = proofs.rows.filter((p) => p.resolution === 'INTENDED_PAYOUT_PROVEN');
    const completeProofs = intendedProven.filter((p) =>
      isCompleteIntendedPayoutProof(
        p.evidence_summary,
        {
          withdrawalId: row.id,
          attemptId: p.withdrawal_attempt_id,
          queryId: p.observed_query_id ?? latestAttempt?.query_id ?? null,
          recipient: p.observed_recipient ?? expectedRecipient,
          amountAtomic: p.observed_amount_atomic ?? row.net_amount_atomic,
          jettonMaster: expectedJetton,
          hotWallet: expectedHot,
          senderJettonWallet: expectedSenderJetton,
        },
        { requireLiveAcceptanceProof: options.requireLiveAcceptanceProof === true },
      ),
    );

    // Duplicate economic payout: multiple distinct INTENDED_PAYOUT_PROVEN tx identities.
    const provenTxIdentities = new Set<string>();
    for (const p of intendedProven) {
      const tx =
        extractTxIdentity(p.evidence_summary) ??
        (typeof p.correlation_reference === 'string' && p.correlation_reference.trim() !== ''
          ? p.correlation_reference
          : null);
      if (tx !== null) {
        provenTxIdentities.add(tx);
      } else {
        // Distinct proof rows without shared identity still count as distinct payouts.
        provenTxIdentities.add(`proof:${p.id}`);
      }
    }
    if (provenTxIdentities.size > 1) {
      duplicateEconomicPayoutCount = provenTxIdentities.size - 1;
      findings.push({
        code: 'DUPLICATE_EXTERNAL_PAYOUT',
        severity: 'FAIL',
        message: `duplicate economic payout count=${duplicateEconomicPayoutCount}`,
        details: { provenTxIdentities: [...provenTxIdentities] },
      });
    }

    const needsChainProof = STATES_REQUIRING_CHAIN_PROOF.has(row.state);
    if (needsChainProof) {
      if (completeProofs.length === 0) {
        findings.push({
          code: 'CHAIN_PROOF_REQUIRED',
          severity: 'FAIL',
          message:
            'CHAIN_PROOF_REQUIRED: state requires durable complete TEP-74 INTENDED_PAYOUT_PROVEN with field binding',
          details: {
            state: row.state,
            intendedProvenRows: intendedProven.length,
            blockchainTransactionsCount: blockchainTxCount,
            note: 'blockchain_transactions row alone is never sufficient; CHAIN_PROOF_REQUIRED is never PASS',
          },
        });
      } else {
        findings.push({
          code: 'CHAIN_PROOF',
          severity: 'PASS',
          message:
            'complete INTENDED_PAYOUT_PROVEN TEP-74 evidence present with field binding',
          details: {
            proofIds: completeProofs.map((p) => p.id),
            blockchainTransactionsCount: blockchainTxCount,
          },
        });
      }
    }

    // --- Unsafe release after possible broadcast ---
    if (row.release_ledger_tx_id !== null) {
      const hadPossibleBroadcast = submitted.some((a) =>
        ['UNKNOWN', 'RECONCILE_REQUIRED', 'BROADCASTED'].includes(a.broadcast_result_state),
      );
      const definitiveNonpayment = proofs.rows.some(
        (p) => p.resolution === 'DEFINITIVE_NONPAYMENT',
      );
      if (hadPossibleBroadcast && !definitiveNonpayment) {
        findings.push({
          code: 'UNSAFE_RELEASE',
          severity: 'FAIL',
          message:
            'release after possible broadcast without authoritative DEFINITIVE_NONPAYMENT proof',
        });
      } else {
        findings.push({
          code: 'RELEASE',
          severity: 'PASS',
          message: 'release present with safe boundary or no ambiguous broadcast',
        });
      }
    }

    const ok = !findings.some((f) => f.severity === 'FAIL');
    return {
      withdrawalId: row.id,
      publicId: row.public_id,
      state: row.state,
      ok,
      findings,
      duplicateEconomicPayoutCount,
      duplicateSettlementCount,
    };
  });
}
