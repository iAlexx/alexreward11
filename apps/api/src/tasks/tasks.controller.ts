import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';

import type { ApiConfig } from '@alex-rewards/config';
import type { TaskClaimResponse, TasksListResponse } from '@alex-rewards/contracts';
import type { Pool } from '@alex-rewards/db';
import {
  MissionDomainError,
  listUserMissions,
  prepareMissionClaim,
} from '@alex-rewards/tasks';
import { issueMissionReward, RewardDomainError } from '@alex-rewards/rewards';

import { ENVIRONMENT_BY_DEPLOYMENT } from '../ads/http.js';
import {
  AccessSessionGuard,
  CurrentAuthUser,
  type AuthenticatedRequestUser,
} from '../auth/access-session.guard.js';
import { API_CONFIG, DATABASE_POOL } from '../tokens.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Tasks / Missions user surface (Phase 16).
 * Server-authoritative list + claim. No client economic fields accepted.
 */
@Controller('v1/tasks')
@UseGuards(AccessSessionGuard)
export class TasksController {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get()
  async listTasks(
    @CurrentAuthUser() auth: AuthenticatedRequestUser,
  ): Promise<TasksListResponse> {
    const items = await listUserMissions(this.pool, { userId: auth.userId });
    return {
      status: 'READY',
      items: items.map((item) => ({
        taskCode: item.taskCode,
        missionVersionId: item.missionVersionId,
        progressId: item.progressId,
        nameKey: item.nameKey,
        descriptionKey: item.descriptionKey,
        state: item.state,
        progressCount: item.progressCount,
        target: item.target,
        resetPolicy: item.resetPolicy,
        periodKey: item.periodKey,
        claimStatus: item.claimStatus,
        claimable: item.claimable,
        rewardAtomic: item.rewardAtomic,
        endsAt: item.endsAt,
      })),
    };
  }

  @Post(':progressId/claim')
  @HttpCode(200)
  async claimTask(
    @CurrentAuthUser() auth: AuthenticatedRequestUser,
    @Param('progressId') progressId: string,
  ): Promise<TaskClaimResponse> {
    if (!UUID_PATTERN.test(progressId)) {
      throw new BadRequestException({ error: 'VALIDATION', message: 'progressId invalid' });
    }

    const environment = ENVIRONMENT_BY_DEPLOYMENT[this.config.DEPLOYMENT_ENV];

    try {
      const prepared = await prepareMissionClaim(this.pool, {
        userId: auth.userId,
        missionProgressId: progressId,
        deploymentEnvironment: environment,
      });

      if (prepared.outcome === 'NOT_ELIGIBLE') {
        return {
          outcome: 'NOT_ELIGIBLE',
          claimStatus: null,
          progressId,
          claimId: null,
        };
      }
      if (prepared.outcome === 'ALREADY_GRANTED') {
        return {
          outcome: 'ALREADY_GRANTED',
          claimStatus: 'GRANTED',
          progressId,
          claimId: prepared.claimId,
        };
      }
      if (prepared.outcome === 'ALREADY_REJECTED') {
        return {
          outcome: 'NOT_ELIGIBLE',
          claimStatus: 'REJECTED',
          progressId,
          claimId: prepared.claimId,
        };
      }
      if (prepared.outcome === 'CLAIM_GRANTED') {
        return {
          outcome: 'GRANTED',
          claimStatus: 'GRANTED',
          progressId,
          claimId: prepared.claimId,
        };
      }

      if (!prepared.monetary || prepared.claimId === null) {
        return {
          outcome: 'PENDING',
          claimStatus: 'PENDING',
          progressId,
          claimId: prepared.claimId,
        };
      }

      const issued = await issueMissionReward(this.pool, {
        missionClaimId: prepared.claimId,
        environment,
      });

      if (issued.kind === 'issued' || issued.kind === 'already_granted') {
        return {
          outcome: issued.kind === 'already_granted' ? 'ALREADY_GRANTED' : 'GRANTED',
          claimStatus: 'GRANTED',
          progressId,
          claimId: prepared.claimId,
        };
      }

      return {
        outcome: 'RETRY_LATER',
        claimStatus: 'PENDING',
        progressId,
        claimId: prepared.claimId,
      };
    } catch (error) {
      if (error instanceof MissionDomainError) {
        if (error.code === 'MISSION_PROGRESS_NOT_FOUND') {
          throw new NotFoundException({ error: 'NOT_FOUND', message: 'mission progress not found' });
        }
        if (error.code === 'MISSION_NOT_COMPLETED') {
          return {
            outcome: 'NOT_COMPLETED',
            claimStatus: null,
            progressId,
            claimId: null,
          };
        }
        if (error.code === 'MISSION_CLAIM_WINDOW_CLOSED') {
          return {
            outcome: 'WINDOW_CLOSED',
            claimStatus: null,
            progressId,
            claimId: null,
          };
        }
        if (error.code === 'MISSION_SOURCE_EVIDENCE_NO_LONGER_VALID') {
          return {
            outcome: 'NOT_ELIGIBLE',
            claimStatus: null,
            progressId,
            claimId: null,
          };
        }
      }
      if (error instanceof RewardDomainError) {
        return {
          outcome: 'RETRY_LATER',
          claimStatus: 'PENDING',
          progressId,
          claimId: null,
        };
      }
      throw error;
    }
  }
}
