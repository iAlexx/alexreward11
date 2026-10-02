/**
 * Phase 20 Step 4C path resolution — shared by preflight tooling and reproducibility tests.
 * This module must live under packages/fraud/scripts/ so dirname(..)=fraud package root.
 */
import { existsSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @param {string} [fromUrl]
 */
export function resolvePhase20Step4cPaths(fromUrl = import.meta.url) {
  const fraudPackageRoot = normalize(join(dirname(fileURLToPath(fromUrl)), '..'));
  const repoRoot = normalize(join(fraudPackageRoot, '..', '..'));
  const artifactPath = normalize(
    join(fraudPackageRoot, 'policy', 'phase20-closed-beta-owner-approved.json'),
  );
  const snapshotPath = normalize(join(repoRoot, 'docs', 'phase20-step4c-preflight-snapshot.json'));
  return { fraudPackageRoot, repoRoot, artifactPath, snapshotPath };
}

export function assertPhase20Step4cPathsHealthy(paths) {
  const { fraudPackageRoot, repoRoot, artifactPath, snapshotPath } = paths;
  const dup = `${sep}packages${sep}fraud${sep}packages${sep}fraud${sep}`;
  if (artifactPath.includes(dup) || snapshotPath.includes(dup)) {
    throw new Error('duplicated packages/fraud/packages/fraud path detected');
  }
  if (!artifactPath.startsWith(fraudPackageRoot)) {
    throw new Error('artifactPath must be under fraudPackageRoot');
  }
  if (!snapshotPath.startsWith(join(repoRoot, 'docs'))) {
    throw new Error('snapshotPath must be under repoRoot/docs');
  }
  if (!existsSync(artifactPath)) {
    throw new Error(`canonical artifact missing: ${artifactPath}`);
  }
  if (!existsSync(join(repoRoot, 'package.json'))) {
    throw new Error(`repoRoot does not look like monorepo root: ${repoRoot}`);
  }
  return true;
}
