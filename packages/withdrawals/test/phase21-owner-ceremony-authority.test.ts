import { afterEach, describe, expect, it } from 'vitest';

import {
  resolveCanonicalPhase21OwnerSeat,
  authenticatePhase21OwnerCeremonyFromOwnerTty,
  Phase21OwnerCeremonyAuthError,
} from '../src/phase21-owner-ceremony-auth.js';
import {
  assertAuthenticatedPhase21OwnerCeremonyTrust,
  isAuthenticatedPhase21OwnerCeremonyTrust,
} from '../src/phase21-owner-ceremony-trust.js';
import { mintAuthenticatedPhase21OwnerCeremonyTrustForTests } from '../src/test-only/phase21-ceremony-test-hooks.js';
import {
  assertPhase21HotWalletBackupAttestation,
  confirmPhase21HotWalletRegisterInteractive,
  PHASE21_HOT_WALLET_REGISTER_PHRASE,
  __mintPhase21HotWalletBackupAttestationForTests,
} from '../src/phase21-ceremony-confirmations.js';
import {
  assertPhase21CeremonyApplyGates,
  __phase21TestSetApplyEnv,
} from '../src/phase21-ceremony-apply-gates.js';

const OWNER_ID = 'a11a11a1-0000-4000-8000-000000000011';

describe('phase21 owner ceremony authority', () => {
  const prev: Record<string, string | undefined> = {};
  const keys = [
    'ALEX_PHASE21_CEREMONY_TEST_HOOKS',
    'DEPLOYMENT_ENV',
    'PHASE21_OPERATIONAL_CEREMONY_ENABLED',
    'PHASE21_PRODUCTION_FLAG_BASELINE_APPLY',
    'PHASE21_CEREMONY_REQUIRED_DATABASE_NAME',
    'PHASE21_CEREMONY_REQUIRED_SYSTEM_IDENTIFIER',
  ] as const;

  afterEach(() => {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });

  function snap(): void {
    for (const k of keys) prev[k] = process.env[k];
  }

  it('forged trust object cannot authorize', () => {
    const forged = {
      brand: 'AuthenticatedPhase21OwnerCeremonyTrust',
      trustClass: 'AuthenticatedPhase21OwnerCeremonyTrust',
      adminUserId: OWNER_ID,
      authenticatedAt: new Date().toISOString(),
      currentDatabase: 'db',
      systemIdentifier: '1',
      authMethod: 'PASSWORD_TOTP' as const,
      authStateMutationOccurred: true as const,
      witnessModel: 'LIVE_OWNER_TTY' as const,
    };
    expect(isAuthenticatedPhase21OwnerCeremonyTrust(forged)).toBe(false);
    expect(() => assertAuthenticatedPhase21OwnerCeremonyTrust(forged)).toThrowError(
      /forged object|OWNER_CEREMONY_TRUST_REQUIRED|cannot authorize/,
    );
  });

  it('test hook mint brands trust only when hooks enabled', () => {
    snap();
    delete process.env.ALEX_PHASE21_CEREMONY_TEST_HOOKS;
    expect(() =>
      mintAuthenticatedPhase21OwnerCeremonyTrustForTests({
        adminUserId: OWNER_ID,
        currentDatabase: 'alex_rewards',
        systemIdentifier: '123',
      }),
    ).toThrow(/TEST_HOOKS/);

    process.env.ALEX_PHASE21_CEREMONY_TEST_HOOKS = '1';
    const trust = mintAuthenticatedPhase21OwnerCeremonyTrustForTests({
      adminUserId: OWNER_ID,
      currentDatabase: 'alex_rewards',
      systemIdentifier: '123',
    });
    expect(isAuthenticatedPhase21OwnerCeremonyTrust(trust)).toBe(true);
    assertAuthenticatedPhase21OwnerCeremonyTrust(trust);
  });

  it('env UUID alone is not seat authority; seat mismatch refuses', async () => {
    const client = {
      async query(text: string) {
        if (text.includes('admin_owner_authority')) {
          return { rows: [{ holder: OWNER_ID }] };
        }
        if (text.includes('FROM admin_users')) {
          return { rows: [{ id: OWNER_ID, status: 'ACTIVE' }] };
        }
        if (text.includes('admin_role_bindings')) {
          return { rows: [{ c: 1 }] };
        }
        return { rows: [] };
      },
    };
    const ok = await resolveCanonicalPhase21OwnerSeat(client as never, OWNER_ID);
    expect(ok.adminUserId).toBe(OWNER_ID);
    await expect(
      resolveCanonicalPhase21OwnerSeat(
        client as never,
        'b22b22b2-0000-4000-8000-000000000022',
      ),
    ).rejects.toMatchObject({ code: 'OWNER_SEAT_LOCATOR_MISMATCH' });
  });

  it('vacant seat refuses', async () => {
    const client = {
      async query() {
        return { rows: [{ holder: null }] };
      },
    };
    await expect(resolveCanonicalPhase21OwnerSeat(client as never)).rejects.toBeInstanceOf(
      Phase21OwnerCeremonyAuthError,
    );
  });

  it('authenticate refuses non-pool / injected secrets without hooks', async () => {
    snap();
    delete process.env.ALEX_PHASE21_CEREMONY_TEST_HOOKS;
    await expect(
      authenticatePhase21OwnerCeremonyFromOwnerTty({
        pool: { connect: async () => ({ release() {} }) } as never,
        expectedDatabase: 'db',
        expectedClusterSystemIdentifier: '1',
        injectedSecrets: { password: 'x', totpCode: '123456' },
      }),
    ).rejects.toMatchObject({ code: 'TEST_HOOKS_REQUIRED' });
  });

  it('branded backup attestation required; forged boolean refuses', () => {
    snap();
    process.env.ALEX_PHASE21_CEREMONY_TEST_HOOKS = '1';
    expect(() => assertPhase21HotWalletBackupAttestation(true as never)).toThrowError(
      /BackupAttestation|OWNER_ATTESTATION_REQUIRED/,
    );
    const branded = __mintPhase21HotWalletBackupAttestationForTests();
    assertPhase21HotWalletBackupAttestation(branded);
  });

  it('confirmation phrase brands object via test injection', async () => {
    snap();
    process.env.ALEX_PHASE21_CEREMONY_TEST_HOOKS = '1';
    const conf = await confirmPhase21HotWalletRegisterInteractive({
      requireInteractiveTty: false,
      readPhrase: async () => PHASE21_HOT_WALLET_REGISTER_PHRASE,
    });
    expect(conf.brand).toBe('Phase21HotWalletRegisterConfirmation');
  });

  it('apply gates require system identifier match', async () => {
    snap();
    __phase21TestSetApplyEnv({
      DEPLOYMENT_ENV: 'production',
      PHASE21_OPERATIONAL_CEREMONY_ENABLED: 'true',
      PHASE21_PRODUCTION_FLAG_BASELINE_APPLY: '1',
      PHASE21_CEREMONY_REQUIRED_DATABASE_NAME: 'alex_rewards_phase20_test',
    });
    delete process.env.PHASE21_CEREMONY_REQUIRED_SYSTEM_IDENTIFIER;
    const client = {
      async query(text: string) {
        if (text.includes('current_database')) {
          return { rows: [{ name: 'alex_rewards_phase20_test' }] };
        }
        if (text.includes('pg_control_system')) {
          return { rows: [{ sid: '999' }] };
        }
        return { rows: [] };
      },
    };
    await expect(
      assertPhase21CeremonyApplyGates(client as never, 'PHASE21_PRODUCTION_FLAG_BASELINE_APPLY'),
    ).rejects.toMatchObject({ code: 'REQUIRED_SYSTEM_IDENTIFIER_MISSING' });

    process.env.PHASE21_CEREMONY_REQUIRED_SYSTEM_IDENTIFIER = '999';
    const ok = await assertPhase21CeremonyApplyGates(
      client as never,
      'PHASE21_PRODUCTION_FLAG_BASELINE_APPLY',
    );
    expect(ok.systemIdentifier).toBe('999');
  });
});
