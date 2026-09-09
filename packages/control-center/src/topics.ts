import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import type { ControlCenterRuntimeConfig } from './config.js';
import { resolveDestination } from './destinations.js';
import { ControlCenterError } from './errors.js';
import { enqueueTelegramPublication, markPublicationPublished } from './publications.js';
import {
  CONTROL_CENTER_DESTINATION_PURPOSES,
  type ControlCenterDestinationPurpose,
  type ControlCenterEnvironment,
  type ControlCenterTopicKey,
} from './types.js';

export const TOPIC_PURPOSE_MAP: Readonly<
  Record<ControlCenterTopicKey, ControlCenterDestinationPurpose>
> = {
  APPROVALS: 'CONTROL_CENTER_APPROVALS',
  PAYOUTS: 'CONTROL_CENTER_PAYOUTS',
  WARNINGS: 'CONTROL_CENTER_WARNINGS',
  CRITICAL: 'CONTROL_CENTER_CRITICAL',
  FRAUD: 'CONTROL_CENTER_FRAUD',
  WALLET: 'CONTROL_CENTER_WALLET',
  ADS: 'CONTROL_CENTER_ADS',
  REPORTS: 'CONTROL_CENTER_DAILY_REPORT',
  SUPPORT: 'CONTROL_CENTER_SUPPORT',
  AUDIT: 'CONTROL_CENTER_AUDIT',
  SYSTEM: 'CONTROL_CENTER_SYSTEM',
};

export function purposeForTopic(topic: ControlCenterTopicKey): ControlCenterDestinationPurpose {
  return TOPIC_PURPOSE_MAP[topic];
}

export function allControlCenterPurposes(): readonly ControlCenterDestinationPurpose[] {
  return CONTROL_CENTER_DESTINATION_PURPOSES;
}

const rateBuckets = new Map<string, number[]>();

export function checkTopicRateLimit(
  config: ControlCenterRuntimeConfig,
  key: string,
  nowMs = Date.now(),
): void {
  const windowMs = config.rateLimitWindowSeconds * 1000;
  const timestamps = (rateBuckets.get(key) ?? []).filter((ts) => nowMs - ts < windowMs);
  if (timestamps.length >= config.rateLimitMax) {
    rateBuckets.set(key, timestamps);
    throw new ControlCenterError('RATE_LIMITED');
  }
  timestamps.push(nowMs);
  rateBuckets.set(key, timestamps);
}

export function resetTopicRateLimitBucketsForTests(): void {
  rateBuckets.clear();
}

/** @deprecated Prefer resetTopicRateLimitBucketsForTests */
export const resetTopicRateLimitBuckets = resetTopicRateLimitBucketsForTests;

export function allowWarningBurst(config: ControlCenterRuntimeConfig, key: string): boolean {
  try {
    checkTopicRateLimit(config, key);
    return true;
  } catch (error) {
    if (error instanceof ControlCenterError && error.code === 'RATE_LIMITED') return false;
    throw error;
  }
}

export interface TopicPublishResult {
  readonly publicationId: string;
  readonly deduped: boolean;
  readonly status: string;
}

/**
 * Publish/dedupe a Control Center topic event via telegram_publications.
 * Never throws into a financial TX — callers should isolate from ledger work.
 */
export async function publishTopicEvent(
  pool: Pool,
  config: ControlCenterRuntimeConfig,
  input: {
    readonly topic: ControlCenterTopicKey;
    readonly environment: ControlCenterEnvironment;
    readonly subjectType: string;
    readonly subjectId: string;
    readonly messageKind: string;
    readonly body?: string;
    readonly rateLimitKey?: string;
  },
): Promise<TopicPublishResult> {
  void input.body;
  checkTopicRateLimit(
    config,
    input.rateLimitKey ??
      `${input.topic}:${input.subjectType}:${input.subjectId}:${input.messageKind}`,
  );
  const purpose = purposeForTopic(input.topic);
  const destination = await resolveDestination(pool, {
    environment: input.environment,
    purpose,
  });
  if (!destination.enabled) {
    throw new ControlCenterError('NOT_AUTHORIZED', undefined, {
      details: { reason: 'DESTINATION_DISABLED', purpose },
    });
  }
  const { publication, created } = await enqueueTelegramPublication(pool, {
    destinationId: destination.id,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    messageKind: input.messageKind,
  });
  return {
    publicationId: publication.id,
    deduped: !created,
    status: publication.status,
  };
}

export async function publishWarning(
  pool: Pool,
  config: ControlCenterRuntimeConfig,
  input: {
    readonly environment: ControlCenterEnvironment;
    readonly subjectType: string;
    readonly subjectId: string;
    readonly dedupeKey: string;
    readonly body: string;
  },
): Promise<TopicPublishResult> {
  return publishTopicEvent(pool, config, {
    topic: 'WARNINGS',
    environment: input.environment,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    messageKind: `warning:${input.dedupeKey}`,
    body: input.body,
    rateLimitKey: `WARNINGS:${input.dedupeKey}`,
  });
}

export async function publishCritical(
  pool: Pool,
  config: ControlCenterRuntimeConfig,
  input: {
    readonly environment: ControlCenterEnvironment;
    readonly subjectType: string;
    readonly subjectId: string;
    readonly dedupeKey: string;
    readonly body: string;
  },
): Promise<TopicPublishResult> {
  return publishTopicEvent(pool, config, {
    topic: 'CRITICAL',
    environment: input.environment,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    messageKind: `critical:${input.dedupeKey}`,
    body: input.body,
    rateLimitKey: `CRITICAL:${input.dedupeKey}`,
  });
}

export async function markTopicPublicationPublished(
  pool: Pool,
  publicationId: string,
  telegramMessageId = String(Date.now()),
): Promise<void> {
  await markPublicationPublished(pool, publicationId, telegramMessageId);
}

/** Helper for tests that need a subject UUID without inventing financial IDs. */
export function newTopicSubjectId(): string {
  return randomUUID();
}
