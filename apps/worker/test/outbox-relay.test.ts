import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { buildWorkerHealth } from '../src/health.js';
import { createWithdrawalOutboxPoller, startWithdrawalOutboxRelay } from '../src/outbox-relay.js';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '../src');

describe('withdrawal outbox relay gate', () => {
  it('does not schedule or invoke relay handlers when disabled', async () => {
    const processApproved = vi.fn(async () => undefined);
    const processFailedPreRetry = vi.fn(async () => undefined);
    const processPhase21ManualDispatch = vi.fn(async () => undefined);
    const processConfirmedPublicPayout = vi.fn(async () => undefined);
    const schedule = vi.fn();
    const timer = startWithdrawalOutboxRelay({
      enabled: false,
      intervalMs: 2_000,
      poll: createWithdrawalOutboxPoller({
        processApproved,
        processFailedPreRetry,
        processPhase21ManualDispatch,
        processConfirmedPublicPayout,
      }),
      onError: () => undefined,
      schedule,
    });
    await Promise.resolve();
    expect(timer).toBeUndefined();
    expect(schedule).not.toHaveBeenCalled();
    expect(processApproved).not.toHaveBeenCalled();
    expect(processFailedPreRetry).not.toHaveBeenCalled();
    expect(processConfirmedPublicPayout).not.toHaveBeenCalled();
  });

  it('runs approved, failed-pre-retry, phase21-manual-dispatch, then confirmed public-payout when enabled', async () => {
    const order: string[] = [];
    const processApproved = vi.fn(async () => {
      order.push('approved');
    });
    const processFailedPreRetry = vi.fn(async () => {
      order.push('failed-pre-retry');
    });
    const processPhase21ManualDispatch = vi.fn(async () => {
      order.push('phase21-manual-dispatch');
    });
    const processConfirmedPublicPayout = vi.fn(async () => {
      order.push('confirmed-public-payout');
    });
    let tick: (() => void) | undefined;
    const schedule = vi.fn((callback: () => void, intervalMs: number) => {
      expect(intervalMs).toBe(2_000);
      tick = callback;
      return 1 as unknown as ReturnType<typeof setInterval>;
    });
    const timer = startWithdrawalOutboxRelay({
      enabled: true,
      intervalMs: 2_000,
      poll: createWithdrawalOutboxPoller({
        processApproved,
        processFailedPreRetry,
        processPhase21ManualDispatch,
        processConfirmedPublicPayout,
      }),
      onError: () => {
        throw new Error('relay error was not expected');
      },
      schedule,
    });
    expect(timer).toBe(1);
    expect(processApproved).not.toHaveBeenCalled();
    tick?.();
    await vi.waitFor(() => {
      expect(processConfirmedPublicPayout).toHaveBeenCalledTimes(1);
    });
    expect(order).toEqual(['approved', 'failed-pre-retry', 'phase21-manual-dispatch', 'confirmed-public-payout']);
  });

  it('worker outbox modules never import Telegram/grammY', () => {
    const relay = readFileSync(join(srcDir, 'outbox-relay.ts'), 'utf8');
    const main = readFileSync(join(srcDir, 'main.ts'), 'utf8');
    for (const source of [relay, main]) {
      expect(source).not.toMatch(/from ['"]grammy['"]/);
      expect(source).not.toMatch(/TELEGRAM_BOT_TOKEN/);
      expect(source).not.toMatch(/sendMessage/);
      expect(source).not.toMatch(/createGrammy/);
    }
    expect(main).toContain('processWithdrawalConfirmedPublicPayoutOutboxBatch');
    expect(main).toContain('mapDeploymentEnvToFeatureEnvironment');
  });
});

describe('worker readiness with relay disabled', () => {
  it('stays ready when the outbox relay is intentionally disabled', () => {
    const body = buildWorkerHealth({
      ready: true,
      outboxRelayEnabled: false,
      timestamp: '2026-09-27T00:00:00.000Z',
    });
    expect(body.status).toBe('ok');
    expect(body.contractVersion).toBe('1');
    expect(body.service).toBe('worker');
    expect(body.components).toEqual([
      { name: 'temporal-worker', state: 'ok' },
      { name: 'withdrawal-outbox-relay:disabled', state: 'ok' },
    ]);
  });

  it('reports the enabled relay without changing the health contract fields', () => {
    const body = buildWorkerHealth({
      ready: true,
      outboxRelayEnabled: true,
      timestamp: '2026-09-27T00:00:00.000Z',
    });
    expect(body.status).toBe('ok');
    expect(body.components).toEqual([
      { name: 'temporal-worker', state: 'ok' },
      { name: 'withdrawal-outbox-relay:enabled', state: 'ok' },
    ]);
  });
});
