import { describe, expect, it } from 'vitest';

import {
  Phase21CeremonyOwnerAdminError,
  resolvePhase21CeremonyOwnerAdmin,
} from '../src/phase21-ceremony-owner-admin.js';

describe('resolvePhase21CeremonyOwnerAdmin', () => {
  it('refuses null / SYSTEM', async () => {
    const client = { async query() { return { rows: [] }; } };
    await expect(resolvePhase21CeremonyOwnerAdmin(client as never, null)).rejects.toBeInstanceOf(
      Phase21CeremonyOwnerAdminError,
    );
    await expect(resolvePhase21CeremonyOwnerAdmin(client as never, 'SYSTEM')).rejects.toMatchObject({
      code: 'OWNER_ADMIN_SYSTEM_FORBIDDEN',
    });
  });

  it('refuses missing/inactive admin', async () => {
    const client = {
      async query(text: string) {
        if (text.includes('FROM admin_users')) {
          return { rows: [{ id: '11111111-1111-4111-8111-111111111111', status: 'DISABLED' }] };
        }
        return { rows: [{ c: 0 }] };
      },
    };
    await expect(
      resolvePhase21CeremonyOwnerAdmin(client as never, '11111111-1111-4111-8111-111111111111'),
    ).rejects.toMatchObject({ code: 'OWNER_ADMIN_NOT_ACTIVE' });
  });

  it('refuses admin without OWNER binding', async () => {
    const client = {
      async query(text: string) {
        if (text.includes('FROM admin_users')) {
          return { rows: [{ id: '11111111-1111-4111-8111-111111111111', status: 'ACTIVE' }] };
        }
        return { rows: [{ c: 0 }] };
      },
    };
    await expect(
      resolvePhase21CeremonyOwnerAdmin(client as never, '11111111-1111-4111-8111-111111111111'),
    ).rejects.toMatchObject({ code: 'OWNER_BINDING_MISSING' });
  });

  it('accepts ACTIVE OWNER binding', async () => {
    const client = {
      async query(text: string) {
        if (text.includes('FROM admin_users')) {
          return { rows: [{ id: '11111111-1111-4111-8111-111111111111', status: 'ACTIVE' }] };
        }
        return { rows: [{ c: 1 }] };
      },
    };
    const result = await resolvePhase21CeremonyOwnerAdmin(
      client as never,
      '11111111-1111-4111-8111-111111111111',
    );
    expect(result.adminUserId).toBe('11111111-1111-4111-8111-111111111111');
  });
});
