import type { Pool } from 'pg';

import { contributeMissionProgress } from './contribute.js';
import {
  emptyProducerBatchResult,
  tallyContributeOutcome,
  withMissionProducerTx,
  type MissionProducerBatchResult,
} from './producer-shared.js';

interface AvailableAdReward {
  readonly id: string;
  readonly user_id: string;
  readonly available_at: Date;
}

/**
 * Bounded redrive: AVAILABLE AD reward_events → VALID_AD_COUNT missions.
 * One reward may contribute once per distinct mission progress row.
 */
export async function processValidAdMissionContributionsBatch(
  pool: Pool,
  options: { readonly limit: number },
): Promise<MissionProducerBatchResult> {
  const limit = Math.max(1, Math.min(options.limit, 500));
  const mutable = emptyProducerBatchResult();
  const result = { ...mutable };

  const versions = await withMissionProducerTx(pool, async (client) => {
    return (
      await client.query<{ id: string }>(
        `SELECT mv.id
         FROM mission_versions mv
         INNER JOIN mission_definitions md ON md.id = mv.mission_definition_id
         WHERE md.status = 'ACTIVE'
           AND mv.condition_type = 'VALID_AD_COUNT'
           AND mv.status = 'ACTIVE'`,
      )
    ).rows;
  });
  if (versions.length === 0) {
    return result;
  }

  const ads = await withMissionProducerTx(pool, async (client) => {
    return (
      await client.query<AvailableAdReward>(
        `SELECT re.id, re.user_id, re.available_at
         FROM reward_events re
         WHERE re.source_type = 'AD'
           AND re.state = 'AVAILABLE'
           AND re.available_at IS NOT NULL
         ORDER BY re.available_at ASC
         LIMIT $1`,
        [limit],
      )
    ).rows;
  });

  for (const ad of ads) {
    for (const version of versions) {
      try {
        await withMissionProducerTx(pool, async (client) => {
          const outcome = await contributeMissionProgress(client, {
            missionVersionId: version.id,
            userId: ad.user_id,
            sourceKind: 'REWARD_EVENT',
            sourceKey: ad.id,
            occurredAt: ad.available_at,
          });
          tallyContributeOutcome(result, outcome.outcome);
        });
      } catch {
        result.examined += 1;
        result.errors += 1;
      }
    }
  }

  return result;
}
