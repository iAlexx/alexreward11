import { describe, expect, it } from 'vitest';

import { resolvePrimaryNavActiveIndex } from '../src/lib/bottom-nav-routes';

describe('LOOTRA primary nav active index', () => {
  it('maps primary routes to the correct crystal indicator index', () => {
    expect(resolvePrimaryNavActiveIndex('/')).toBe(0);
    expect(resolvePrimaryNavActiveIndex('/earn')).toBe(1);
    expect(resolvePrimaryNavActiveIndex('/tasks')).toBe(2);
    expect(resolvePrimaryNavActiveIndex('/friends')).toBe(3);
    expect(resolvePrimaryNavActiveIndex('/wallet')).toBe(4);
  });

  it('keeps section prefix routes under their primary tab', () => {
    expect(resolvePrimaryNavActiveIndex('/wallet/example')).toBe(4);
    expect(resolvePrimaryNavActiveIndex('/tasks/example')).toBe(2);
    expect(resolvePrimaryNavActiveIndex('/earn/example')).toBe(1);
    expect(resolvePrimaryNavActiveIndex('/friends/invite')).toBe(3);
  });

  it('hides the indicator on secondary routes (no fabricated Home)', () => {
    expect(resolvePrimaryNavActiveIndex('/profile')).toBeNull();
    expect(resolvePrimaryNavActiveIndex('/profile/founder')).toBeNull();
    expect(resolvePrimaryNavActiveIndex('/notifications')).toBeNull();
    expect(resolvePrimaryNavActiveIndex('/activity')).toBeNull();
  });

  it('does not treat nested paths under / as Home', () => {
    expect(resolvePrimaryNavActiveIndex('/anything-else')).toBeNull();
  });
});
