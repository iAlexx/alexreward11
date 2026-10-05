import { preparePhase12E2eDatabase, requirePhase12E2eEnabled } from './fixtures/db.js';

/**
 * Playwright global setup: assert PHASE12_E2E, reset isolated DB, seed fixtures.
 * Never logs claim codes or session secrets.
 */
async function globalSetup(): Promise<void> {
  requirePhase12E2eEnabled();
  await preparePhase12E2eDatabase();
}

export default globalSetup;
