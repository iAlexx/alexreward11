import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach } from 'vitest';

import { assertTransitionAllowed, isTerminalState, type WithdrawalState } from '../src/index.js';
import {
  phase7DatabaseUrl,
  resetAndMigrate,
  seedPhase7Base,
  truncateWithdrawalTables,
} from './harness.js';

const ALL_STATES: WithdrawalState[] = [
  'REQUESTED',
  'RISK_CHECK',
  'MANUAL_REVIEW',
  'APPROVED',
  'QUEUED',
  'SIGNING',
  'BROADCASTING',
  'BROADCASTED',
  'CONFIRMING',
  'CONFIRMED',
  'HELD',
  'FAILED_PRE_BROADCAST',
  'RECONCILE_REQUIRED',
  'REJECTED',
];

const ALLOWED: ReadonlyArray<readonly [WithdrawalState, WithdrawalState]> = [
  ['REQUESTED', 'RISK_CHECK'],
  ['RISK_CHECK', 'MANUAL_REVIEW'],
  ['RISK_CHECK', 'HELD'],
  ['RISK_CHECK', 'REJECTED'],
  ['MANUAL_REVIEW', 'APPROVED'],
  ['MANUAL_REVIEW', 'HELD'],
  ['MANUAL_REVIEW', 'REJECTED'],
  ['APPROVED', 'QUEUED'],
  ['APPROVED', 'HELD'],
  ['HELD', 'MANUAL_REVIEW'],
  ['HELD', 'APPROVED'],
  ['HELD', 'REJECTED'],
  ['HELD', 'RECONCILE_REQUIRED'],
  ['QUEUED', 'SIGNING'],
  ['QUEUED', 'HELD'],
  ['SIGNING', 'BROADCASTING'],
  ['SIGNING', 'FAILED_PRE_BROADCAST'],
  ['FAILED_PRE_BROADCAST', 'QUEUED'],
  ['FAILED_PRE_BROADCAST', 'HELD'],
  ['FAILED_PRE_BROADCAST', 'REJECTED'],
  ['BROADCASTING', 'BROADCASTED'],
  ['BROADCASTING', 'RECONCILE_REQUIRED'],
  ['BROADCASTED', 'CONFIRMING'],
  ['BROADCASTED', 'RECONCILE_REQUIRED'],
  ['CONFIRMING', 'CONFIRMED'],
  ['CONFIRMING', 'RECONCILE_REQUIRED'],
  ['RECONCILE_REQUIRED', 'CONFIRMED'],
  ['RECONCILE_REQUIRED', 'QUEUED'],
  ['RECONCILE_REQUIRED', 'HELD'],
];

describe('Phase 7 state machine (unit)', () => {
  it('allows every documented transition via assertTransitionAllowed', () => {
    for (const [from, to] of ALLOWED) {
      expect(() => assertTransitionAllowed(from, to)).not.toThrow();
    }
  });

  it('forbids REQUESTED→CONFIRMED', () => {
    expect(() => assertTransitionAllowed('REQUESTED', 'CONFIRMED')).toThrow(/TRANSITION_FORBIDDEN/);
  });

  it('forbids MANUAL_REVIEW→BROADCASTING', () => {
    expect(() => assertTransitionAllowed('MANUAL_REVIEW', 'BROADCASTING')).toThrow(
      /TRANSITION_FORBIDDEN/,
    );
  });

  it('forbids APPROVED→CONFIRMED', () => {
    expect(() => assertTransitionAllowed('APPROVED', 'CONFIRMED')).toThrow(/TRANSITION_FORBIDDEN/);
  });

  it('forbids BROADCASTING→REJECTED', () => {
    expect(() => assertTransitionAllowed('BROADCASTING', 'REJECTED')).toThrow(
      /TRANSITION_FORBIDDEN/,
    );
  });

  it('forbids RECONCILE_REQUIRED→REJECTED', () => {
    expect(() => assertTransitionAllowed('RECONCILE_REQUIRED', 'REJECTED')).toThrow(
      /TRANSITION_FORBIDDEN/,
    );
  });

  it('forbids CONFIRMED→*', () => {
    for (const to of ALL_STATES) {
      expect(() => assertTransitionAllowed('CONFIRMED', to)).toThrow(/TRANSITION_FORBIDDEN/);
    }
  });

  it('forbids REJECTED→*', () => {
    for (const to of ALL_STATES) {
      expect(() => assertTransitionAllowed('REJECTED', to)).toThrow(/TRANSITION_FORBIDDEN/);
    }
  });

  it('forbids RISK_CHECK → APPROVED (no auto-payout)', () => {
    expect(() => assertTransitionAllowed('RISK_CHECK', 'APPROVED')).toThrow(/TRANSITION_FORBIDDEN/);
  });

  it('forbids reconcile-origin HELD → APPROVE', () => {
    expect(() => assertTransitionAllowed('HELD', 'APPROVED', { heldFromReconcile: true })).toThrow(
      /TRANSITION_FORBIDDEN/,
    );
  });

  it('forbids reconcile-origin HELD → REJECT without definitiveNonpayment', () => {
    expect(() => assertTransitionAllowed('HELD', 'REJECTED', { heldFromReconcile: true })).toThrow(
      /TRANSITION_FORBIDDEN/,
    );
  });

  it('allows reconcile-origin HELD → REJECT with definitiveNonpayment', () => {
    expect(() =>
      assertTransitionAllowed('HELD', 'REJECTED', {
        heldFromReconcile: true,
        definitiveNonpayment: true,
      }),
    ).not.toThrow();
  });

  it('marks CONFIRMED and REJECTED terminal', () => {
    expect(isTerminalState('CONFIRMED')).toBe(true);
    expect(isTerminalState('REJECTED')).toBe(true);
    expect(isTerminalState('MANUAL_REVIEW')).toBe(false);
  });
});

describe.skipIf(phase7DatabaseUrl === '')('Phase 7 state machine (DB enum presence)', () => {
  let pool: Pool;

  beforeAll(async () => {
    await resetAndMigrate(phase7DatabaseUrl);
    pool = new Pool({ connectionString: phase7DatabaseUrl });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await truncateWithdrawalTables(pool);
    await seedPhase7Base(pool);
  });

  it('withdrawal_state enum includes all Phase 7 states', async () => {
    const result = await pool.query<{ enumlabel: string }>(
      `SELECT e.enumlabel
       FROM pg_type t
       JOIN pg_enum e ON t.oid = e.enumtypid
       WHERE t.typname = 'withdrawal_state'
       ORDER BY e.enumsortorder`,
    );
    const labels = new Set(result.rows.map((r) => r.enumlabel));
    for (const state of ALL_STATES) {
      expect(labels.has(state)).toBe(true);
    }
  });
});
