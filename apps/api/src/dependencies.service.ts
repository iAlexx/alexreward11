import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Connection } from '@temporalio/client';
import { Redis } from 'ioredis';

import type { ApiConfig } from '@alex-rewards/config';
import type { HealthComponent } from '@alex-rewards/contracts';
import { createDatabasePool, probeDatabase, type Pool } from '@alex-rewards/db';

import { API_CONFIG } from './tokens.js';

@Injectable()
export class DependenciesService implements OnApplicationShutdown {
  readonly database: Pool;
  readonly redis: Redis;
  #temporal: Connection | undefined;

  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {
    this.database = createDatabasePool(config.DATABASE_URL);
    this.redis = new Redis(config.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 5_000,
    });
    this.redis.on('error', () => undefined);
  }

  async ensureRedis(): Promise<Redis> {
    if (this.redis.status === 'wait') await this.redis.connect();
    return this.redis;
  }

  async probeAll(): Promise<readonly HealthComponent[]> {
    return Promise.all([this.probePostgres(), this.probeRedis(), this.probeTemporal()]);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.#temporal?.close();
    if (this.redis.status !== 'end') this.redis.disconnect(false);
    await this.database.end();
  }

  private async probePostgres(): Promise<HealthComponent> {
    try {
      const result = await probeDatabase(this.database);
      return { name: 'postgresql', state: 'ok', latencyMs: result.latencyMs };
    } catch {
      return { name: 'postgresql', state: 'unavailable' };
    }
  }

  private async probeRedis(): Promise<HealthComponent> {
    const started = performance.now();
    try {
      await this.ensureRedis();
      await this.redis.ping();
      return { name: 'redis', state: 'ok', latencyMs: Math.round(performance.now() - started) };
    } catch {
      return { name: 'redis', state: 'unavailable' };
    }
  }

  private async probeTemporal(): Promise<HealthComponent> {
    const started = performance.now();
    try {
      this.#temporal ??= await Connection.connect({ address: this.config.TEMPORAL_ADDRESS });
      await this.#temporal.workflowService.getSystemInfo({});
      return { name: 'temporal', state: 'ok', latencyMs: Math.round(performance.now() - started) };
    } catch {
      await this.#temporal?.close();
      this.#temporal = undefined;
      return { name: 'temporal', state: 'unavailable' };
    }
  }
}
