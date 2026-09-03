import { describe, expect, it } from 'vitest';

import { foundationProbe } from '../src/workflows.js';

describe('foundation Temporal workflow', () => {
  it('is deterministic and contains no business mutation', async () => {
    await expect(foundationProbe('phase-1')).resolves.toBe('foundation-ok:phase-1');
  });
});
