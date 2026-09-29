/** Typed fail-closed errors for the Phase 16 mission engine. */

export type MissionErrorCode =
  | 'MISSION_NOT_CONFIGURED'
  | 'MISSION_NOT_ACTIVE'
  | 'MISSION_VERSION_AMBIGUOUS'
  | 'MISSION_VERSION_NOT_FOUND'
  | 'MISSION_INTEGRITY'
  | 'MISSION_PERIOD_WEEKLY_NOT_CONFIGURED'
  | 'MISSION_SOURCE_MISMATCH'
  | 'MISSION_CONDITION_UNSUPPORTED'
  | 'MISSION_ELIGIBILITY_POLICY_INVALID'
  | 'MISSION_CONTRIBUTION_WINDOW_CLOSED'
  | 'MISSION_PROGRESS_TERMINAL'
  | 'ALREADY_CONTRIBUTED'
  | 'INTERNAL';

export class MissionDomainError extends Error {
  readonly code: MissionErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: MissionErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'MissionDomainError';
    this.code = code;
    this.details = details;
  }
}
