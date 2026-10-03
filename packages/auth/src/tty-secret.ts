/**
 * Interactive TTY secret I/O for Owner admin auth.
 * Secrets must never be written to non-TTY stdout/stderr or argv/env/files.
 *
 * Important (Windows / Node): closing a readline Interface pauses stdin.
 * Secret reads MUST call stdin.resume() before waiting on 'data', or the
 * process can exit with a still-pending Promise (no active handle).
 */
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

export function assertInteractiveSecretTerminals(): void {
  if (!process.stdin.isTTY) {
    throw new Error(
      'interactive TTY required for secret input (refusing non-interactive stdin; never pass secrets via argv/env)',
    );
  }
  if (!process.stdout.isTTY || !process.stderr.isTTY) {
    throw new Error(
      'interactive TTY required for secret display (refusing piped/redirected stdout or stderr)',
    );
  }
}

export interface SecretStdinPrepareResult {
  /** True when stdin was paused before prepare (typical after readline.close()). */
  readonly wasPaused: boolean;
  /** Always true — resume is mandatory before waiting on secret input. */
  readonly resumeCalled: boolean;
  readonly previousRawMode: boolean | undefined;
  /** Restore raw mode. Safe to call more than once. */
  restore(): void;
}

type StdinLike = Readable & {
  isPaused(): boolean;
  resume(): Readable;
  setRawMode?(mode: boolean): unknown;
  isRaw?: boolean;
};

/**
 * Prepare stdin for a hidden secret read after a prior readline session may have
 * paused the stream. Factored for regression tests without weakening TTY gates.
 */
export function prepareStdinForSecretRead(stdin: StdinLike = process.stdin): SecretStdinPrepareResult {
  const wasPaused = stdin.isPaused();
  const previousRawMode = typeof stdin.isRaw === 'boolean' ? stdin.isRaw : undefined;
  if (typeof stdin.setRawMode === 'function') {
    stdin.setRawMode(true);
  }
  // Critical: readline.close() pauses stdin; without resume(), Node may exit
  // while a secret-read Promise is still pending (observed on Windows PowerShell).
  stdin.resume();
  let restored = false;
  return {
    wasPaused,
    resumeCalled: true,
    previousRawMode,
    restore(): void {
      if (restored) return;
      restored = true;
      if (typeof stdin.setRawMode === 'function') {
        try {
          stdin.setRawMode(previousRawMode ?? false);
        } catch {
          // ignore restore failures — process teardown may already have closed tty
        }
      }
    },
  };
}

/**
 * Read a secret from an injectable stdin-like stream (no TTY assertion).
 * Production callers must use {@link readSecretFromTty}, which asserts real TTYs.
 */
export async function readSecretFromStdinStream(
  stdin: StdinLike,
  options: {
    readonly prompt: string;
    readonly writePrompt?: (prompt: string) => void;
  },
): Promise<string> {
  options.writePrompt?.(options.prompt);
  const session = prepareStdinForSecretRead(stdin);
  let onData: ((chunk: Buffer | string) => void) | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      let buf = '';
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        fn();
      };
      onData = (chunk: Buffer | string) => {
        const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        for (const ch of s) {
          // Windows raw mode typically delivers CR alone; also accept LF.
          if (ch === '\n' || ch === '\r') {
            options.writePrompt?.('\n');
            finish(() => resolve(buf));
            return;
          }
          if (ch === '\u0003') {
            options.writePrompt?.('\n');
            finish(() => reject(new Error('cancelled')));
            return;
          }
          if (ch === '\u007f' || ch === '\b') {
            buf = buf.slice(0, -1);
            continue;
          }
          // Ignore other control characters; never echo.
          if (ch < ' ') {
            continue;
          }
          buf += ch;
        }
      };
      stdin.on('data', onData);
    });
  } finally {
    if (onData) {
      stdin.off('data', onData);
    }
    session.restore();
  }
}

/** Read a line with echo disabled (password / TOTP / session token). */
export async function readSecretFromTty(prompt: string): Promise<string> {
  assertInteractiveSecretTerminals();
  return readSecretFromStdinStream(process.stdin, {
    prompt,
    writePrompt: (s) => {
      process.stderr.write(s);
    },
  });
}

/**
 * Display a secret once on stderr after verifying interactive terminals.
 * Caller must obtain explicit Owner acknowledgment before calling.
 * Terminal screen recording / transcripts remain sensitive.
 */
export async function displaySecretOnceOnInteractiveStderr(input: {
  readonly label: string;
  readonly secret: string;
  readonly warning: string;
}): Promise<void> {
  assertInteractiveSecretTerminals();
  process.stderr.write(`${input.warning}\n`);
  process.stderr.write(`${input.label}\n`);
  process.stderr.write(`${input.secret}\n`);
  process.stderr.write(
    '(End of secret display. Do not copy into logs, files, argv, env, or clipboard automation.)\n',
  );
}

/** Read a visible line (non-secret). Still requires TTY. */
export async function readLineFromTty(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('interactive TTY required');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => {
      rl.question(prompt, (answer) => resolve(answer));
    });
  } finally {
    // Closing readline pauses stdin on Node — subsequent secret reads must resume.
    rl.close();
  }
}
