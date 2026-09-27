import { devices } from '@playwright/test';

import { clickGoToEarn, clickProfileHeader, gotoNav } from '../src/helpers/ui.js';
import { expect, test } from './fixtures.js';

const pixel = devices['Pixel 5'];

/**
 * Real tap/click coverage on a phone-sized viewport.
 * Phase 12 previously used `page.goto` and never proved the bottom bar,
 * Go to Earn, or the profile chip receive pointer events.
 */
test.use({
  viewport: pixel.viewport,
  userAgent: pixel.userAgent,
  deviceScaleFactor: pixel.deviceScaleFactor,
  isMobile: pixel.isMobile,
  hasTouch: pixel.hasTouch,
});

test('bottom nav, Go to Earn, and profile chip are the elements under the pointer', async ({
  asStandardUser: page,
}) => {
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();

  await clickGoToEarn(page);
  await gotoNav(page, 'Home');

  await gotoNav(page, 'Earn');
  await gotoNav(page, 'Tasks');
  await gotoNav(page, 'Friends');
  await gotoNav(page, 'Wallet');
  await gotoNav(page, 'Home');

  await clickProfileHeader(page);
});
