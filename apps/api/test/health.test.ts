import { describe, expect, it } from 'vitest';

import { healthResponse } from '../src/health.controller.js';

describe('API health contract', () => {
  it('does not expose configuration or secrets', () => {
    const response = healthResponse('api', 'ok', [
      { name: 'postgresql', state: 'ok', latencyMs: 1 },
    ]);
    expect(response).toMatchObject({ contractVersion: '1', service: 'api', status: 'ok' });
    expect(JSON.stringify(response)).not.toMatch(/password|token|DATABASE_URL/i);
  });
});
