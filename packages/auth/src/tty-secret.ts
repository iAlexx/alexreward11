/**
 * Interactive TTY secret I/O for Owner admin auth.
 * Secrets must never be written to non-TTY stdout/stderr or argv/env/files.
 */
import { createInterface } from 'node:readline';

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

/** Read a line with echo disabled (password / TOTP / session token). */
export async function readSecretFromTty(prompt: string): Promise<string> {
  assertInteractiveSecretTerminals();
  process.stderr.write(prompt);
  return await new Promise<string>((resolve, reject) => {
    let buf = '';
    const onData = (chunk: Buffer) => {
      const s = chunk.toString('utf8');
      for (const ch of s) {
        if (ch === '\n' || ch === '\r') {
          process.stdin.off('data', onData);
          process.stdin.setRawMode?.(false);
          process.stderr.write('\n');
          resolve(buf);
          return;
        }
        if (ch === '\u0003') {
          process.stdin.off('data', onData);
          process.stdin.setRawMode?.(false);
          process.stderr.write('\n');
          reject(new Error('cancelled'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
    };
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
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
    rl.close();
  }
}
