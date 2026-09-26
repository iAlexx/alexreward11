import { preparePhase13AdminE2eDatabase, requirePhase13AdminE2eEnabled } from './fixtures/db.js';

/**
 * Playwright global setup: assert PHASE13_ADMIN_E2E, reset isolated DB, seed Owner admin.
 * Never logs passwords, TOTP secrets, or session tokens.
 */
async function globalSetup(): Promise<void> {
  requirePhase13AdminE2eEnabled();
  await preparePhase13AdminE2eDatabase();
}

export default globalSetup;
