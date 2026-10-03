/**
 * Phase 21 Step 4C — interactive Owner confirmations / attestations for ceremony APPLY.
 * Phrases are never accepted from env/argv/boolean. Tests may inject a reader only with
 * ALEX_PHASE21_CEREMONY_TEST_HOOKS=1 and requireInteractiveTty=false.
 *
 * Success returns WeakSet-branded objects so forged booleans / plain objects cannot authorize.
 */
import { readLineFromTty } from '@alex-rewards/auth';

export const PHASE21_PRODUCTION_FLAGS_APPLY_PHRASE =
  'APPLY_LOOTRA_PHASE21_PRODUCTION_FLAG_BASELINE' as const;
export const PHASE21_MAINNET_REGISTRY_APPLY_PHRASE =
  'APPLY_LOOTRA_PHASE21_MAINNET_REGISTRY' as const;
export const PHASE21_HOT_WALLET_REGISTER_PHRASE =
  'APPLY_LOOTRA_PHASE21_HOT_WALLET_REGISTER' as const;
export const PHASE21_HOT_WALLET_BACKUP_ATTESTATION_PHRASE =
  'I_HAVE_TWO_SHA256_VERIFIED_OFFLINE_HOT_WALLET_BACKUPS' as const;

export type Phase21InteractivePhraseInput = {
  /** Default true. false is honoured only with TEST_HOOKS and an injected readPhrase. */
  readonly requireInteractiveTty?: boolean;
  /** Test injection only (requires ALEX_PHASE21_CEREMONY_TEST_HOOKS=1). */
  readonly readPhrase?: () => Promise<string>;
};

export type Phase21ProductionFlagsApplyConfirmation = {
  readonly brand: 'Phase21ProductionFlagsApplyConfirmation';
  readonly phrase: typeof PHASE21_PRODUCTION_FLAGS_APPLY_PHRASE;
  readonly confirmedAt: string;
};

export type Phase21MainnetRegistryApplyConfirmation = {
  readonly brand: 'Phase21MainnetRegistryApplyConfirmation';
  readonly phrase: typeof PHASE21_MAINNET_REGISTRY_APPLY_PHRASE;
  readonly confirmedAt: string;
};

export type Phase21HotWalletRegisterConfirmation = {
  readonly brand: 'Phase21HotWalletRegisterConfirmation';
  readonly phrase: typeof PHASE21_HOT_WALLET_REGISTER_PHRASE;
  readonly confirmedAt: string;
};

export type Phase21HotWalletBackupAttestation = {
  readonly brand: 'Phase21HotWalletBackupAttestation';
  readonly phrase: typeof PHASE21_HOT_WALLET_BACKUP_ATTESTATION_PHRASE;
  readonly attestedAt: string;
};

const productionFlagsBrand = new WeakSet<object>();
const mainnetRegistryBrand = new WeakSet<object>();
const hotWalletRegisterBrand = new WeakSet<object>();
const hotWalletBackupBrand = new WeakSet<object>();

export class Phase21CeremonyConfirmationError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'Phase21CeremonyConfirmationError';
    this.code = code;
    this.details = details;
  }
}

function testHooksEnabled(): boolean {
  return process.env.ALEX_PHASE21_CEREMONY_TEST_HOOKS === '1';
}

async function requireExactPhrase(input: {
  readonly options: Phase21InteractivePhraseInput | undefined;
  readonly expected: string;
  readonly prompt: string;
  readonly failureCode: string;
}): Promise<string> {
  const options = input.options ?? {};
  const requireTty = options.requireInteractiveTty !== false;

  if (options.readPhrase !== undefined && !testHooksEnabled()) {
    throw new Phase21CeremonyConfirmationError(
      'FORBIDDEN',
      `${input.failureCode}: injected phrase reader requires ALEX_PHASE21_CEREMONY_TEST_HOOKS=1`,
      {},
    );
  }
  if (!requireTty && (!testHooksEnabled() || options.readPhrase === undefined)) {
    throw new Phase21CeremonyConfirmationError(
      'FORBIDDEN',
      `${input.failureCode}: non-interactive confirmation requires TEST_HOOKS and an injected reader`,
      {},
    );
  }
  if (requireTty && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Phase21CeremonyConfirmationError(
      'FORBIDDEN',
      `${input.failureCode}: INTERACTIVE_TTY_REQUIRED (stdin and stdout must be a TTY)`,
      {},
    );
  }

  const raw =
    options.readPhrase !== undefined
      ? await options.readPhrase()
      : await readLineFromTty(input.prompt);
  if (typeof raw !== 'string' || raw.trim() !== input.expected) {
    throw new Phase21CeremonyConfirmationError(
      'FORBIDDEN',
      `${input.failureCode}: exact phrase not entered`,
      {},
    );
  }
  return new Date().toISOString();
}

export function isPhase21ProductionFlagsApplyConfirmation(
  value: unknown,
): value is Phase21ProductionFlagsApplyConfirmation {
  return typeof value === 'object' && value !== null && productionFlagsBrand.has(value);
}

export function assertPhase21ProductionFlagsApplyConfirmation(
  value: unknown,
): asserts value is Phase21ProductionFlagsApplyConfirmation {
  if (!isPhase21ProductionFlagsApplyConfirmation(value)) {
    throw new Phase21CeremonyConfirmationError(
      'APPLY_CONFIRMATION_REQUIRED',
      'branded Phase21ProductionFlagsApplyConfirmation required',
      {},
    );
  }
}

export function isPhase21MainnetRegistryApplyConfirmation(
  value: unknown,
): value is Phase21MainnetRegistryApplyConfirmation {
  return typeof value === 'object' && value !== null && mainnetRegistryBrand.has(value);
}

export function assertPhase21MainnetRegistryApplyConfirmation(
  value: unknown,
): asserts value is Phase21MainnetRegistryApplyConfirmation {
  if (!isPhase21MainnetRegistryApplyConfirmation(value)) {
    throw new Phase21CeremonyConfirmationError(
      'APPLY_CONFIRMATION_REQUIRED',
      'branded Phase21MainnetRegistryApplyConfirmation required',
      {},
    );
  }
}

export function isPhase21HotWalletRegisterConfirmation(
  value: unknown,
): value is Phase21HotWalletRegisterConfirmation {
  return typeof value === 'object' && value !== null && hotWalletRegisterBrand.has(value);
}

export function assertPhase21HotWalletRegisterConfirmation(
  value: unknown,
): asserts value is Phase21HotWalletRegisterConfirmation {
  if (!isPhase21HotWalletRegisterConfirmation(value)) {
    throw new Phase21CeremonyConfirmationError(
      'APPLY_CONFIRMATION_REQUIRED',
      'branded Phase21HotWalletRegisterConfirmation required',
      {},
    );
  }
}

export function isPhase21HotWalletBackupAttestation(
  value: unknown,
): value is Phase21HotWalletBackupAttestation {
  return typeof value === 'object' && value !== null && hotWalletBackupBrand.has(value);
}

export function assertPhase21HotWalletBackupAttestation(
  value: unknown,
): asserts value is Phase21HotWalletBackupAttestation {
  if (!isPhase21HotWalletBackupAttestation(value)) {
    throw new Phase21CeremonyConfirmationError(
      'OWNER_ATTESTATION_REQUIRED',
      'branded Phase21HotWalletBackupAttestation required',
      {},
    );
  }
}

export async function confirmPhase21ProductionFlagsApplyInteractive(
  input?: Phase21InteractivePhraseInput,
): Promise<Phase21ProductionFlagsApplyConfirmation> {
  const confirmedAt = await requireExactPhrase({
    options: input,
    expected: PHASE21_PRODUCTION_FLAGS_APPLY_PHRASE,
    prompt:
      'FINAL CONFIRMATION — this will mutate PRODUCTION feature flags.\n' +
      `Type exactly ${PHASE21_PRODUCTION_FLAGS_APPLY_PHRASE}: `,
    failureCode: 'APPLY_CONFIRMATION_FAILED',
  });
  const obj: Phase21ProductionFlagsApplyConfirmation = {
    brand: 'Phase21ProductionFlagsApplyConfirmation',
    phrase: PHASE21_PRODUCTION_FLAGS_APPLY_PHRASE,
    confirmedAt,
  };
  productionFlagsBrand.add(obj);
  return obj;
}

export async function confirmPhase21MainnetRegistryApplyInteractive(
  input?: Phase21InteractivePhraseInput,
): Promise<Phase21MainnetRegistryApplyConfirmation> {
  const confirmedAt = await requireExactPhrase({
    options: input,
    expected: PHASE21_MAINNET_REGISTRY_APPLY_PHRASE,
    prompt:
      'FINAL CONFIRMATION — this will mutate the Mainnet registry.\n' +
      `Type exactly ${PHASE21_MAINNET_REGISTRY_APPLY_PHRASE}: `,
    failureCode: 'APPLY_CONFIRMATION_FAILED',
  });
  const obj: Phase21MainnetRegistryApplyConfirmation = {
    brand: 'Phase21MainnetRegistryApplyConfirmation',
    phrase: PHASE21_MAINNET_REGISTRY_APPLY_PHRASE,
    confirmedAt,
  };
  mainnetRegistryBrand.add(obj);
  return obj;
}

export async function confirmPhase21HotWalletRegisterInteractive(
  input?: Phase21InteractivePhraseInput,
): Promise<Phase21HotWalletRegisterConfirmation> {
  const confirmedAt = await requireExactPhrase({
    options: input,
    expected: PHASE21_HOT_WALLET_REGISTER_PHRASE,
    prompt:
      'FINAL CONFIRMATION — this will register the Mainnet Hot Wallet row.\n' +
      `Type exactly ${PHASE21_HOT_WALLET_REGISTER_PHRASE}: `,
    failureCode: 'APPLY_CONFIRMATION_FAILED',
  });
  const obj: Phase21HotWalletRegisterConfirmation = {
    brand: 'Phase21HotWalletRegisterConfirmation',
    phrase: PHASE21_HOT_WALLET_REGISTER_PHRASE,
    confirmedAt,
  };
  hotWalletRegisterBrand.add(obj);
  return obj;
}

export async function attestPhase21HotWalletOfflineBackupsInteractive(
  input?: Phase21InteractivePhraseInput,
): Promise<Phase21HotWalletBackupAttestation> {
  const attestedAt = await requireExactPhrase({
    options: input,
    expected: PHASE21_HOT_WALLET_BACKUP_ATTESTATION_PHRASE,
    prompt:
      'Attest that TWO SHA-256-verified offline backups of the encrypted Hot Wallet key exist.\n' +
      `Type exactly ${PHASE21_HOT_WALLET_BACKUP_ATTESTATION_PHRASE}: `,
    failureCode: 'OWNER_BACKUP_ATTESTATION_FAILED',
  });
  const obj: Phase21HotWalletBackupAttestation = {
    brand: 'Phase21HotWalletBackupAttestation',
    phrase: PHASE21_HOT_WALLET_BACKUP_ATTESTATION_PHRASE,
    attestedAt,
  };
  hotWalletBackupBrand.add(obj);
  return obj;
}

/** @internal Test-only mint — requires ALEX_PHASE21_CEREMONY_TEST_HOOKS=1. */
export function __mintPhase21HotWalletBackupAttestationForTests(): Phase21HotWalletBackupAttestation {
  if (!testHooksEnabled()) {
    throw new Phase21CeremonyConfirmationError(
      'FORBIDDEN',
      'backup attestation test mint requires ALEX_PHASE21_CEREMONY_TEST_HOOKS=1',
      {},
    );
  }
  const obj: Phase21HotWalletBackupAttestation = {
    brand: 'Phase21HotWalletBackupAttestation',
    phrase: PHASE21_HOT_WALLET_BACKUP_ATTESTATION_PHRASE,
    attestedAt: new Date().toISOString(),
  };
  hotWalletBackupBrand.add(obj);
  return obj;
}

/** @internal Test-only mint — requires ALEX_PHASE21_CEREMONY_TEST_HOOKS=1. */
export function __mintPhase21HotWalletRegisterConfirmationForTests(): Phase21HotWalletRegisterConfirmation {
  if (!testHooksEnabled()) {
    throw new Phase21CeremonyConfirmationError(
      'FORBIDDEN',
      'register confirmation test mint requires ALEX_PHASE21_CEREMONY_TEST_HOOKS=1',
      {},
    );
  }
  const obj: Phase21HotWalletRegisterConfirmation = {
    brand: 'Phase21HotWalletRegisterConfirmation',
    phrase: PHASE21_HOT_WALLET_REGISTER_PHRASE,
    confirmedAt: new Date().toISOString(),
  };
  hotWalletRegisterBrand.add(obj);
  return obj;
}

/** @internal Test-only mint — requires ALEX_PHASE21_CEREMONY_TEST_HOOKS=1. */
export function __mintPhase21ProductionFlagsApplyConfirmationForTests(): Phase21ProductionFlagsApplyConfirmation {
  if (!testHooksEnabled()) {
    throw new Phase21CeremonyConfirmationError(
      'FORBIDDEN',
      'flags confirmation test mint requires ALEX_PHASE21_CEREMONY_TEST_HOOKS=1',
      {},
    );
  }
  const obj: Phase21ProductionFlagsApplyConfirmation = {
    brand: 'Phase21ProductionFlagsApplyConfirmation',
    phrase: PHASE21_PRODUCTION_FLAGS_APPLY_PHRASE,
    confirmedAt: new Date().toISOString(),
  };
  productionFlagsBrand.add(obj);
  return obj;
}

/** @internal Test-only mint — requires ALEX_PHASE21_CEREMONY_TEST_HOOKS=1. */
export function __mintPhase21MainnetRegistryApplyConfirmationForTests(): Phase21MainnetRegistryApplyConfirmation {
  if (!testHooksEnabled()) {
    throw new Phase21CeremonyConfirmationError(
      'FORBIDDEN',
      'registry confirmation test mint requires ALEX_PHASE21_CEREMONY_TEST_HOOKS=1',
      {},
    );
  }
  const obj: Phase21MainnetRegistryApplyConfirmation = {
    brand: 'Phase21MainnetRegistryApplyConfirmation',
    phrase: PHASE21_MAINNET_REGISTRY_APPLY_PHRASE,
    confirmedAt: new Date().toISOString(),
  };
  mainnetRegistryBrand.add(obj);
  return obj;
}
