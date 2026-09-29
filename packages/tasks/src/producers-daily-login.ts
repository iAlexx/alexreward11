import type { Pool } from 'pg';

import { contributeMissionProgress } from './contribute.js';
import { formatUtcDayKey } from './period.js';
import {
  emptyProducerBatchResult,
  tallyContributeOutcome,
  withMissionProducerTx,
  type MissionProducerBatchResult,
} from './producer-shared.js';

interface LoginDayEvidence {
  readonly user_id: string;
  readonly occurred_at: Date;
}

/**
 * Bounded redrive: authenticated login-day evidence → DAILY_LOGIN missions.
 * Login/session creation must never depend on Mission Engine success.
 */
export async function processDailyLoginMissionContributionsBatch(
  pool: Pool,
  options: { readonly limit: number },
): Promise<MissionProducerBatchResult> {
  const limit = Math.max(1, Math.min(options.limit, 500));
  const result = emptyProducerBatchResult();
  const mutable = { ...result };

  const versions = await withMissionProducerTx(pool, async (client) => {
    return (
      await client.query<{ id: string }>(
        `SELECT mv.id
         FROM mission_versions mv
         INNER JOIN mission_definitions md ON md.id = mv.mission_definition_id
         WHERE md.status = 'ACTIVE'
           AND mv.condition_type = 'DAILY_LOGIN'
           AND mv.status = 'ACTIVE'`,
      )
    ).rows;
  });
  if (versions.length === 0) {
    return mutable;
  }

  const evidence = await withMissionProducerTx(pool, async (client) => {
    return (
      await client.query<LoginDayEvidence>(
        `SELECT s.user_id, MIN(s.created_at) AS occurred_at
         FROM user_sessions s
         GROUP BY s.user_id, ((s.created_at AT TIME ZONE 'UTC')::date)
         ORDER BY MIN(s.created_at) ASC
         LIMIT $1`,
        [limit],
      )
    ).rows;
  });

  for (const day of evidence) {
    for (const version of versions) {
      try {
        await withMissionProducerTx(pool, async (client) => {
          const outcome = await contributeMissionProgress(client, {
            missionVersionId: version.id,
            userId: day.user_id,
            sourceKind: 'AUTHENTICATED_LOGIN_DAY',
            sourceKey: formatUtcDayKey(day.occurred_at),
            occurredAt: day.occurred_at,
          });
          tallyContributeOutcome(mutable, outcome.outcome);
        });
      } catch {
        mutable.examined += 1;
        mutable.errors += 1;
      }
    }
  }

  return mutable;
}
