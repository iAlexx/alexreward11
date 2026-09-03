import { describe, expect, it } from 'vitest';

import { GET } from '../src/app/api/health/live/route';

describe('Mini App health', () => {
  it('returns the shared health contract', async () => {
    const response = GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ service: 'miniapp', status: 'ok' });
  });
});
