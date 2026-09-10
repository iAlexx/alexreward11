#!/usr/bin/env node
/**
 * Local unlock helper — injects passphrase to loopback-only /v1/local-unlock.
 * Passphrase via TTY (not argv). Not an Internet unlock endpoint.
 */
import { createInterface } from 'node:readline';

const baseUrl = process.env.SIGNER_LOCAL_URL ?? 'http://127.0.0.1:3005';
const token = process.env.SIGNER_SERVICE_TOKEN;

async function readPassphrase(): Promise<string> {
  if (!process.stdin.isTTY) {
    console.error('Passphrase input requires an interactive TTY.');
    process.exit(1);
  }
  return await new Promise<string>((resolvePromise) => {
    process.stdout.write('Unlock passphrase: ');
    let buf = '';
    const onData = (chunk: Buffer) => {
      const s = chunk.toString('utf8');
      for (const ch of s) {
        if (ch === '\n' || ch === '\r') {
          process.stdin.off('data', onData);
          process.stdin.setRawMode?.(false);
          process.stdout.write('\n');
          resolvePromise(buf);
          return;
        }
        if (ch === '\u0003') process.exit(130);
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

async function main(): Promise<void> {
  if (!token || token.length < 32) {
    console.error('SIGNER_SERVICE_TOKEN env (metadata auth) required, min 32 chars.');
    process.exit(1);
  }
  const action = process.argv[2] === 'relock' ? 'relock' : 'unlock';
  if (action === 'relock') {
    const res = await fetch(`${baseUrl}/v1/local-relock`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.text();
    console.log(res.status, body);
    process.exit(res.ok ? 0 : 1);
  }
  const passphrase = await readPassphrase();
  const res = await fetch(`${baseUrl}/v1/local-unlock`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ passphrase }),
  });
  const body = await res.text();
  console.log(res.status, body);
  process.exit(res.ok ? 0 : 1);
}

void createInterface; // keep import for potential future stdin modes
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
