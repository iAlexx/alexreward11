import { Controller, Get, UseGuards } from '@nestjs/common';

import type { TasksListResponse } from '@alex-rewards/contracts';

import { AccessSessionGuard } from '../auth/access-session.guard.js';

/**
 * Task/mission read surface.
 *
 * `packages/tasks` is still an approved-boundary shell: no engine evaluates task progress,
 * and no phase has approved task reward issuance. The honest answer is therefore
 * `UNAVAILABLE` / `ENGINE_NOT_ENABLED` — an empty `READY` list would tell the client the
 * feature works and simply has nothing for them today, which is false.
 */
@Controller('v1/tasks')
@UseGuards(AccessSessionGuard)
export class TasksController {
  @Get()
  listTasks(): TasksListResponse {
    return { status: 'UNAVAILABLE', items: [], reasonCode: 'ENGINE_NOT_ENABLED' };
  }
}
