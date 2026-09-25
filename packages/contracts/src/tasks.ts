/**
 * Task/mission read models (Phase 12).
 *
 * The mission engine is not an approved phase yet. The list therefore reports
 * `UNAVAILABLE` with `ENGINE_NOT_ENABLED` rather than an empty "you have no tasks" list,
 * which would be indistinguishable from a working engine with nothing to offer.
 */

import type { DomainReasonCode, ServerDomainAvailability } from './common.js';

export type TaskProgressStateDto =
  'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'CLAIMED' | 'EXPIRED';

export interface TaskListItemDto {
  readonly taskCode: string;
  readonly nameKey: string;
  readonly state: TaskProgressStateDto;
  readonly progressCount: number;
  readonly target: number;
}

export interface TasksListResponse {
  readonly status: ServerDomainAvailability;
  readonly items: readonly TaskListItemDto[];
  readonly reasonCode?: DomainReasonCode;
}
