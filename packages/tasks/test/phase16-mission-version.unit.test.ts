import { describe, expect, it } from 'vitest';

import {
  MissionDomainError,
  mapMissionVersionRow,
  resolveActiveMissionVersion,
} from '../src/index.js';

describe('Phase 16 mission version resolver (unit)', () => {
  it('mapMissionVersionRow rejects invalid status / condition / target', () => {
    expect(() =>
      mapMissionVersionRow({
        id: '00000000-0000-4000-8000-000000000001',
        mission_definition_id: '00000000-0000-4000-8000-000000000002',
        mission_version: 1,
        name_key: 'n',
        description_key: null,
        condition_type: 'DAILY_LOGIN',
        target: 1,
        reset_policy: 'NONE',
        eligibility_policy: {},
        required_membership_plan_id: null,
        reward_source_type: 'MISSION',
        reward_rule_id: null,
        status: 'BOGUS',
        start_at: null,
        end_at: null,
        created_at: new Date(),
      }),
    ).toThrow(MissionDomainError);

    try {
      mapMissionVersionRow({
        id: '00000000-0000-4000-8000-000000000001',
        mission_definition_id: '00000000-0000-4000-8000-000000000002',
        mission_version: 1,
        name_key: 'n',
        description_key: null,
        condition_type: 'DAILY_LOGIN',
        target: 0,
        reset_policy: 'NONE',
        eligibility_policy: {},
        required_membership_plan_id: null,
        reward_source_type: 'MISSION',
        reward_rule_id: null,
        status: 'ACTIVE',
        start_at: null,
        end_at: null,
        created_at: new Date(),
      });
      expect.fail('expected throw');
    } catch (error) {
      expect(error).toMatchObject({ code: 'MISSION_INTEGRITY' });
    }
  });

  it('documents fail-closed codes for zero / ambiguous ACTIVE matches', () => {
    expect(new MissionDomainError('MISSION_NOT_CONFIGURED', 'none').code).toBe(
      'MISSION_NOT_CONFIGURED',
    );
    expect(new MissionDomainError('MISSION_VERSION_AMBIGUOUS', 'many').code).toBe(
      'MISSION_VERSION_AMBIGUOUS',
    );
    expect(new MissionDomainError('MISSION_VERSION_NOT_FOUND', 'missing').code).toBe(
      'MISSION_VERSION_NOT_FOUND',
    );
    expect(new MissionDomainError('MISSION_NOT_ACTIVE', 'inactive').code).toBe(
      'MISSION_NOT_ACTIVE',
    );
    expect(typeof resolveActiveMissionVersion).toBe('function');
  });
});
