/**
 * Phase 20 Owner-approved Closed Beta fraud/trust/eligibility policy candidate.
 * Importing this module does NOT activate DB policies and has no network side effects.
 * Staging activation requires a separate Owner-gated ceremony.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const artifactPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../policy/phase20-closed-beta-owner-approved.json',
);

export const PHASE20_CLOSED_BETA_OWNER_APPROVED_POLICY = Object.freeze(
  JSON.parse(readFileSync(artifactPath, 'utf8')) as Readonly<{
    readonly artifactId: string;
    readonly phase: number;
    readonly status: string;
    readonly activationAuthorized: boolean;
    readonly sourceCommitAtApproval: string;
    readonly notes: readonly string[];
    readonly risk: {
      readonly thresholds: Readonly<Record<string, number>>;
      readonly signalWeights: Readonly<Record<string, number>>;
      readonly signalParams: Readonly<Record<string, unknown>>;
      readonly actions: Readonly<Record<string, string>>;
    };
    readonly trust: unknown;
    readonly eligibility: unknown;
  }>,
);

if (PHASE20_CLOSED_BETA_OWNER_APPROVED_POLICY.activationAuthorized !== false) {
  throw new Error('Phase 20 approved policy artifact must keep activationAuthorized=false');
}