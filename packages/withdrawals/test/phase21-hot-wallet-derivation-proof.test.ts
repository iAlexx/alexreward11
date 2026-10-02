import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildPhase21HotWalletDerivationProofDocument,
  resolvePhase21HotWalletDerivationProofFromEnv,
  writePhase21HotWalletDerivationProofFile,
} from '../src/phase21-hot-wallet-derivation-proof.js';
import { planPhase21HotWalletRegistration } from '../src/phase21-hot-wallet-registration.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_ADDR = 'EQD0vdSA_NedR9uvbgN9EikRX-suesDxGeFg69XQMavfLqIw';
const FAKE_JETTON = 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c';
const OTHER_JETTON = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';

const envKeys = [
  'PHASE21_HOT_WALLET_DERIVATION_PROOF_FILE',
  'PHASE21_HOT_WALLET_DERIVATION_PRIMARY',
  'PHASE21_HOT_WALLET_DERIVATION_SECONDARY',
  'PHASE21_HOT_WALLET_DERIVATION_METHOD',
  'PHASE21_HOT_WALLET_DERIVATION_VERIFIED_AT',
] as const;

describe('phase21 hot wallet derivation proof CLI binding', () => {
  const prev: Record<string, string | undefined> = {};
  let tmpDir: string | null = null;

  afterEach(() => {
    for (const k of envKeys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    if (tmpDir !== null) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  function snap(): void {
    for (const k of envKeys) prev[k] = process.env[k];
  }

  function mockClient() {
    return {
      async query(text: string) {
        if (text.includes('FROM networks')) {
          return { rows: [{ id: '11111111-1111-4111-8111-111111111111' }] };
        }
        if (text.includes('FROM assets')) {
          return {
            rows: [
              {
                id: '22222222-2222-4222-8222-222222222222',
                contract_identity: OTHER_JETTON,
              },
            ],
          };
        }
        if (text.includes('FROM hot_wallets') && text.includes('COUNT')) {
          return { rows: [{ c: 0 }] };
        }
        if (text.includes('FROM hot_wallets')) {
          return { rows: [] };
        }
        return { rows: [] };
      },
    };
  }

  it('CLI source passes derivationProof into applyPhase21HotWalletRegistration', () => {
    const src = readFileSync(path.resolve(here, '../src/cli/phase21-ops.ts'), 'utf8');
    expect(src).toMatch(/derivationProof[,\s]/);
    expect(src).toMatch(/const derivationProof = derivationResolved\.proof/);
    expect(src).toMatch(/resolvePhase21HotWalletDerivationProofFromEnv/);
    expect(src).toMatch(/PHASE21_HOT_WALLET_DERIVATION_PROOF_FILE/);
    expect(src).toMatch(/writePhase21HotWalletDerivationProofFile/);
    expect(src).toMatch(/DERIVATION_PROOF_REQUIRED/);
  });

  it('missing proof => BLOCKED; valid dual-provider proof => READY', async () => {
    const client = mockClient();
    const blocked = await planPhase21HotWalletRegistration(client as never, {
      address: FAKE_ADDR,
      signerReference: 'fp-test',
      payoutJettonWalletAddress: FAKE_JETTON,
      reason: 'test',
      changedByAdminId: '11111111-1111-4111-8111-111111111111',
    });
    expect(blocked.canRegister).toBe(false);

    const ready = await planPhase21HotWalletRegistration(client as never, {
      address: FAKE_ADDR,
      signerReference: 'fp-test',
      payoutJettonWalletAddress: FAKE_JETTON,
      reason: 'test',
      changedByAdminId: '11111111-1111-4111-8111-111111111111',
      derivationProof: {
        primaryJettonWalletAddress: FAKE_JETTON,
        secondaryJettonWalletAddress: FAKE_JETTON,
        method: 'DUAL_PROVIDER_LIVE',
        verifiedAt: '2026-10-02T00:00:00.000Z',
      },
    });
    expect(ready.canRegister).toBe(true);
  });

  it('primary != secondary => BLOCKED; proof wallet != payout => BLOCKED', async () => {
    const client = mockClient();
    const disagree = await planPhase21HotWalletRegistration(client as never, {
      address: FAKE_ADDR,
      signerReference: 'fp-test',
      payoutJettonWalletAddress: FAKE_JETTON,
      reason: 'test',
      changedByAdminId: '11111111-1111-4111-8111-111111111111',
      derivationProof: {
        primaryJettonWalletAddress: FAKE_JETTON,
        secondaryJettonWalletAddress: OTHER_JETTON,
        method: 'DUAL_PROVIDER_LIVE',
      },
    });
    expect(disagree.canRegister).toBe(false);

    const mismatch = await planPhase21HotWalletRegistration(client as never, {
      address: FAKE_ADDR,
      signerReference: 'fp-test',
      payoutJettonWalletAddress: FAKE_JETTON,
      reason: 'test',
      changedByAdminId: '11111111-1111-4111-8111-111111111111',
      derivationProof: {
        primaryJettonWalletAddress: OTHER_JETTON,
        secondaryJettonWalletAddress: OTHER_JETTON,
        method: 'DUAL_PROVIDER_LIVE',
      },
    });
    expect(mismatch.canRegister).toBe(false);
  });

  it('resolveFromEnv loads file proof and refuses OWNER_SUPPLIED_EVIDENCE method', () => {
    snap();
    tmpDir = mkdtempSync(path.join(tmpdir(), 'p21-derivation-'));
    const proofPath = path.join(tmpDir, 'proof.json');
    const doc = buildPhase21HotWalletDerivationProofDocument({
      primaryJettonWalletAddress: FAKE_JETTON,
      secondaryJettonWalletAddress: FAKE_JETTON,
      ownerAddress: FAKE_ADDR,
      jettonMaster: OTHER_JETTON,
      primaryProviderKind: 'toncenter',
      secondaryProviderKind: 'tonapi',
    });
    writePhase21HotWalletDerivationProofFile(proofPath, doc);
    process.env.PHASE21_HOT_WALLET_DERIVATION_PROOF_FILE = proofPath;
    const fromFile = resolvePhase21HotWalletDerivationProofFromEnv();
    expect(fromFile.source).toBe('FILE');
    expect(fromFile.proof?.method).toBe('DUAL_PROVIDER_LIVE');
    expect(fromFile.proof?.primaryJettonWalletAddress).toBe(FAKE_JETTON);

    delete process.env.PHASE21_HOT_WALLET_DERIVATION_PROOF_FILE;
    process.env.PHASE21_HOT_WALLET_DERIVATION_PRIMARY = FAKE_JETTON;
    process.env.PHASE21_HOT_WALLET_DERIVATION_SECONDARY = FAKE_JETTON;
    process.env.PHASE21_HOT_WALLET_DERIVATION_METHOD = 'OWNER_SUPPLIED_EVIDENCE';
    const refused = resolvePhase21HotWalletDerivationProofFromEnv();
    expect(refused.proof).toBeNull();
    expect(refused.refuseCode).toBe('DERIVATION_PROOF_METHOD_REFUSED');
  });

  it('register CLI path refuses missing proof (source assertion)', () => {
    const src = readFileSync(path.resolve(here, '../src/cli/phase21-ops.ts'), 'utf8');
    // Register must not call apply without derivationProof
    const registerBlock = src.slice(src.indexOf("command === 'hot-wallet:register'"));
    expect(registerBlock).toMatch(/derivationProof[,\s]/);
    expect(registerBlock).toMatch(/const derivationProof = derivationResolved\.proof/);
    expect(registerBlock).not.toMatch(
      /applyPhase21HotWalletRegistration\(client,\s*\{[^}]*changedByAdminId:\s*adminId,\s*\}\)/s,
    );
  });
});
