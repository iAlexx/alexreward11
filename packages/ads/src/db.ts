/**
 * Database access boundary for packages/ads.
 *
 * Phase 11 rule (scripts/verify-boundaries.mjs): ads composes transactions through the
 * Reward Engine and MUST NOT import `@alex-rewards/ledger` or post ledger transactions.
 * The transaction helper is re-exported from `@alex-rewards/rewards` for that reason.
 */
export { isPool, withLedgerTransaction } from '@alex-rewards/rewards';
export type { LedgerDb as AdsDb } from '@alex-rewards/rewards';

export type { Pool } from '@alex-rewards/db';
