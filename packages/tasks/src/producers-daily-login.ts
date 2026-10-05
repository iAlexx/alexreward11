import type { Pool } from 'pg';

import { contributeMissionProgress } from './contribute.js';
import {
  emptyProducerBatchResult,
  selectDailyLoginContributionCandidates,
  tallyContributeOutcome,
  withMissionProducerTx,
  type MissionProducerBatchResult,
} from './producer-shared.js';

/**
 * Bounded redrive: authenticated login-day evidence → DAILY_LOGIN missions.
 * Login/session creation must never depend on Mission Engine success.
 */
export async function processDailyLoginMissionContributionsBatch(
  pool: Pool,
  options: { readonly limit: number },
): Promise<MissionProducerBatchResult> {
  const limit = Math.max(1, Math.min(options.limit, 500));
  const result = { ...emptyProducerBatchResult() };

  const candidates = await withMissionProducerTx(pool, async (client) =>
    selectDailyLoginContributionCandidates(client, limit),
  );
  if (candidates.length === 0) {
    return result;
  }

  for (const candidate of candidates) {
    try {
      await withMissionProducerTx(pool, async (client) => {
        const outcome = await contributeMissionProgress(client, {
          missionVersionId: candidate.mission_version_id,
          userId: candidate.user_id,
          sourceKind: 'AUTHENTICATED_LOGIN_DAY',
          sourceKey: candidate.day_key,
          occurredAt: candidate.occurred_at,
        });
        tallyContributeOutcome(result, outcome.outcome);
      });
    } catch {
      result.examined += 1;
      result.errors += 1;
    }
  }

  return result;
}
