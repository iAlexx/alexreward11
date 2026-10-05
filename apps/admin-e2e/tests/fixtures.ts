import { test as base, expect } from '@playwright/test';

import { readPublicSeed, type Phase13AdminE2ePublicSeed } from '../src/fixtures/seed-meta.js';

type Fixtures = {
  seed: Phase13AdminE2ePublicSeed;
  apiBaseUrl: string;
};

export const test = base.extend<Fixtures>({
  seed: async ({}, use) => {
    await use(readPublicSeed());
  },
  apiBaseUrl: async ({ seed }, use) => {
    await use(seed.apiBaseUrl);
  },
});

export { expect };
