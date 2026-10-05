import { describe, expect, it } from 'vitest';

import {
  buildEmptyPhase21ProvisioningEvidenceFixture,
  parsePhase21ProvisioningEvidence,
  Phase21ProvisioningEvidenceSchema,
} from '../src/phase21-provisioning-evidence.js';

describe('phase21 provisioning evidence schema', () => {
  it('builds empty sanitized fixture that parses', () => {
    const fixture = buildEmptyPhase21ProvisioningEvidenceFixture();
    expect(fixture.sanitized).toBe(true);
    expect(fixture.readyForLivePayout).toBe(false);
    expect(fixture.notes).toContain('SCHEMA_FIXTURE_NOT_LIVE');
    const parsed = parsePhase21ProvisioningEvidence(fixture);
    expect(parsed.schemaVersion).toBe('phase21-provisioning-evidence.v1');
    expect(Phase21ProvisioningEvidenceSchema.safeParse(fixture).success).toBe(true);
  });

  it('rejects readyForLivePayout true', () => {
    const fixture = {
      ...buildEmptyPhase21ProvisioningEvidenceFixture(),
      readyForLivePayout: true as unknown as false,
    };
    expect(Phase21ProvisioningEvidenceSchema.safeParse(fixture).success).toBe(false);
  });
});
