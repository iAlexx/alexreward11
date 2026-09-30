import { Controller, Get, Inject, UseGuards } from '@nestjs/common';

import type { ApiConfig } from '@alex-rewards/config';
import {
  ADMIN_API_CONTRACT_VERSION,
  type AdminSystemHealthResponse,
} from '@alex-rewards/contracts';
import type { Pool } from '@alex-rewards/db';
import {
  evaluateOpsHealth,
  recordOpsHealthMetrics,
  type HealthState,
} from '@alex-rewards/ops-health';
import { Redis } from 'ioredis';

import { ENVIRONMENT_BY_DEPLOYMENT } from '../ads/http.js';
import { AdminSessionGuard } from '../admin-auth/admin-session.guard.js';
import { API_CONFIG, DATABASE_POOL, REDIS_CLIENT } from '../tokens.js';
import { mapAdminDomainError } from './http.js';

function toLegacyState(
  state: HealthState,
): 'ok' | 'degraded' | 'unavailable' | 'unknown' {
  if (state === 'OK') return 'ok';
  if (state === 'DEGRADED') return 'degraded';
  if (state === 'UNAVAILABLE') return 'unavailable';
  return 'unknown';
}

/**
 * System / business health — Admin authenticated, read-only.
 * Observations only. Never financial authority. Never auto-unpause.
 */
@Controller('v1/admin')
@UseGuards(AdminSessionGuard)
export class SystemController {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get('system')
  async system(): Promise<AdminSystemHealthResponse> {
    return this.health();
  }

  @Get('system/health')
  async health(): Promise<AdminSystemHealthResponse> {
    try {
      let postgresOk = false;
      try {
        await this.pool.query('SELECT 1');
        postgresOk = true;
      } catch {
        postgresOk = false;
      }

      let redisOk: boolean | null = null;
      try {
        const pong = await this.redis.ping();
        redisOk = pong === 'PONG';
      } catch {
        redisOk = false;
      }

      const environment = ENVIRONMENT_BY_DEPLOYMENT[this.config.DEPLOYMENT_ENV];
      const snapshot = await evaluateOpsHealth({
        pool: this.pool,
        environment,
        probes: {
          apiOk: true,
          postgresOk,
          redisOk,
          redisConfigured: true,
          // Temporal readiness remains on public /health/ready; Admin surface does not
          // fabricate Temporal OK without a probe wired here.
          temporalConfigured: true,
          temporalOk: null,
        },
      });

      try {
        recordOpsHealthMetrics(snapshot);
      } catch {
        // Metrics must never break the read surface.
      }

      const legacyComponents = snapshot.components.map((c) => ({
        name: c.component.toLowerCase(),
        state: toLegacyState(c.state),
        detail: c.reasonCode,
      }));

      return {
        contractVersion: ADMIN_API_CONTRACT_VERSION,
        components: legacyComponents,
        systemComponents: snapshot.components.map((c) => ({
          component: c.component,
          state: c.state,
          reasonCode: c.reasonCode,
          observedAt: c.observedAt,
          ...(c.detailsRedacted === undefined
            ? {}
            : { detailsRedacted: c.detailsRedacted }),
        })),
        alerts: snapshot.alerts.map((a) => ({
          alertClass: a.alertClass,
          severity: a.severity,
          reasonCode: a.reasonCode,
          observedAt: a.observedAt,
          financialAuthority: false as const,
          mutatesLedger: false as const,
          mutatesWithdrawals: false as const,
          autoUnpause: false as const,
          ...(a.detailsRedacted === undefined
            ? {}
            : { detailsRedacted: a.detailsRedacted }),
        })),
        payoutDispatchPause: {
          flagKey: 'PAYOUT_DISPATCH_PAUSE',
          environment: snapshot.payoutDispatchPause.environment,
          enabled: snapshot.payoutDispatchPause.enabled,
          reasonCode: snapshot.payoutDispatchPause.reasonCode,
          observedAt: snapshot.payoutDispatchPause.observedAt,
          authoritativeSource: 'feature_flags',
          autoUnpause: false,
        },
        financialAuthority: false,
        observedAt: snapshot.observedAt,
      };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }
}
