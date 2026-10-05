/**
 * Schema for phase21-provisioning-evidence.json (Owner ceremony artifact).
 * Sanitized fixtures only — never invent live evidence files in the repo.
 */
import { z } from 'zod';

export const Phase21ProvisioningEvidenceSchema = z.object({
  schemaVersion: z.literal('phase21-provisioning-evidence.v1'),
  networkCode: z.literal('TON_MAINNET'),
  networkGlobalId: z.literal(-239),
  generatedAt: z.string().datetime().nullable(),
  readyForLivePayout: z.literal(false),
  usdtJettonMaster: z.string().nullable(),
  observedJettonMasters: z
    .object({
      primary: z.string().nullable(),
      secondary: z.string().nullable(),
    })
    .nullable(),
  twoProviderMetadata: z
    .object({
      ok: z.boolean(),
      code: z.string().nullable(),
      symbol: z.string().nullable(),
      decimals: z.number().nullable(),
    })
    .nullable(),
  feeEstimation: z
    .object({
      mode: z.enum(['MOCK', 'LIVE_READ_ONLY', 'UNAVAILABLE']),
      estimatedNetworkFeeAtomic: z.string().nullable(),
      candidateAttachedGramAtomic: z.string().nullable(),
      forwardGramAtomic: z.string(),
      estimatedTotalNativeExposureAtomic: z.string().nullable(),
      broadcast: z.literal(false),
    })
    .nullable(),
  hotWallet: z
    .object({
      address: z.string().nullable(),
      payoutJettonWalletAddress: z.string().nullable(),
      derivationProofStatus: z.enum(['MISSING', 'VERIFIED', 'MISMATCH', 'BLOCKED']),
    })
    .nullable(),
  ceremonyAdminUserId: z.string().uuid().nullable(),
  databaseName: z.string().nullable(),
  notes: z.array(z.string()),
  sanitized: z.literal(true),
});

export type Phase21ProvisioningEvidence = z.infer<typeof Phase21ProvisioningEvidenceSchema>;

/** Empty sanitized fixture — not live evidence. */
export function buildEmptyPhase21ProvisioningEvidenceFixture(): Phase21ProvisioningEvidence {
  return {
    schemaVersion: 'phase21-provisioning-evidence.v1',
    networkCode: 'TON_MAINNET',
    networkGlobalId: -239,
    generatedAt: null,
    readyForLivePayout: false,
    usdtJettonMaster: null,
    observedJettonMasters: null,
    twoProviderMetadata: null,
    feeEstimation: null,
    hotWallet: null,
    ceremonyAdminUserId: null,
    databaseName: null,
    notes: [
      'SCHEMA_FIXTURE_NOT_LIVE',
      'Do not treat as operational ceremony evidence',
      'readyForLivePayout always false',
    ],
    sanitized: true,
  };
}

export function parsePhase21ProvisioningEvidence(input: unknown): Phase21ProvisioningEvidence {
  return Phase21ProvisioningEvidenceSchema.parse(input);
}
