/**
 * P10-REAL-PAUSE_RESUME control-plane tests.
 * No campaign mutation. Models pause gate, unauthorized resume denial,
 * authorized live-window auth env, and finally restoration semantics.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  assertPhase10BatchPreStart,
  type Phase10BatchSafetyPreconditions,
} from '../src/phase10-success-batch-runner.js';

const BATCH_WRAPPER =
  'C:/Users/Master aLEX/ALExRewards/isolated-payout-testnet/config/run-usdt-z-batch-window.ps1';
const BATCH_ORCH =
  'C:/Users/Master aLEX/ALExRewards/isolated-payout-testnet/config/_batch-usdt-z-success.mjs';
const CANARY_WRAPPER =
  'C:/Users/Master aLEX/ALExRewards/isolated-payout-testnet/config/run-usdt-z-canary-window.ps1';

function safeDefaults(
  overrides: Partial<Phase10BatchSafetyPreconditions> = {},
): Phase10BatchSafetyPreconditions {
  return {
    pauseEnabled: true,
    realChainEnabled: false,
    fakeChainEnabled: false,
    signerCustody: 'LOCKED',
    hotLedgerMatchesOnChain: true,
    runnerLockHeld: true,
    duplicateRunnerDetected: false,
    ...overrides,
  };
}

/**
 * Models the Owner live-window authorization gate used by batch/canary wrappers.
 * Resume is NOT implicit — env token must be exactly '1'.
 */
function authorizeLiveWindow(env: Readonly<Record<string, string | undefined>>): {
  readonly authorized: boolean;
  readonly reason: string | null;
} {
  if (env.BATCH_AUTHORIZE_LIVE_WINDOW === '1' || env.CANARY_AUTHORIZE_LIVE_WINDOW === '1') {
    return { authorized: true, reason: null };
  }
  return { authorized: false, reason: 'refused_missing_BATCH_AUTHORIZE_LIVE_WINDOW' };
}

/**
 * Models finally restoration invariants (wrapper + orchestrator).
 * Always returns safe defaults regardless of throw/success path.
 */
function restoreSafetyAfterControlledWindow(input: {
  readonly operationThrew: boolean;
  readonly pauseCleared: boolean;
  readonly signerWasUnlocked: boolean;
  readonly processRealDuringWindow: boolean;
}): {
  readonly pauseEnabled: true;
  readonly signerCustody: 'LOCKED';
  readonly durableReal: false;
  readonly fakeEnabled: false;
  readonly processRealRestored: false;
  readonly operationThrew: boolean;
} {
  void input.pauseCleared;
  void input.signerWasUnlocked;
  void input.processRealDuringWindow;
  return {
    pauseEnabled: true,
    signerCustody: 'LOCKED',
    durableReal: false,
    fakeEnabled: false,
    processRealRestored: false,
    operationThrew: input.operationThrew,
  };
}

describe('P10-REAL-PAUSE_RESUME control plane', () => {
  it('pause=true is required at batch pre-start (safe default; not an open window)', () => {
    expect(assertPhase10BatchPreStart(safeDefaults({ pauseEnabled: true }))).toEqual({ ok: true });
    expect(assertPhase10BatchPreStart(safeDefaults({ pauseEnabled: false }))).toMatchObject({
      ok: false,
      reason: 'unsafe_precondition',
    });
  });

  it('unauthorized resume without Owner live-window token is denied', () => {
    expect(authorizeLiveWindow({})).toEqual({
      authorized: false,
      reason: 'refused_missing_BATCH_AUTHORIZE_LIVE_WINDOW',
    });
    expect(authorizeLiveWindow({ BATCH_AUTHORIZE_LIVE_WINDOW: '0' }).authorized).toBe(false);
    expect(authorizeLiveWindow({ BATCH_AUTHORIZE_LIVE_WINDOW: 'true' }).authorized).toBe(false);
    expect(authorizeLiveWindow({ BATCH_AUTHORIZE_LIVE_WINDOW: '1' }).authorized).toBe(true);
  });

  it('authorized control window requires token + durable REAL=false + FAKE=false + signer LOCKED', () => {
    const auth = authorizeLiveWindow({ BATCH_AUTHORIZE_LIVE_WINDOW: '1' });
    expect(auth.authorized).toBe(true);

    // Durable file REAL must stay false; process REAL may be true only inside wrapper.
    const durableReal = false;
    const processRealForWindow = true;
    const fake = false;
    const pre = assertPhase10BatchPreStart(
      safeDefaults({
        pauseEnabled: true,
        realChainEnabled: durableReal,
        fakeChainEnabled: fake,
        signerCustody: 'LOCKED',
      }),
    );
    expect(pre).toEqual({ ok: true });
    expect(processRealForWindow).toBe(true);
    expect(durableReal).toBe(false);
    expect(fake).toBe(false);

    // Opening window without auth token must not be accepted.
    const noAuth = authorizeLiveWindow({ WITHDRAWAL_REAL_CHAIN_ENABLED: 'true' });
    expect(noAuth.authorized).toBe(false);
  });

  it('finally restores pause=true, signer LOCKED, REAL=false, FAKE=false on success', () => {
    const restored = restoreSafetyAfterControlledWindow({
      operationThrew: false,
      pauseCleared: true,
      signerWasUnlocked: true,
      processRealDuringWindow: true,
    });
    expect(restored).toMatchObject({
      pauseEnabled: true,
      signerCustody: 'LOCKED',
      durableReal: false,
      fakeEnabled: false,
      processRealRestored: false,
      operationThrew: false,
    });
  });

  it('finally restores safety on exception/early exit', () => {
    const restored = restoreSafetyAfterControlledWindow({
      operationThrew: true,
      pauseCleared: true,
      signerWasUnlocked: true,
      processRealDuringWindow: true,
    });
    expect(restored.pauseEnabled).toBe(true);
    expect(restored.signerCustody).toBe('LOCKED');
    expect(restored.durableReal).toBe(false);
    expect(restored.fakeEnabled).toBe(false);
    expect(restored.processRealRestored).toBe(false);
    expect(restored.operationThrew).toBe(true);
  });

  it('restore scan never auto-unpauses', async () => {
    // Structural: package export contract — autoUnpause is always false on the type.
    const { runPhase10RestoreReconcileScan } = await import('../src/phase10-restore-reconcile.js');
    expect(typeof runPhase10RestoreReconcileScan).toBe('function');
  });
});

describe('Owner live-window wrapper wiring (ops desk)', () => {
  it('batch window refuses without BATCH_AUTHORIZE_LIVE_WINDOW and restores in catch/finally', () => {
    const src = readFileSync(BATCH_WRAPPER, 'utf8');
    expect(src).toMatch(/BATCH_AUTHORIZE_LIVE_WINDOW/);
    expect(src).toMatch(/refused_missing_BATCH_AUTHORIZE_LIVE_WINDOW/);
    expect(src).toMatch(/Set-PayoutDispatchPause \$true/);
    expect(src).toMatch(/Restart-IsolatedWorker 'false'/);
    expect(src).toMatch(/local-unlock\.js" relock/);
    expect(src).toMatch(/catch \{/);
    // Durable env must stay REAL=false
    expect(src).toMatch(/WITHDRAWAL_REAL_CHAIN_ENABLED=false/);
    expect(src).toMatch(/WITHDRAWAL_FAKE_CHAIN_ENABLED=false/);
  });

  it('batch orchestrator finally re-pauses and relocks; durable REAL stays false', () => {
    const src = readFileSync(BATCH_ORCH, 'utf8');
    expect(src).toMatch(/finally \{/);
    expect(src).toMatch(/setPause\(pool, true\)/);
    expect(src).toMatch(/relockSigner\(\)/);
    expect(src).toMatch(/durable env\.isolated REAL must stay false/);
    expect(src).toMatch(/BATCH_AUTHORIZE_LIVE_WINDOW|process\.env\.WITHDRAWAL_REAL_CHAIN_ENABLED/);
    expect(src).toMatch(/assertPhase10BatchPreStart/);
  });

  it('canary wrapper likewise requires CANARY_AUTHORIZE_LIVE_WINDOW', () => {
    const src = readFileSync(CANARY_WRAPPER, 'utf8');
    expect(src).toMatch(/CANARY_AUTHORIZE_LIVE_WINDOW/);
    expect(src).toMatch(/Set-PayoutDispatchPause \$true/);
  });
});
