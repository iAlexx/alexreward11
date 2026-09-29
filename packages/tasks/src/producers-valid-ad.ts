import type { Pool } from 'pg';

import { contributeMissionProgress } from './contribute.js';
import {
  emptyProducerBatchResult,
  selectValidAdContributionCandidates,
  tallyContributeOutcome,
  withMissionProducerTx,
  type MissionProducerBatchResult,
} from './producer-shared.js';

/**
 * Bounded redrive: AVAILABLE AD reward_events → VALID_AD_COUNT missions.
 * One reward may contribute once per distinct mission progress row.
 */
export async function processValidAdMissionContributionsBatch(
  pool: Pool,
  options: { readonly limit: number },
): Promise<MissionProducerBatchResult> {
  const limit = Math.max(1, Math.min(options.limit, 500));
  const result = { ...emptyProducerBatchResult() };

  const candidates = await withMissionProducerTx(pool, async (client) =>
    selectValidAdContributionCandidates(client, limit),
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
          sourceKind: 'REWARD_EVENT',
          sourceKey: candidate.reward_event_id,
          occurredAt: candidate.available_at,
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
