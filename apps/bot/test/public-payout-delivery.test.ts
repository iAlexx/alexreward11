import type { Api } from 'grammy';
import { GrammyError, HttpError } from 'grammy';
import { describe, expect, it, vi } from 'vitest';

import { PublicPayoutDefiniteFailureError } from '@alex-rewards/withdrawals';

import {
  PUBLIC_PAYOUT_POLL_INTERVAL_MS,
  startPublicPayoutDeliveryPoller,
} from '../src/public-payout-poller.js';
import {
  classifyPublicPayoutSenderError,
  createGrammyPublicPayoutSender,
} from '../src/public-payout-telegram-sender.js';
import { shouldStartTelegramControlCenter } from '../src/telegram-control-center-gate.js';

function makeGrammyError(description = 'chat not found'): GrammyError {
  return new GrammyError(
    "Call to 'sendMessage' failed!",
    { ok: false, error_code: 400, description },
    'sendMessage',
    {},
  );
}

describe('classifyPublicPayoutSenderError', () => {
  it('maps GrammyError to DEFINITE_FAILURE', () => {
    expect(classifyPublicPayoutSenderError(makeGrammyError())).toBe('DEFINITE_FAILURE');
  });

  it('maps HttpError and unknown errors to AMBIGUOUS', () => {
    expect(classifyPublicPayoutSenderError(new HttpError('network failed', new Error('fetch')))).toBe(
      'AMBIGUOUS',
    );
    expect(classifyPublicPayoutSenderError(new Error('timeout'))).toBe('AMBIGUOUS');
    expect(classifyPublicPayoutSenderError('boom')).toBe('AMBIGUOUS');
  });

  it('honors PublicPayoutDefiniteFailureError', () => {
    expect(classifyPublicPayoutSenderError(new PublicPayoutDefiniteFailureError('x'))).toBe(
      'DEFINITE_FAILURE',
    );
  });
});

describe('createGrammyPublicPayoutSender', () => {
  it('sends plain text with View Transaction URL keyboard (no parse_mode)', async () => {
    const sendMessage = vi.fn(async () => ({ message_id: 42 }));
    const api = { sendMessage } as unknown as Api;
    const sender = createGrammyPublicPayoutSender(api);
    const result = await sender.sendPublicPayout({
      chatId: '-100123',
      topicThreadId: 7,
      text: 'Payout confirmed',
      explorerUrl: 'https://tonviewer.com/tx/abc',
    });
    expect(result).toEqual({ telegramMessageId: '42' });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text, options] = sendMessage.mock.calls[0]!;
    expect(chatId).toBe('-100123');
    expect(text).toBe('Payout confirmed');
    expect(options).toMatchObject({
      message_thread_id: 7,
    });
    expect(options).not.toHaveProperty('parse_mode');
    const rows = options.reply_markup.inline_keyboard as ReadonlyArray<
      ReadonlyArray<{ text: string; url: string }>
    >;
    expect(rows[0]?.[0]).toEqual({
      text: 'View Transaction',
      url: 'https://tonviewer.com/tx/abc',
    });
  });

  it('omits message_thread_id when topic is null', async () => {
    const sendMessage = vi.fn(async () => ({ message_id: 9 }));
    const sender = createGrammyPublicPayoutSender({ sendMessage } as unknown as Api);
    await sender.sendPublicPayout({
      chatId: '1',
      topicThreadId: null,
      text: 'hi',
      explorerUrl: 'https://example.com/x',
    });
    const options = sendMessage.mock.calls[0]![2] as Record<string, unknown>;
    expect(options).not.toHaveProperty('message_thread_id');
  });

  it('converts GrammyError into PublicPayoutDefiniteFailureError', async () => {
    const sendMessage = vi.fn(async () => {
      throw makeGrammyError('Forbidden: bot was kicked');
    });
    const sender = createGrammyPublicPayoutSender({ sendMessage } as unknown as Api);
    await expect(
      sender.sendPublicPayout({
        chatId: '1',
        topicThreadId: null,
        text: 'hi',
        explorerUrl: 'https://example.com/x',
      }),
    ).rejects.toBeInstanceOf(PublicPayoutDefiniteFailureError);
  });

  it('rethrows HttpError as ambiguous (unchanged type)', async () => {
    const networkError = new HttpError('Network request failed', new Error('ECONNRESET'));
    const sendMessage = vi.fn(async () => {
      throw networkError;
    });
    const sender = createGrammyPublicPayoutSender({ sendMessage } as unknown as Api);
    await expect(
      sender.sendPublicPayout({
        chatId: '1',
        topicThreadId: null,
        text: 'hi',
        explorerUrl: 'https://example.com/x',
      }),
    ).rejects.toBe(networkError);
  });
});

describe('public payout poller gate', () => {
  it('does not schedule when transport/startup gate is off', () => {
    expect(shouldStartTelegramControlCenter('disabled', undefined)).toBe(false);
    const schedule = vi.fn();
    const timer = startPublicPayoutDeliveryPoller({
      enabled: false,
      intervalMs: PUBLIC_PAYOUT_POLL_INTERVAL_MS,
      poll: async () => undefined,
      onError: () => undefined,
      schedule,
    });
    expect(timer).toBeUndefined();
    expect(schedule).not.toHaveBeenCalled();
  });

  it('arms interval and clears on shutdown-style clearInterval', async () => {
    let tick: (() => void) | undefined;
    const poll = vi.fn(async () => undefined);
    const schedule = vi.fn((callback: () => void, intervalMs: number) => {
      expect(intervalMs).toBe(2_000);
      tick = callback;
      return 99 as unknown as ReturnType<typeof setInterval>;
    });
    const timer = startPublicPayoutDeliveryPoller({
      enabled: true,
      intervalMs: PUBLIC_PAYOUT_POLL_INTERVAL_MS,
      poll,
      onError: () => {
        throw new Error('poller error was not expected');
      },
      schedule,
    });
    expect(timer).toBe(99);
    tick?.();
    await vi.waitFor(() => {
      expect(poll).toHaveBeenCalledTimes(1);
    });
    // Shutdown cleanup contract: callers clearInterval the returned handle.
    expect(typeof timer).not.toBe('undefined');
    clearInterval(timer);
  });

  it('skips overlapping ticks with in-flight guard', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished = 0;
    const poll = vi.fn(async () => {
      await gate;
      finished += 1;
    });
    let tick: (() => void) | undefined;
    const schedule = vi.fn((callback: () => void) => {
      tick = callback;
      return 1 as unknown as ReturnType<typeof setInterval>;
    });
    startPublicPayoutDeliveryPoller({
      enabled: true,
      poll,
      onError: () => undefined,
      schedule,
    });
    tick?.();
    tick?.();
    expect(poll).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => expect(finished).toBe(1));
    // Allow finally() to clear in-flight before the next tick.
    await Promise.resolve();
    await Promise.resolve();
    tick?.();
    await vi.waitFor(() => expect(poll).toHaveBeenCalledTimes(2));
  });
});
