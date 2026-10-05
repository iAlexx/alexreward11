import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { planPhase21HotWalletRegistration } from '../src/phase21-hot-wallet-registration.js';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('phase21 Step3C plan gates (source + unit)', () => {
  it('CLI source no longer hardcodes USDT master fallback', () => {
    const src = readFileSync(path.resolve(here, '../src/cli/phase21-ops.ts'), 'utf8');
    expect(src).not.toMatch(
      /TON_MAINNET_USDT_JETTON_MASTER\)\s*\?\?\s*'EQD0vdSA_NedR9uvbgN9EikRX-suesDxGeFg69XQMavfLqIw'/,
    );
    expect(src).toMatch(/LIVE_DATABASE_REQUIRED_FOR_PLAN/);
    expect(src).toMatch(/USDT_MASTER_REQUIRED/);
    expect(src).toMatch(/production-flags:template/);
    expect(src).toMatch(/SCHEMA_TEMPLATE_NOT_LIVE/);
  });

  it('hot wallet plan BLOCKED without derivation proof', async () => {
    const client = {
      async query(text: string) {
        if (text.includes('FROM networks')) {
          return { rows: [{ id: '11111111-1111-4111-8111-111111111111' }] };
        }
        if (text.includes('FROM assets')) {
          return {
            rows: [
              {
                id: '22222222-2222-4222-8222-222222222222',
                contract_identity: 'EQD0vdSA_NedR9uvbgN9EikRX-suesDxGeFg69XQMavfLqIw',
              },
            ],
          };
        }
        return { rows: [] };
      },
    };
    const plan = await planPhase21HotWalletRegistration(client as never, {
      address: 'EQD0vdSA_NedR9uvbgN9EikRX-suesDxGeFg69XQMavfLqIw',
      signerReference: 'fp-test',
      payoutJettonWalletAddress: 'EQD0vdSA_NedR9uvbgN9EikRX-suesDxGeFg69XQMavfLqIw',
      reason: 'test',
    });
    expect(plan.canRegister).toBe(false);
    expect(
      plan.items.some(
        (i) => i.check === 'jetton_wallet_derivation_proof' && i.status === 'MISSING',
      ),
    ).toBe(true);
  });
});
