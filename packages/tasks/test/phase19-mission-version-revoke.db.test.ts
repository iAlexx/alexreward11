/**
 * P19-SEC-014 — mission version DRAFT/REVOKED refuse new claims; SUPERSEDED preserved.
 * Destructive against PHASE16_DATABASE_URL.
 */
import { randomUUID } from 'node:crypto';

import { contributeMissionProgress, prepareMissionClaim } from '../src/index.js';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPool,
  createTestUser,
  insertEligibilityPolicy,
  insertMissionDefinition,
  insertMissionVersion,
  insertMissionProgress,
  phase16DatabaseUrl,
  resetAndMigrate,
  TEST_MISSION_CLAIM_ELIGIBILITY_POLICY,
} from './harness.js';

describe.skipIf(phase16DatabaseUrl === '')('P19-SEC-014 mission version revoke (DB)', () => {
  let pool: Pool;
  let userId: string;

  beforeAll(async () => {
    await resetAndMigrate(phase16DatabaseUrl);
    pool = createPool(phase16DatabaseUrl);
    userId = await createTestUser(pool, '19140001');
    await insertEligibilityPolicy(pool, {
      policyVersion: 1914,
      policyConfig: TEST_MISSION_CLAIM_ELIGIBILITY_POLICY,
    });
  }, 180_000);

  afterAll(async () => {
    await pool.end();
  });

  async function completeDailyLoginProgress(versionId: string): Promise<string> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const contributed = await contributeMissionProgress(client, {
        missionVersionId: versionId,
        userId,
        sourceKind: 'AUTHENTICATED_LOGIN_DAY',
        sourceKey: `DAY:p19-${randomUUID()}`,
        occurredAt: new Date('2026-05-01T12:00:00.000Z'),
      });
      await client.query('COMMIT');
      return contributed.progressId;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  it('REVOKED version before prepare => new claim refused', async () => {
    const defId = await insertMissionDefinition(pool, {
      code: `P19_REV_${randomUUID().slice(0, 8)}`,
      status: 'ACTIVE',
    });
    const versionId = await insertMissionVersion(pool, {
      missionDefinitionId: defId,
      missionVersion: 1,
      status: 'ACTIVE',
      startAt: new Date('2020-01-01T00:00:00.000Z'),
      endAt: null,
      target: 1,
      conditionType: 'DAILY_LOGIN',
      resetPolicy: 'NONE',
      rewardRuleId: null,
    });
    const progressId = await completeDailyLoginProgress(versionId);
    await pool.query(
      `UPDATE mission_versions SET status = 'REVOKED'::rule_version_status WHERE id = $1::uuid`,
      [versionId],
    );
    await expect(
      prepareMissionClaim(pool, {
        userId,
        missionProgressId: progressId,
        deploymentEnvironment: 'LOCAL',
      }),
    ).rejects.toMatchObject({ code: 'MISSION_NOT_ACTIVE' });
  });

  it('DRAFT version => new claim refused', async () => {
    const defId = await insertMissionDefinition(pool, {
      code: `P19_DRF_${randomUUID().slice(0, 8)}`,
      status: 'ACTIVE',
    });
    const versionId = await insertMissionVersion(pool, {
      missionDefinitionId: defId,
      missionVersion: 1,
      status: 'DRAFT',
      startAt: new Date('2020-01-01T00:00:00.000Z'),
      endAt: null,
      target: 1,
      conditionType: 'DAILY_LOGIN',
      resetPolicy: 'NONE',
      rewardRuleId: null,
    });
    const progressId = await insertMissionProgress(pool, {
      missionVersionId: versionId,
      userId,
      target: 1,
      progressCount: 1,
      state: 'COMPLETED',
      startedAt: new Date('2026-05-01T11:00:00.000Z'),
      completedAt: new Date('2026-05-01T12:00:00.000Z'),
    });
    await expect(
      prepareMissionClaim(pool, {
        userId,
        missionProgressId: progressId,
        deploymentEnvironment: 'LOCAL',
      }),
    ).rejects.toMatchObject({ code: 'MISSION_NOT_ACTIVE' });
  });

  it('SUPERSEDED version still allows new claim within window', async () => {
    const defId = await insertMissionDefinition(pool, {
      code: `P19_SUP_${randomUUID().slice(0, 8)}`,
      status: 'ACTIVE',
    });
    const versionId = await insertMissionVersion(pool, {
      missionDefinitionId: defId,
      missionVersion: 1,
      status: 'ACTIVE',
      startAt: new Date('2020-01-01T00:00:00.000Z'),
      endAt: null,
      target: 1,
      conditionType: 'DAILY_LOGIN',
      resetPolicy: 'NONE',
      rewardRuleId: null,
    });
    const progressId = await completeDailyLoginProgress(versionId);
    await pool.query(
      `UPDATE mission_versions SET status = 'SUPERSEDED'::rule_version_status WHERE id = $1::uuid`,
      [versionId],
    );
    const result = await prepareMissionClaim(pool, {
      userId,
      missionProgressId: progressId,
      deploymentEnvironment: 'LOCAL',
    });
    expect(result.outcome).toBe('CLAIM_GRANTED');
  });
});
