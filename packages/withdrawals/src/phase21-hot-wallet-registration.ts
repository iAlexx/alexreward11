/**
 * Phase 21 Hot Wallet registration tooling (Mainnet).
 *
 * PLAN: read-only checks (network/USDT exist, validate inputs if provided).
 * REGISTER/APPLY: ceremony gates + advisory lock + refuse duplicate ACTIVE payout wallet.
 * Default DRY_RUN / no apply without gates.
 * DO NOT invent addresses ? Owner-supplied inputs required for register.
 */
import type { PoolClient } from 'pg';

import {
  assertPhase21CeremonyApplyGates,
  Phase21CeremonyApplyGateError,
  type Phase21CeremonyApplyGateClient,
} from './phase21-ceremony-apply-gates.js';
import {
  Phase21CeremonyOwnerAdminError,
  resolvePhase21CeremonyOwnerAdmin,
} from './phase21-ceremony-owner-admin.js';
import { tonAddressesEqual } from '@alex-rewards/ton';
import { PHASE21_WALLET_VERSION } from './phase21-config.js';

export type Phase21HotWalletRegistrationMode = 'PLAN' | 'APPLY' | 'REFUSED';

export interface Phase21HotWalletDerivationProof {
  readonly primaryJettonWalletAddress: string;
  readonly secondaryJettonWalletAddress: string;
  readonly method: 'DUAL_PROVIDER_LIVE' | 'OWNER_SUPPLIED_EVIDENCE';
  readonly verifiedAt?: string;
}

export interface Phase21HotWalletRegistrationInput {
  readonly address: string;
  readonly friendlyAddress?: string | null;
  readonly signerReference: string;
  readonly payoutJettonWalletAddress: string;
  readonly label?: string | null;
  readonly reason: string;
  /** Required ACTIVE OWNER admin for APPLY — SYSTEM/null forbidden on APPLY. */
  readonly changedByAdminId: string | null;
  /** Dual-provider or Owner-supplied derivation proof required for APPLY / plan READY. */
  readonly derivationProof?: Phase21HotWalletDerivationProof | null;
}

export interface Phase21HotWalletPlanItem {
  readonly check: string;
  readonly status: 'OK' | 'MISSING' | 'INVALID' | 'CONFLICT' | 'READY';
  readonly details: Readonly<Record<string, unknown>>;
  readonly note: string;
}

export interface Phase21HotWalletRegistrationPlan {
  readonly items: readonly Phase21HotWalletPlanItem[];
  readonly canRegister: boolean;
  readonly networkId: string | null;
  readonly usdtAssetId: string | null;
  readonly notes: readonly string[];
}

export interface Phase21HotWalletRegistrationResult {
  readonly mode: Phase21HotWalletRegistrationMode;
  readonly applyAuthorized: boolean;
  readonly applied: boolean;
  readonly plan: Phase21HotWalletRegistrationPlan;
  readonly hotWalletId: string | null;
  readonly notes: readonly string[];
  readonly refuseCode?: string;
}

export interface Phase21HotWalletRegistrationClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
}

/** Advisory lock class for hot wallet register APPLY. */
export const PHASE21_HOT_WALLET_REGISTER_LOCK_KEY1 = 21000304;

const FORBIDDEN = ['TESTNET', 'LOCAL', 'PLACEHOLDER'] as const;
const AUDIT_ACTION = 'phase21.hot_wallet.register';

/** Minimal TON address shape (raw or friendly). */
function looksLikeTonAddress(value: string): boolean {
  if (/^(-1|0):[0-9a-fA-F]{64}$/.test(value)) return true;
  if (/^(E|U)Q[A-Za-z0-9_-]{46}$/.test(value)) return true;
  return false;
}

function assertOwnerSupplied(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${field} is required (Owner-supplied; never invent)`);
  }
  const upper = trimmed.toUpperCase();
  for (const marker of FORBIDDEN) {
    if (upper.includes(marker)) {
      throw new Error(`${field} must not contain ${marker}`);
    }
  }
  return trimmed;
}

export async function planPhase21HotWalletRegistration(
  client: Phase21HotWalletRegistrationClient,
  input?: Partial<Phase21HotWalletRegistrationInput> | null,
): Promise<Phase21HotWalletRegistrationPlan> {
  const items: Phase21HotWalletPlanItem[] = [];

  const network = await client.query<{ id: string }>(
    `SELECT id FROM networks WHERE code = 'TON_MAINNET' LIMIT 1`,
  );
  const networkId = network.rows[0]?.id ?? null;
  if (networkId === null) {
    items.push({
      check: 'networks:TON_MAINNET',
      status: 'MISSING',
      details: {},
      note: 'TON_MAINNET network missing; run mainnet-registry apply first',
    });
  } else {
    items.push({
      check: 'networks:TON_MAINNET',
      status: 'OK',
      details: { networkId },
      note: 'TON_MAINNET present',
    });
  }

  let usdtAssetId: string | null = null;
  if (networkId !== null) {
    const usdt = await client.query<{ id: string; contract_identity: string | null }>(
      `SELECT id, contract_identity FROM assets
       WHERE network_id = $1::uuid AND symbol = 'USDT' LIMIT 1`,
      [networkId],
    );
    const row = usdt.rows[0];
    if (row === undefined) {
      items.push({
        check: 'assets:USDT',
        status: 'MISSING',
        details: {},
        note: 'Mainnet USDT asset missing; run mainnet-registry apply first',
      });
    } else {
      usdtAssetId = row.id;
      items.push({
        check: 'assets:USDT',
        status: 'OK',
        details: { assetId: row.id, contractIdentity: row.contract_identity },
        note: 'Mainnet USDT present',
      });
    }
  }

  if (input === undefined || input === null) {
    items.push({
      check: 'owner_inputs',
      status: 'MISSING',
      details: {
        address: 'OWNER_DECISION_REQUIRED',
        signerReference: 'OWNER_DECISION_REQUIRED',
        payoutJettonWalletAddress: 'OWNER_DECISION_REQUIRED',
      },
      note: 'Owner-supplied address/signer/payout jetton wallet required for register',
    });
    return {
      items,
      canRegister: false,
      networkId,
      usdtAssetId,
      notes: [
        'PLAN only ? no addresses invented',
        'walletVersion fixed to v5R1; signer_type FALLBACK_ENCRYPTED',
      ],
    };
  }

  let inputsOk = true;
  try {
    const address = assertOwnerSupplied(input.address ?? '', 'address');
    if (!looksLikeTonAddress(address)) {
      items.push({
        check: 'address',
        status: 'INVALID',
        details: {},
        note: 'address failed TON address shape validation',
      });
      inputsOk = false;
    } else {
      items.push({
        check: 'address',
        status: 'OK',
        details: { address },
        note: 'address shape ok',
      });
    }

    const signerReference = assertOwnerSupplied(
      input.signerReference ?? '',
      'signerReference',
    );
    items.push({
      check: 'signerReference',
      status: 'OK',
      details: { signerReferenceFingerprint: signerReference.slice(0, 16) + '?' },
      note: 'signer fingerprint provided (value not echoed fully)',
    });

    const payoutJetton = assertOwnerSupplied(
      input.payoutJettonWalletAddress ?? '',
      'payoutJettonWalletAddress',
    );
    if (!looksLikeTonAddress(payoutJetton)) {
      items.push({
        check: 'payoutJettonWalletAddress',
        status: 'INVALID',
        details: {},
        note: 'payout jetton wallet failed TON address shape validation',
      });
      inputsOk = false;
    } else {
      items.push({
        check: 'payoutJettonWalletAddress',
        status: 'OK',
        details: { payoutJettonWalletAddress: payoutJetton },
        note: 'payout jetton wallet shape ok',
      });
    }

    const proof = input.derivationProof ?? null;
    if (proof === null) {
      items.push({
        check: 'jetton_wallet_derivation_proof',
        status: 'MISSING',
        details: {},
        note: 'BLOCKED: dual-provider derivation proof or Owner-supplied evidence required',
      });
      inputsOk = false;
    } else {
      const primaryOk = tonAddressesEqual(proof.primaryJettonWalletAddress, payoutJetton);
      const secondaryOk = tonAddressesEqual(proof.secondaryJettonWalletAddress, payoutJetton);
      const agree = tonAddressesEqual(
        proof.primaryJettonWalletAddress,
        proof.secondaryJettonWalletAddress,
      );
      if (!primaryOk || !secondaryOk || !agree) {
        items.push({
          check: 'jetton_wallet_derivation_proof',
          status: 'INVALID',
          details: {
            method: proof.method,
            primary: proof.primaryJettonWalletAddress,
            secondary: proof.secondaryJettonWalletAddress,
          },
          note: 'BLOCKED: Owner payoutJettonWalletAddress must match both providers derivation',
        });
        inputsOk = false;
      } else {
        items.push({
          check: 'jetton_wallet_derivation_proof',
          status: 'OK',
          details: { method: proof.method },
          note: 'derivation proof matches Owner-supplied payout jetton wallet',
        });
      }
    }

    if (networkId !== null && inputsOk) {
      const dup = await client.query<{ id: string; status: string }>(
        `SELECT id, status::text AS status FROM hot_wallets
         WHERE network_id = $1::uuid AND address = $2
         LIMIT 1`,
        [networkId, address],
      );
      if (dup.rows[0] !== undefined) {
        items.push({
          check: 'hot_wallets_address_unique',
          status: 'CONFLICT',
          details: { hotWalletId: dup.rows[0].id, status: dup.rows[0].status },
          note: 'hot wallet address already registered for TON_MAINNET',
        });
        inputsOk = false;
      } else {
        items.push({
          check: 'hot_wallets_address_unique',
          status: 'OK',
          details: {},
          note: 'no existing row for this address',
        });
      }

      const active = await client.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM hot_wallets
         WHERE network_id = $1::uuid
           AND status = 'ACTIVE'
           AND signer_type = 'FALLBACK_ENCRYPTED'`,
        [networkId],
      );
      const count = active.rows[0]?.c ?? 0;
      if (count > 0) {
        items.push({
          check: 'active_payout_wallet',
          status: 'CONFLICT',
          details: { activeCount: count },
          note: 'refuse duplicate ACTIVE FALLBACK_ENCRYPTED payout wallet on TON_MAINNET',
        });
        inputsOk = false;
      } else {
        items.push({
          check: 'active_payout_wallet',
          status: 'OK',
          details: { activeCount: 0 },
          note: 'no ACTIVE FALLBACK_ENCRYPTED payout wallet yet',
        });
      }
    }
  } catch (error: unknown) {
    items.push({
      check: 'owner_inputs',
      status: 'INVALID',
      details: {},
      note: error instanceof Error ? error.message : String(error),
    });
    inputsOk = false;
  }

  const canRegister =
    inputsOk &&
    networkId !== null &&
    usdtAssetId !== null &&
    items.every((i) => i.status === 'OK');

  if (canRegister) {
    items.push({
      check: 'register_ready',
      status: 'READY',
      details: {
        walletVersion: PHASE21_WALLET_VERSION,
        signerType: 'FALLBACK_ENCRYPTED',
      },
      note: 'inputs valid; APPLY still requires ceremony gates',
    });
  }

  return {
    items,
    canRegister,
    networkId,
    usdtAssetId,
    notes: [
      'PLAN only unless applyPhase21HotWalletRegistration is called with gates',
      'Addresses must be Owner-supplied',
    ],
  };
}

export async function applyPhase21HotWalletRegistration(
  client: PoolClient,
  input: Phase21HotWalletRegistrationInput,
): Promise<Phase21HotWalletRegistrationResult> {
  try {
    await assertPhase21CeremonyApplyGates(
      client as Phase21CeremonyApplyGateClient,
      'PHASE21_HOT_WALLET_REGISTER_APPLY',
    );
  } catch (error: unknown) {
    const code =
      error instanceof Phase21CeremonyApplyGateError ? error.code : 'APPLY_GATE_FAILED';
    const plan = await planPhase21HotWalletRegistration(client, input);
    return {
      mode: 'REFUSED',
      applyAuthorized: false,
      applied: false,
      plan,
      hotWalletId: null,
      notes: [error instanceof Error ? error.message : String(error)],
      refuseCode: code,
    };
  }

  let ownerAdminUserId: string;
  try {
    const owner = await resolvePhase21CeremonyOwnerAdmin(client, input.changedByAdminId);
    ownerAdminUserId = owner.adminUserId;
  } catch (error: unknown) {
    const code =
      error instanceof Phase21CeremonyOwnerAdminError ? error.code : 'OWNER_ADMIN_REQUIRED';
    const plan = await planPhase21HotWalletRegistration(client, input);
    return {
      mode: 'REFUSED',
      applyAuthorized: false,
      applied: false,
      plan,
      hotWalletId: null,
      notes: [error instanceof Error ? error.message : String(error)],
      refuseCode: code,
    };
  }


  await client.query('BEGIN');
  try {
    await client.query(
      `SELECT pg_advisory_xact_lock($1::int, hashtext('phase21-hot-wallet-register'))`,
      [PHASE21_HOT_WALLET_REGISTER_LOCK_KEY1],
    );

    const plan = await planPhase21HotWalletRegistration(client, input);
    if (!plan.canRegister || plan.networkId === null) {
      await client.query('ROLLBACK');
      return {
        mode: 'REFUSED',
        applyAuthorized: true,
        applied: false,
        plan,
        hotWalletId: null,
        notes: ['Register refused by live plan checks; transaction rolled back'],
        refuseCode: 'PLAN_NOT_READY',
      };
    }

    const address = assertOwnerSupplied(input.address, 'address');
    const signerReference = assertOwnerSupplied(input.signerReference, 'signerReference');
    const payoutJetton = assertOwnerSupplied(
      input.payoutJettonWalletAddress,
      'payoutJettonWalletAddress',
    );
    const reason = assertOwnerSupplied(input.reason, 'reason');

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO hot_wallets (
         network_id, address, friendly_address, wallet_version,
         signer_type, signer_reference, status, payout_jetton_wallet_address, label
       ) VALUES (
         $1::uuid, $2, $3, $4,
         'FALLBACK_ENCRYPTED', $5, 'ACTIVE', $6, $7
       )
       RETURNING id`,
      [
        plan.networkId,
        address,
        input.friendlyAddress?.trim() || null,
        PHASE21_WALLET_VERSION,
        signerReference,
        payoutJetton,
        input.label?.trim() || 'Phase21 Mainnet Hot Wallet',
      ],
    );
    const hotWalletId = inserted.rows[0]?.id;
    if (hotWalletId === undefined) {
      throw new Error('hot_wallets INSERT failed');
    }

    const actorType = 'ADMIN';
    await client.query(
      `INSERT INTO audit_logs (
         admin_user_id, actor_type, action_type, resource_type, resource_id,
         after_snapshot, reason, source
       ) VALUES (
         $1::uuid, $2::actor_type, $3, 'hot_wallet', $4::uuid,
         $5::jsonb, $6, 'SYSTEM'::actor_source
       )`,
      [
        ownerAdminUserId,
        actorType,
        AUDIT_ACTION,
        hotWalletId,
        JSON.stringify({
          networkCode: 'TON_MAINNET',
          walletVersion: PHASE21_WALLET_VERSION,
          signerType: 'FALLBACK_ENCRYPTED',
          address,
          payoutJettonWalletAddress: payoutJetton,
        }),
        reason,
      ],
    );

    await client.query('COMMIT');
    return {
      mode: 'APPLY',
      applyAuthorized: true,
      applied: true,
      plan,
      hotWalletId,
      notes: [
        'Hot Wallet registered atomically',
        'signer_reference stored as fingerprint only (no seed)',
        'READY_FOR_LIVE_PAYOUT remains false until later Owner gates',
      ],
    };
  } catch (error: unknown) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore
    }
    const plan = await planPhase21HotWalletRegistration(client, input).catch(() => ({
      items: [],
      canRegister: false,
      networkId: null,
      usdtAssetId: null,
      notes: ['plan unavailable after rollback'],
    }));
    return {
      mode: 'REFUSED',
      applyAuthorized: true,
      applied: false,
      plan,
      hotWalletId: null,
      notes: [
        `APPLY aborted and rolled back: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
      refuseCode: 'APPLY_EXCEPTION',
    };
  }
}
