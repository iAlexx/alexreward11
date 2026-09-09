import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import {
  CONTROL_CENTER_DESTINATION_PURPOSES,
  allowWarningBurst,
  enqueueTelegramPublication,
  localControlCenterFixtureConfig,
  markPublicationFailed,
  publishTopicEvent,
  purposeForTopic,
  requeueFailedPublication,
  resetTopicRateLimitBucketsForTests,
} from '../src/index.js';
import {
  createPool,
  phase8DatabaseUrl,
  resetAndMigrate,
  seedAllControlCenterDestinations,
} from './harness.js';

const describePhase8 = phase8DatabaseUrl === '' ? describe.skip : describe;

describePhase8('phase8 topics and publications', () => {
  let pool: Pool;
  let destIds: Record<string, string>;
  const config = localControlCenterFixtureConfig(['900001']);

  beforeAll(async () => {
    await resetAndMigrate(phase8DatabaseUrl);
    pool = createPool(phase8DatabaseUrl);
    destIds = await seedAllControlCenterDestinations(pool);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  it('maps all 11 topics including Audit, System, Reports→DAILY_REPORT', () => {
    expect(CONTROL_CENTER_DESTINATION_PURPOSES).toHaveLength(11);
    expect(purposeForTopic('REPORTS')).toBe('CONTROL_CENTER_DAILY_REPORT');
    expect(purposeForTopic('AUDIT')).toBe('CONTROL_CENTER_AUDIT');
    expect(purposeForTopic('SYSTEM')).toBe('CONTROL_CENTER_SYSTEM');
  });

  it('dedupes identical publications', async () => {
    const subjectId = randomUUID();
    const first = await enqueueTelegramPublication(pool, {
      destinationId: destIds.CONTROL_CENTER_WARNINGS!,
      subjectType: 'system',
      subjectId,
      messageKind: 'low_hot_wallet',
    });
    const second = await enqueueTelegramPublication(pool, {
      destinationId: destIds.CONTROL_CENTER_WARNINGS!,
      subjectType: 'system',
      subjectId,
      messageKind: 'low_hot_wallet',
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.publication.id).toBe(first.publication.id);
  });

  it('Telegram failure leaves publication retryable', async () => {
    const subjectId = randomUUID();
    const { publication } = await enqueueTelegramPublication(pool, {
      destinationId: destIds.CONTROL_CENTER_CRITICAL!,
      subjectType: 'system',
      subjectId,
      messageKind: 'ledger_imbalance',
    });
    await markPublicationFailed(pool, publication.id, 'telegram timeout');
    await requeueFailedPublication(pool, publication.id);
    const row = await pool.query<{ status: string }>(
      `SELECT status FROM telegram_publications WHERE id = $1`,
      [publication.id],
    );
    expect(row.rows[0]!.status).toBe('PENDING');
  });

  it('rate-limits warning bursts and publishes topic events', async () => {
    resetTopicRateLimitBucketsForTests();
    const tight = { ...config, rateLimitMax: 2, rateLimitWindowSeconds: 60 };
    expect(allowWarningBurst(tight, 'k')).toBe(true);
    expect(allowWarningBurst(tight, 'k')).toBe(true);
    expect(allowWarningBurst(tight, 'k')).toBe(false);

    const published = await publishTopicEvent(pool, config, {
      environment: 'LOCAL',
      topic: 'AUDIT',
      subjectType: 'audit',
      subjectId: randomUUID(),
      messageKind: 'admin_action',
    });
    expect(published.deduped).toBe(false);
    expect(published.status).toBe('PENDING');
  });
});
