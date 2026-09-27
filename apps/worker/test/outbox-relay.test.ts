import { describe, expect, it, vi } from 'vitest';

import { buildWorkerHealth } from '../src/health.js';
import { createWithdrawalOutboxPoller, startWithdrawalOutboxRelay } from '../src/outbox-relay.js';

describe('withdrawal outbox relay gate', () => {
  it('does not schedule or invoke relay handlers when disabled', async () => {
    const processApproved = vi.fn(async () => undefined);
    const processFailedPreRetry = vi.fn(async () => undefined);
    const schedule = vi.fn();
    const timer = startWithdrawalOutboxRelay({
      enabled: false,
      intervalMs: 2_000,
      poll: createWithdrawalOutboxPoller({ processApproved, processFailedPreRetry }),
      onError: () => undefined,
      schedule,
    });
    await Promise.resolve();
    expect(timer).toBeUndefined();
    expect(schedule).not.toHaveBeenCalled();
    expect(processApproved).not.toHaveBeenCalled();
    expect(processFailedPreRetry).not.toHaveBeenCalled();
  });

  it('keeps the approved then failed-pre-retry poll when enabled', async () => {
    const order: string[] = [];
    const processApproved = vi.fn(async () => {
      order.push('approved');
    });
    const processFailedPreRetry = vi.fn(async () => {
      order.push('failed-pre-retry');
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
      poll: createWithdrawalOutboxPoller({ processApproved, processFailedPreRetry }),
      onError: () => {
        throw new Error('relay error was not expected');
      },
      schedule,
    });
    expect(timer).toBe(1);
    expect(processApproved).not.toHaveBeenCalled();
    tick?.();
    await vi.waitFor(() => {
      expect(processFailedPreRetry).toHaveBeenCalledTimes(1);
    });
    expect(order).toEqual(['approved', 'failed-pre-retry']);
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
