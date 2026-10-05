/**
 * TEST/TOOL ONLY — loads Owner-approved Phase 20 policy JSON.
 * Must never be imported from packages/fraud/src or package exports.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Phase20OwnerApprovedPolicyArtifact = Readonly<{
  readonly artifactId: string;
  readonly phase: number;
  readonly status: string;
  readonly activationAuthorized: boolean;
  readonly sourceCommitAtApproval: string;
  readonly notes: readonly string[];
  readonly risk: {
    readonly thresholds: Readonly<{
      readonly lowMax: number;
      readonly mediumMax: number;
      readonly highMax: number;
    }>;
    readonly signalWeights: Readonly<Record<string, number>>;
    readonly signalParams: Readonly<Record<string, unknown>>;
    readonly actions: Readonly<Record<string, string>>;
  };
  readonly trust: unknown;
  readonly eligibility: unknown;
}>;

const artifactPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../policy/phase20-closed-beta-owner-approved.json',
);

export function loadPhase20OwnerApprovedPolicy(): Phase20OwnerApprovedPolicyArtifact {
  const parsed = JSON.parse(readFileSync(artifactPath, 'utf8')) as Phase20OwnerApprovedPolicyArtifact;
  if (parsed.activationAuthorized !== false) {
    throw new Error('Phase 20 approved policy artifact must keep activationAuthorized=false');
  }
  return Object.freeze(parsed);
}

export const PHASE20_OWNER_APPROVED_POLICY_ARTIFACT_PATH = artifactPath;