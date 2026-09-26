import type { PoolClient } from 'pg';

import { withLedgerTransaction, type AdsDb } from '../../db.js';
import { AdsDomainError } from '../../errors.js';
import { getProviderHealth } from '../../health.js';
import type { ProviderCapabilities } from '../../provider-sdk/capabilities.js';
import type { ProviderManifest, RewardedAdProvider } from '../../provider-sdk/contract.js';
import { registerProvider } from '../../provider-sdk/registry.js';
import {
  authorizeRewardedAdSession,
  type AuthorizeRewardedAdSessionInput,
} from '../../sessions/authorize.js';
import { normalizeClientSignalType, redactSafePayload } from '../../sessions/signals.js';
import type {
  AdProviderStatus,
  AuthorizeAdInput,
  AuthorizeAdResult,
  AvailabilityInput,
  AvailabilityResult,
  EnvironmentName,
  ProviderClientSignal,
  ProviderHealth,
  ProviderVerificationResult,
  SafePayload,
  VerificationContext,
} from '../../types.js';

import {
  ADSGRAM_CAPABILITIES,
  ADSGRAM_CODE,
  ADSGRAM_PROVIDER_ID,
  adsGramManifest,
} from './manifest.js';

export interface AdsGramRewardQuery {
  readonly telegramUserId: string | null;
  readonly blockId: string | null;
  readonly adSessionId: string | null;
  readonly providerEventId: string | null;
  readonly safePayload: SafePayload;
  readonly reasonCodes: readonly string[];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readStringParam(source: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

/**
 * Parse the documented AdsGram Reward URL query string.
 *
 * Parsing only *reads* what the provider sent. It never manufactures a missing identity and
 * it never treats a present value as authenticated.
 */
export function parseAdsGramRewardQuery(input: unknown): AdsGramRewardQuery {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new AdsDomainError('WEBHOOK_PAYLOAD_INVALID', 'reward URL query must be an object');
  }
  const source = input as Record<string, unknown>;
  const reasonCodes: string[] = [];

  const rawUserId = readStringParam(source, ['userid', 'userId', 'user_id', 'telegram_user_id']);
  let telegramUserId: string | null = null;
  if (rawUserId === null) {
    reasonCodes.push('TELEGRAM_USER_ID_MISSING');
  } else if (!/^\d{1,19}$/.test(rawUserId)) {
    reasonCodes.push('TELEGRAM_USER_ID_MALFORMED');
  } else {
    telegramUserId = rawUserId;
  }

  const adSessionId = readStringParam(source, ['sessionid', 'sessionId', 'ad_session_id']);
  if (adSessionId !== null && !UUID_PATTERN.test(adSessionId)) {
    reasonCodes.push('AD_SESSION_ID_MALFORMED');
  }

  // No documented unique per-impression event id exists for this integration.
  const providerEventId = readStringParam(source, [
    'eventid',
    'eventId',
    'event_id',
    'impressionid',
  ]);
  if (providerEventId === null) {
    reasonCodes.push('PROVIDER_EVENT_ID_ABSENT');
  }

  return {
    telegramUserId,
    blockId: readStringParam(source, ['blockid', 'blockId', 'block_id']),
    adSessionId: adSessionId !== null && UUID_PATTERN.test(adSessionId) ? adSessionId : null,
    providerEventId,
    safePayload: redactSafePayload(source),
    reasonCodes,
  };
}

/**
 * AdsGram adapter (Spec V1.3 §19 V1 adapter).
 *
 * Normalizes evidence, availability and health. It does not price rewards, does not decide
 * eligibility and cannot post to the ledger. Its declared capabilities keep
 * `productionMonetaryStatus: BLOCKED` until the Owner approves the clarification answers —
 * the adapter existing is not the same as the provider being approved for money.
 */
export class AdsGramProvider implements RewardedAdProvider {
  readonly code = ADSGRAM_CODE;
  readonly providerId = ADSGRAM_PROVIDER_ID;

  getManifest(environment: EnvironmentName = 'STAGING'): ProviderManifest {
    return adsGramManifest(environment);
  }

  getCapabilities(): ProviderCapabilities {
    return ADSGRAM_CAPABILITIES;
  }

  /**
   * Report whether a new session may be opened. AdsGram exposes no pre-request inventory
   * API for this integration, so `inventoryConfirmed` is always false: a NO_FILL is only
   * discoverable after the client actually requests an ad.
   */
  async getAvailability(db: AdsDb, input: AvailabilityInput): Promise<AvailabilityResult> {
    return withLedgerTransaction(db, async (client) => {
      const reasonCodes: string[] = [];
      const providerRow = await readProviderStatus(client, this.providerId);
      if (providerRow === null) {
        return {
          available: false,
          reasonCodes: ['PROVIDER_NOT_CONFIGURED'],
          health: 'UNAVAILABLE',
          inventoryConfirmed: false,
        };
      }
      if (providerRow.status !== 'ACTIVE') reasonCodes.push('PROVIDER_NOT_ACTIVE');
      if (!providerRow.rewarded_use_allowed) reasonCodes.push('REWARDED_USE_NOT_ALLOWED');

      const health = await getProviderHealth(client, this.providerId);
      if (health.status === 'UNAVAILABLE') reasonCodes.push('PROVIDER_HEALTH_UNAVAILABLE');
      if (health.status === 'SUSPENDED') reasonCodes.push('PROVIDER_HEALTH_SUSPENDED');
      if (input.countryCode !== undefined && !/^[A-Z]{2}$/.test(input.countryCode)) {
        reasonCodes.push('COUNTRY_CODE_MALFORMED');
      }

      return {
        available: reasonCodes.length === 0,
        reasonCodes,
        health: health.status,
        inventoryConfirmed: false,
      };
    });
  }

  /** Delegates to the domain command; the adapter never writes session rows itself. */
  async authorizeSession(db: AdsDb, input: AuthorizeAdInput): Promise<AuthorizeAdResult> {
    const command: AuthorizeRewardedAdSessionInput = { ...input, providerCode: this.code };
    return authorizeRewardedAdSession(db, command);
  }

  /** Pure normalization of untrusted mini-app input. Touches no database. */
  normalizeClientEvent(input: unknown): ProviderClientSignal {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new AdsDomainError('VALIDATION', 'client event payload must be an object');
    }
    const source = input as Record<string, unknown>;
    const rawEvent = source['event'] ?? source['eventType'] ?? source['type'];
    const signalType = normalizeClientSignalType(rawEvent);

    const adSessionId = readStringParam(source, ['adSessionId', 'ad_session_id', 'sessionId']);
    if (adSessionId !== null && !UUID_PATTERN.test(adSessionId)) {
      throw new AdsDomainError('VALIDATION', 'adSessionId must be a UUID');
    }
    const occurredAtRaw = readStringParam(source, ['occurredAtIso', 'occurredAt']);
    const occurredAt =
      occurredAtRaw === null || Number.isNaN(Date.parse(occurredAtRaw)) ? null : occurredAtRaw;

    return {
      signalType,
      adSessionId,
      providerEventId: null,
      occurredAt,
      safePayload: redactSafePayload(source),
      authenticity: 'UNVERIFIED',
      financialAuthority: false,
    };
  }

  /**
   * Inspect an AdsGram Reward URL call.
   *
   * The documented Reward URL carries no shared secret, HMAC or per-impression event id for
   * this integration, so this adapter reports exactly that: `authenticity: 'UNVERIFIED'`,
   * `authenticationMethod: 'NONE'`, `authenticationStrength: 'NONE'` and
   * `monetaryAuthority: false`. It never claims cryptographic authenticity it cannot prove,
   * and correlation is left to the ingestion path — a plausible match is not a proof.
   */
  async verifyServerSignal(
    input: unknown,
    context: VerificationContext,
  ): Promise<ProviderVerificationResult> {
    const parsed = parseAdsGramRewardQuery(input);
    const reasonCodes = [...parsed.reasonCodes, 'SERVER_SIGNAL_UNAUTHENTICATED'];

    if (
      context.expectedTelegramUserId !== undefined &&
      context.expectedTelegramUserId !== null &&
      parsed.telegramUserId !== null &&
      context.expectedTelegramUserId !== parsed.telegramUserId
    ) {
      reasonCodes.push('TELEGRAM_USER_ID_MISMATCH');
    }

    return {
      signalType: 'PROVIDER_CONFIRMATION',
      authenticity: 'UNVERIFIED',
      authenticationMethod: 'NONE',
      authenticationStrength: 'NONE',
      correlation: 'UNCORRELATED',
      providerEventId: parsed.providerEventId,
      telegramUserId: parsed.telegramUserId,
      occurredAt: context.receivedAt.toISOString(),
      safePayload: parsed.safePayload,
      reasonCodes,
      monetaryAuthority: false,
    };
  }

  async getHealth(db: AdsDb): Promise<ProviderHealth> {
    return getProviderHealth(db, this.providerId);
  }
}

async function readProviderStatus(
  client: PoolClient,
  providerId: string,
): Promise<{ status: AdProviderStatus; rewarded_use_allowed: boolean } | null> {
  const result = await client.query<{
    status: AdProviderStatus;
    rewarded_use_allowed: boolean;
  }>(
    `SELECT status::text AS status, rewarded_use_allowed
     FROM ad_providers
     WHERE id = $1::uuid`,
    [providerId],
  );
  return result.rows[0] ?? null;
}

/** Compile-time registration. Registration grants no monetary permission by itself. */
export const adsGramProvider = registerProvider(new AdsGramProvider());
