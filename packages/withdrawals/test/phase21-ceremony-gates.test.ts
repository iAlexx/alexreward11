import { afterEach, describe, expect, it } from 'vitest';

import {
  assertPhase21CeremonyApplyGates,
  Phase21CeremonyApplyGateError,
  __phase21TestSetApplyEnv,
} from '../src/phase21-ceremony-apply-gates.js';

describe('phase21 ceremony apply gates', () => {
  const keys = [
    'DEPLOYMENT_ENV',
    'PHASE21_OPERATIONAL_CEREMONY_ENABLED',
    'PHASE21_PRODUCTION_FLAG_BASELINE_APPLY',
    'PHASE21_CEREMONY_REQUIRED_DATABASE_NAME',
  ] as const;
  const prev: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });

  function snapshot(): void {
    for (const k of keys) prev[k] = process.env[k];
  }

  it('refuses staging APPLY', async () => {
    snapshot();
    __phase21TestSetApplyEnv({
      DEPLOYMENT_ENV: 'staging',
      PHASE21_OPERATIONAL_CEREMONY_ENABLED: 'true',
      PHASE21_PRODUCTION_FLAG_BASELINE_APPLY: '1',
      PHASE21_CEREMONY_REQUIRED_DATABASE_NAME: 'alex_rewards_phase20_test',
    });
    const client = {
      async query<T extends Record<string, unknown> = Record<string, unknown>>() {
        return { rows: [{ name: 'alex_rewards_phase20_test' }] as unknown as T[] };
      },
    };
    await expect(
      assertPhase21CeremonyApplyGates(client, 'PHASE21_PRODUCTION_FLAG_BASELINE_APPLY'),
    ).rejects.toMatchObject({ code: 'STAGING_APPLY_FORBIDDEN' });
  });

  it('refuses missing ceremony / apply / db name / mismatch', async () => {
    snapshot();
    delete process.env.DEPLOYMENT_ENV;
    delete process.env.PHASE21_OPERATIONAL_CEREMONY_ENABLED;
    delete process.env.PHASE21_PRODUCTION_FLAG_BASELINE_APPLY;
    delete process.env.PHASE21_CEREMONY_REQUIRED_DATABASE_NAME;
    const client = {
      async query<T extends Record<string, unknown> = Record<string, unknown>>() {
        return { rows: [{ name: 'alex_rewards_phase20_test' }] as unknown as T[] };
      },
    };
    await expect(
      assertPhase21CeremonyApplyGates(client, 'PHASE21_PRODUCTION_FLAG_BASELINE_APPLY'),
    ).rejects.toBeInstanceOf(Phase21CeremonyApplyGateError);

    __phase21TestSetApplyEnv({
      DEPLOYMENT_ENV: 'production',
      PHASE21_OPERATIONAL_CEREMONY_ENABLED: 'true',
      PHASE21_PRODUCTION_FLAG_BASELINE_APPLY: '1',
      PHASE21_CEREMONY_REQUIRED_DATABASE_NAME: 'other_db',
    });
    await expect(
      assertPhase21CeremonyApplyGates(client, 'PHASE21_PRODUCTION_FLAG_BASELINE_APPLY'),
    ).rejects.toMatchObject({ code: 'DATABASE_IDENTITY_MISMATCH' });
  });

  it('accepts production gates with matching DB name', async () => {
    snapshot();
    __phase21TestSetApplyEnv({
      DEPLOYMENT_ENV: 'production',
      PHASE21_OPERATIONAL_CEREMONY_ENABLED: 'true',
      PHASE21_PRODUCTION_FLAG_BASELINE_APPLY: '1',
      PHASE21_CEREMONY_REQUIRED_DATABASE_NAME: 'alex_rewards_phase20_test',
    });
    const client = {
      async query<T extends Record<string, unknown> = Record<string, unknown>>() {
        return { rows: [{ name: 'alex_rewards_phase20_test' }] as unknown as T[] };
      },
    };
    const ok = await assertPhase21CeremonyApplyGates(
      client,
      'PHASE21_PRODUCTION_FLAG_BASELINE_APPLY',
    );
    expect(ok.deploymentEnv).toBe('production');
    expect(ok.databaseName).toBe('alex_rewards_phase20_test');
  });
});
