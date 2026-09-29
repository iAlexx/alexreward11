/**
 * Task/mission read + claim contracts (Phase 16).
 */

import type { DomainReasonCode, ServerDomainAvailability } from './common.js';

export type TaskProgressStateDto =
  'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'CLAIMED' | 'EXPIRED';

export type TaskClaimStatusDto = 'PENDING' | 'GRANTED' | 'REJECTED';

export interface TaskRewardDisplayDto {
  readonly amountAtomic: string;
  readonly assetCode: string;
  readonly assetDecimals: number;
  readonly pendingHoldSeconds: number;
}

export interface TaskListItemDto {
  readonly taskCode: string;
  readonly missionVersionId: string;
  readonly progressId: string | null;
  readonly nameKey: string;
  readonly descriptionKey: string | null;
  readonly state: TaskProgressStateDto;
  readonly progressCount: number;
  readonly target: number;
  readonly resetPolicy: string;
  readonly periodKey: string;
  readonly claimStatus: TaskClaimStatusDto | null;
  readonly claimable: boolean;
  readonly rewardAtomic: string | null;
  readonly reward: TaskRewardDisplayDto | null;
  readonly endsAt: string | null;
}

export interface TasksListResponse {
  readonly status: ServerDomainAvailability;
  readonly items: readonly TaskListItemDto[];
  readonly reasonCode?: DomainReasonCode;
}

export type TaskClaimOutcomeDto =
  | 'PENDING'
  | 'GRANTED'
  | 'ALREADY_GRANTED'
  | 'NOT_COMPLETED'
  | 'NOT_ELIGIBLE'
  | 'WINDOW_CLOSED'
  | 'RETRY_LATER'
  | 'NOT_FOUND';

export interface TaskClaimResponse {
  readonly outcome: TaskClaimOutcomeDto;
  readonly claimStatus: TaskClaimStatusDto | null;
  readonly progressId: string;
  readonly claimId: string | null;
}
