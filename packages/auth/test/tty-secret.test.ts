import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  prepareStdinForSecretRead,
  readSecretFromStdinStream,
} from '../src/tty-secret.js';

const here = dirname(fileURLToPath(import.meta.url));

class FakeSecretStdin extends EventEmitter {
  isRaw = false;
  #paused = true;

  isPaused(): boolean {
    return this.#paused;
  }

  pause(): this {
    this.#paused = true;
    return this;
  }

  resume(): this {
    this.#paused = false;
    return this;
  }

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    return this;
  }
}

describe('tty-secret stdin resume (Windows readline pause regression)', () => {
  it('prepareStdinForSecretRead resumes a previously paused stdin and restores raw mode', () => {
    const stdin = new FakeSecretStdin();
    stdin.pause();
    stdin.isRaw = false;
    expect(stdin.isPaused()).toBe(true);

    const session = prepareStdinForSecretRead(stdin as never);
    expect(session.wasPaused).toBe(true);
    expect(session.resumeCalled).toBe(true);
    expect(stdin.isPaused()).toBe(false);
    expect(stdin.isRaw).toBe(true);

    session.restore();
    expect(stdin.isRaw).toBe(false);
    session.restore();
    expect(stdin.isRaw).toBe(false);
  });

  it('visible readline close pauses stdin; secret reader resumes and completes on CR', async () => {
    const source = new Readable({ read() {} });
    const stdin = source as Readable & {
      isTTY?: boolean;
      isRaw?: boolean;
      setRawMode?: (mode: boolean) => void;
    };
    stdin.isTTY = true;
    stdin.isRaw = false;
    stdin.setRawMode = (mode: boolean) => {
      stdin.isRaw = mode;
    };

    const output = new PassThrough();
    const rl = createInterface({ input: stdin, output });
    const visiblePromise = new Promise<string>((resolve) => {
      rl.question('visible: ', (answer) => resolve(answer));
    });
    stdin.push('attested\n');
    await visiblePromise;
    rl.close();
    expect(stdin.isPaused()).toBe(true);

    const prompts: string[] = [];
    const secretPromise = readSecretFromStdinStream(stdin as never, {
      prompt: 'secret: ',
      writePrompt: (s) => {
        prompts.push(s);
      },
    });
    expect(stdin.isPaused()).toBe(false);
    expect(stdin.isRaw).toBe(true);

    stdin.push('654321\r');
    await expect(secretPromise).resolves.toBe('654321');
    expect(prompts[0]).toBe('secret: ');
    expect(stdin.listenerCount('data')).toBe(0);
    expect(stdin.isRaw).toBe(false);
    output.destroy();
  });

  it('secret reader supports backspace and cancels on Ctrl+C with cleanup', async () => {
    const stdin = new FakeSecretStdin();
    stdin.pause();

    const cancelled = readSecretFromStdinStream(stdin as never, {
      prompt: 'x: ',
      writePrompt: () => undefined,
    });
    expect(stdin.isPaused()).toBe(false);
    stdin.emit('data', Buffer.from('12\u007f3\u0003'));
    await expect(cancelled).rejects.toThrow(/cancelled/);
    expect(stdin.listenerCount('data')).toBe(0);
    expect(stdin.isRaw).toBe(false);

    const ok = readSecretFromStdinStream(stdin as never, {
      prompt: 'y: ',
      writePrompt: () => undefined,
    });
    stdin.emit('data', Buffer.from('ab\b\bc\n'));
    await expect(ok).resolves.toBe('c');
    expect(stdin.listenerCount('data')).toBe(0);
  });

  it('production CLI uses shared readSecretFromTty and has no local duplicate reader', () => {
    const cli = readFileSync(join(here, '../src/cli/owner-production-bootstrap.ts'), 'utf8');
    expect(cli).toMatch(/readSecretFromTty/);
    expect(cli).not.toMatch(/async function readSecret\(/);
    expect(cli).not.toMatch(/stdin\.on\('data', onData\)/);
    expect(cli).toMatch(/async function enrollOwnerTotpInteractive/);
    const enroll = cli.slice(cli.indexOf('async function enrollOwnerTotpInteractive'));
    expect(enroll.indexOf('generateTotpSecretBytes()')).toBeGreaterThan(-1);
    expect(enroll.indexOf('generateTotpSecretBytes()')).toBeLessThan(
      enroll.indexOf('promptAndVerifyTotpCode'),
    );
  });

  it('shared reader always resumes before attaching the data listener', () => {
    const src = readFileSync(join(here, '../src/tty-secret.ts'), 'utf8');
    const prepStart = src.indexOf('export function prepareStdinForSecretRead');
    const prepEnd = src.indexOf('export async function readSecretFromStdinStream');
    const prep = src.slice(prepStart, prepEnd);
    expect(prep).toContain('stdin.resume()');
    const streamFn = src.slice(prepEnd);
    const resumeCall = streamFn.indexOf('prepareStdinForSecretRead(stdin)');
    const attach = streamFn.indexOf("stdin.on('data', onData)");
    expect(resumeCall).toBeGreaterThan(-1);
    expect(attach).toBeGreaterThan(resumeCall);
    expect(src).toMatch(/finally/);
    expect(src).toMatch(/stdin\.off\('data', onData\)/);
    expect(src).toMatch(/session\.restore\(\)/);
  });
});
