/**
 * Phase 21 Step 4B.2 - interactive Owner confirmations for production APPLY.
 * Phrases are never accepted from env/argv. Tests may inject a reader only with
 * ALEX_OWNER_BOOTSTRAP_TEST_HOOKS=1 and requireInteractiveTty=false.
 */
import { AuthDomainError } from '../errors.js';
import { readLineFromTty } from '../tty-secret.js';

export const OWNER_OFFLINE_BACKUP_ATTESTATION_PHRASE =
  'I_HAVE_TWO_SHA256_VERIFIED_OFFLINE_OWNER_KEY_BACKUPS';

export const OWNER_APPLY_CONFIRMATION_PHRASE = 'APPLY_LOOTRA_PRODUCTION_OWNER_BOOTSTRAP';

export interface InteractivePhraseInput {
  /** Default true. false is honoured only with TEST_HOOKS and an injected readPhrase. */
  readonly requireInteractiveTty?: boolean;
  /** Test injection only (requires ALEX_OWNER_BOOTSTRAP_TEST_HOOKS=1). */
  readonly readPhrase?: () => Promise<string>;
}

function testHooksEnabled(): boolean {
  return process.env.ALEX_OWNER_BOOTSTRAP_TEST_HOOKS === '1';
}

async function requireExactPhrase(input: {
  readonly options: InteractivePhraseInput | undefined;
  readonly expected: string;
  readonly prompt: string;
  readonly failureCode: string;
}): Promise<true> {
  const options = input.options ?? {};
  const requireTty = options.requireInteractiveTty !== false;

  if (options.readPhrase !== undefined && !testHooksEnabled()) {
    throw new AuthDomainError(
      'FORBIDDEN',
      `${input.failureCode}: injected phrase reader requires ALEX_OWNER_BOOTSTRAP_TEST_HOOKS=1`,
    );
  }
  if (!requireTty && (!testHooksEnabled() || options.readPhrase === undefined)) {
    throw new AuthDomainError(
      'FORBIDDEN',
      `${input.failureCode}: non-interactive confirmation requires TEST_HOOKS and an injected reader`,
    );
  }
  if (requireTty && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new AuthDomainError(
      'FORBIDDEN',
      `${input.failureCode}: INTERACTIVE_TTY_REQUIRED (stdin and stdout must be a TTY)`,
    );
  }

  const raw =
    options.readPhrase !== undefined
      ? await options.readPhrase()
      : await readLineFromTty(input.prompt);
  if (typeof raw !== 'string' || raw.trim() !== input.expected) {
    throw new AuthDomainError('FORBIDDEN', `${input.failureCode}: exact phrase not entered`);
  }
  return true;
}

/**
 * Owner must type the exact backup attestation phrase. There is no env/argv/boolean
 * shortcut. Returns true only on an exact (trimmed) match; every other outcome throws.
 */
export async function attestOwnerOfflineBackupsInteractive(
  input?: InteractivePhraseInput,
): Promise<true> {
  return await requireExactPhrase({
    options: input,
    expected: OWNER_OFFLINE_BACKUP_ATTESTATION_PHRASE,
    prompt:
      'Attest that TWO SHA-256-verified offline backups of the encrypted Owner key exist.\n' +
      `Type exactly ${OWNER_OFFLINE_BACKUP_ATTESTATION_PHRASE}: `,
    failureCode: 'OWNER_BACKUP_ATTESTATION_FAILED',
  });
}

/** Final point-of-no-return confirmation immediately before any mutation. */
export async function confirmProductionOwnerBootstrapApplyInteractive(
  input?: InteractivePhraseInput,
): Promise<true> {
  return await requireExactPhrase({
    options: input,
    expected: OWNER_APPLY_CONFIRMATION_PHRASE,
    prompt:
      'FINAL CONFIRMATION - this will mutate the production database.\n' +
      `Type exactly ${OWNER_APPLY_CONFIRMATION_PHRASE}: `,
    failureCode: 'APPLY_CONFIRMATION_FAILED',
  });
}
