/**
 * Phase 10 USDT-Z pre-manifest canary binding exemption (Owner-authorized B3 Option C).
 *
 * Sole purpose: allow ONE fixed withdrawal UUID to bypass
 * `requested_at >= campaign.createdAt` when every strict guard passes.
 *
 * Historical context: campaign tooling initialized the acceptance manifest AFTER
 * the Owner-authorized USDT-Z canary (WD-000002) and attached it as ordinal 1.
 * `campaign.createdAt` is manifest bootstrap time, not the economic canary start.
 * Backdating createdAt is forbidden; this UUID-keyed predicate is the narrow fix.
 *
 * Fail closed. Never keyed by publicId alone.
 */

/** Sole authorized Phase 10 USDT-Z acceptance-campaign canary withdrawal UUID. */
export const PHASE10_USDT_Z_CANARY_WITHDRAWAL_ID =
  '01a0cc13-cdec-77ea-8561-2a79690e2a47' as const;

export interface Phase10PreManifestCanaryAuthorizationInput {
  readonly withdrawalId: string | null | undefined;
  readonly campaignWithdrawalIds: readonly string[] | null | undefined;
  /** Evidence ordinal for this withdrawal (must be exactly 1). */
  readonly evidenceOrdinal: number | null | undefined;
  /** Authoritative withdrawal.state (must be CONFIRMED). */
  readonly withdrawalState: string | null | undefined;
  /** Non-empty settlement_ledger_tx_id. */
  readonly settlementLedgerTxId: string | null | undefined;
  /** Durable INTENDED_PAYOUT_PROVEN present. */
  readonly hasIntendedPayoutProven: boolean;
  /** Final successful attempt id linked to IPP / evidence. */
  readonly finalSuccessfulAttemptId: string | null | undefined;
  /** Campaign manifest baselineIsolatedHistoricalAttemptIds allowlist. */
  readonly baselineIsolatedHistoricalAttemptIds: readonly string[] | null | undefined;
  /**
   * Campaign evidence invariantResult PASS (or equivalent).
   * Missing/false → refuse exemption.
   */
  readonly evidenceInvariantPass: boolean | null | undefined;
}

function readNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function normalizeAllowlist(
  ids: readonly string[] | null | undefined,
): ReadonlySet<string> | null {
  if (ids === null || ids === undefined) return null;
  if (!Array.isArray(ids)) return null;
  const out = new Set<string>();
  for (const id of ids) {
    const normalized = readNonEmpty(typeof id === 'string' ? id : null);
    if (normalized !== null) out.add(normalized);
  }
  return out;
}

/**
 * Returns true only when ALL Owner-authorized canary guards pass.
 * Authorizes bypass of `requested_at >= campaign.createdAt` solely for
 * {@link PHASE10_USDT_Z_CANARY_WITHDRAWAL_ID}.
 */
export function isAuthorizedPhase10PreManifestCanary(
  input: Phase10PreManifestCanaryAuthorizationInput,
): boolean {
  const withdrawalId = readNonEmpty(input.withdrawalId);
  if (withdrawalId === null) return false;
  if (withdrawalId !== PHASE10_USDT_Z_CANARY_WITHDRAWAL_ID) return false;

  if (!Array.isArray(input.campaignWithdrawalIds) || input.campaignWithdrawalIds.length === 0) {
    return false;
  }
  const membership = input.campaignWithdrawalIds.some(
    (id) => readNonEmpty(typeof id === 'string' ? id : null) === withdrawalId,
  );
  if (!membership) return false;

  if (input.evidenceOrdinal !== 1) return false;

  const state = readNonEmpty(input.withdrawalState);
  if (state !== 'CONFIRMED') return false;

  if (readNonEmpty(input.settlementLedgerTxId) === null) return false;

  if (input.hasIntendedPayoutProven !== true) return false;

  const attemptId = readNonEmpty(input.finalSuccessfulAttemptId);
  if (attemptId === null) return false;

  const allowlist = normalizeAllowlist(input.baselineIsolatedHistoricalAttemptIds);
  if (allowlist === null || allowlist.size === 0) return false;
  if (!allowlist.has(attemptId)) return false;

  if (input.evidenceInvariantPass !== true) return false;

  return true;
}
