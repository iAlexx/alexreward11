import { Controller, Get, Inject, UseGuards } from '@nestjs/common';

import type { AdminSystemHealthResponse } from '@alex-rewards/contracts';
import type { Pool } from '@alex-rewards/db';
import { Redis } from 'ioredis';

import { AdminSessionGuard } from '../admin-auth/admin-session.guard.js';
import { DATABASE_POOL, REDIS_CLIENT } from '../tokens.js';
import { mapAdminDomainError } from './http.js';

/** System health components — no secrets. */
@Controller('v1/admin')
@UseGuards(AdminSessionGuard)
export class SystemController {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  @Get('system/health')
  async health(): Promise<AdminSystemHealthResponse> {
    try {
      const components: Array<{
        name: string;
        state: 'ok' | 'degraded' | 'unavailable';
        detail?: string;
      }> = [];

      try {
        const start = Date.now();
        await this.pool.query('SELECT 1');
        components.push({
          name: 'postgres',
          state: 'ok',
          detail: `latencyMs=${Date.now() - start}`,
        });
      } catch {
        components.push({ name: 'postgres', state: 'unavailable' });
      }

      try {
        const start = Date.now();
        const pong = await this.redis.ping();
        components.push({
          name: 'redis',
          state: pong === 'PONG' ? 'ok' : 'degraded',
          detail: `latencyMs=${Date.now() - start}`,
        });
      } catch {
        components.push({ name: 'redis', state: 'unavailable' });
      }

      components.push({
        name: 'admin_api',
        state: 'ok',
        detail: 'control_read_surface',
      });

      return { contractVersion: '1', components };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }
}
