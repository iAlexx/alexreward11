/**
 * P13-01 server-authoritative Admin Web confirmations — refuse / success / replay.
 */
import { describe, expect, it, vi } from 'vitest';

import { AuthDomainError } from '../src/errors.js';
import {
  canonicalizeAdminWebPayload,
  confirmAdminWebConfirmation,
  consumeAdminWebConfirmation,
  digestAdminWebPayload,
  isAllowedAdminWebConfirmationAction,
  prepareAdminWebConfirmation,
} from '../src/admin-web-confirmations.js';
import type { VerifiedAdminSession } from '../src/admin-http.js';

function freshSession(overrides: Partial<VerifiedAdminSession> = {}): VerifiedAdminSession {
  return {
    adminUserId: '11111111-1111-1111-1111-111111111111',
    email: 'owner@local.test',
    displayName: 'Owner',
    sessionId: '22222222-2222-2222-2222-222222222222',
    reauthenticatedAt: new Date().toISOString(),
    idleExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    absoluteExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    roles: ['OWNER'],
    ...overrides,
  };
}

describe('P13-01 admin web confirmations — policy', () => {
  it('allowlists high-impact action prefixes only', () => {
    expect(isAllowedAdminWebConfirmationAction('ads.monetary_status')).toBe(true);
    expect(isAllowedAdminWebConfirmationAction('providers.limit_change')).toBe(true);
    expect(isAllowedAdminWebConfirmationAction('withdrawal.approve')).toBe(true);
    expect(isAllowedAdminWebConfirmationAction('missions.version_activate')).toBe(true);
    expect(isAllowedAdminWebConfirmationAction('evil.drop_table')).toBe(false);
    expect(isAllowedAdminWebConfirmationAction('')).toBe(false);
  });

  it('payload digest is order-independent for object keys', () => {
    const a = digestAdminWebPayload({ b: 1, a: 2 });
    const b = digestAdminWebPayload({ a: 2, b: 1 });
    expect(a).toBe(b);
    expect(canonicalizeAdminWebPayload({ z: true, a: false })).toBe('{"a":false,"z":true}');
  });

  it('refuses prepare without recent reauth', async () => {
    const pool = { connect: vi.fn() } as never;
    await expect(
      prepareAdminWebConfirmation(pool, {
        session: freshSession({
          reauthenticatedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
        }),
        actionType: 'feature_flags.mutate',
        resourceType: 'feature_flag',
        resourceId: 'PAYOUT_DISPATCH_PAUSE:LOCAL',
        expectedVersion: '1',
        payload: { enabled: true },
      }),
    ).rejects.toBeInstanceOf(AuthDomainError);
  });

  it('refuses prepare for non-allowlisted action', async () => {
    const pool = { connect: vi.fn() } as never;
    await expect(
      prepareAdminWebConfirmation(pool, {
        session: freshSession(),
        actionType: 'not_allowlisted',
        resourceType: 'x',
        resourceId: '1',
        expectedVersion: '1',
        payload: {},
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('refuses consume when confirmationId missing', async () => {
    const pool = { connect: vi.fn() } as never;
    await expect(
      consumeAdminWebConfirmation(pool, {
        session: freshSession(),
        confirmationId: '',
        actionType: 'feature_flags.mutate',
        resourceType: 'feature_flag',
        resourceId: 'x',
        expectedVersion: '1',
        payload: {},
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('P13-01 admin web confirmations — mocked success + replay', () => {
  it('prepare → confirm → consume succeeds once; replay refuses', async () => {
    const confirmationId = '33333333-3333-3333-3333-333333333333';
    const session = freshSession();
    const payload = { enabled: true, reason: 'pause' };
    const digest = digestAdminWebPayload(payload);
    let phraseHash = '';
    let consumed = false;
    let confirmedAt: Date | null = null;

    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.startsWith('BEGIN') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK')) {
          return { rows: [] };
        }
        if (sql.includes('INSERT INTO admin_web_confirmations')) {
          phraseHash = String(params?.[8] ?? '');
          return { rows: [{ id: confirmationId }] };
        }
        if (sql.includes('INSERT INTO audit_logs')) {
          return { rows: [] };
        }
        if (sql.includes('FROM admin_web_confirmations') && sql.includes('FOR UPDATE')) {
          return {
            rows: [
              {
                id: confirmationId,
                admin_user_id: session.adminUserId,
                admin_session_id: session.sessionId,
                action_type: 'feature_flags.mutate',
                resource_type: 'feature_flag',
                resource_id: 'PAYOUT_DISPATCH_PAUSE:LOCAL',
                expected_version: '1',
                payload_digest: digest,
                phrase_hash: phraseHash,
                expires_at: new Date(Date.now() + 60_000),
                confirmed_at: confirmedAt,
                consumed_at: consumed ? new Date() : null,
              },
            ],
          };
        }
        if (sql.includes('SET confirmed_at')) {
          confirmedAt = new Date();
          return { rows: [{ confirmed_at: confirmedAt }] };
        }
        if (sql.includes('SET consumed_at')) {
          if (consumed) return { rows: [] };
          consumed = true;
          return { rows: [{ consumed_at: new Date() }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };

    const pool = {
      connect: vi.fn(async () => client),
    };

    const prepared = await prepareAdminWebConfirmation(pool as never, {
      session,
      actionType: 'feature_flags.mutate',
      resourceType: 'feature_flag',
      resourceId: 'PAYOUT_DISPATCH_PAUSE:LOCAL',
      expectedVersion: '1',
      payload,
    });
    expect(prepared.confirmationId).toBe(confirmationId);
    expect(prepared.payloadDigest).toBe(digest);
    expect(prepared.confirmationPhrase.length).toBeGreaterThan(8);

    const confirmed = await confirmAdminWebConfirmation(pool as never, {
      session,
      confirmationId,
      confirmationPhrase: prepared.confirmationPhrase,
    });
    expect(confirmed.confirmationId).toBe(confirmationId);

    const first = await consumeAdminWebConfirmation(pool as never, {
      session,
      confirmationId,
      actionType: 'feature_flags.mutate',
      resourceType: 'feature_flag',
      resourceId: 'PAYOUT_DISPATCH_PAUSE:LOCAL',
      expectedVersion: '1',
      payload,
    });
    expect(first.confirmationId).toBe(confirmationId);

    await expect(
      consumeAdminWebConfirmation(pool as never, {
        session,
        confirmationId,
        actionType: 'feature_flags.mutate',
        resourceType: 'feature_flag',
        resourceId: 'PAYOUT_DISPATCH_PAUSE:LOCAL',
        expectedVersion: '1',
        payload,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('confirm refuses wrong phrase', async () => {
    const confirmationId = '44444444-4444-4444-4444-444444444444';
    const session = freshSession();
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.startsWith('BEGIN') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK')) {
          return { rows: [] };
        }
        if (sql.includes('FROM admin_web_confirmations')) {
          return {
            rows: [
              {
                id: confirmationId,
                admin_user_id: session.adminUserId,
                admin_session_id: session.sessionId,
                phrase_hash: 'deadbeef',
                payload_digest: 'x',
                expires_at: new Date(Date.now() + 60_000),
                confirmed_at: null,
                consumed_at: null,
              },
            ],
          };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) };
    await expect(
      confirmAdminWebConfirmation(pool as never, {
        session,
        confirmationId,
        confirmationPhrase: 'CONFIRM wrong',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
