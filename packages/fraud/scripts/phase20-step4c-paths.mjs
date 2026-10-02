/**
 * Phase 20 Step 4C path resolution — shared by preflight tooling and reproducibility tests.
 * This module must live under packages/fraud/scripts/ so dirname(..)=fraud package root.
 */
import { existsSync } from 'node:fs';
import { dirname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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

/**
 * Canonical evidence paths — repository-relative, POSIX separators, no machine home/desktop.
 * @param {{ repoRoot: string, fraudPackageRoot: string, artifactPath: string, snapshotPath: string }} paths
 */
export function toCanonicalPathEvidence(paths) {
  const toRel = (abs) => {
    const rel = relative(paths.repoRoot, abs).split(sep).join('/');
    if (
      !rel ||
      rel.startsWith('..') ||
      /^[A-Za-z]:/.test(rel) ||
      rel.includes('\\Users\\') ||
      rel.includes('/Users/')
    ) {
      throw new Error(`refusing non-repo-relative evidence path: ${abs} -> ${rel}`);
    }
    return rel === '' ? '.' : rel;
  };
  return {
    fraudPackageRoot: toRel(paths.fraudPackageRoot),
    repoRoot: '.',
    artifactPath: toRel(paths.artifactPath),
    snapshotPath: toRel(paths.snapshotPath),
  };
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
  const evidence = toCanonicalPathEvidence(paths);
  if (evidence.fraudPackageRoot !== 'packages/fraud') {
    throw new Error(`unexpected relative fraudPackageRoot: ${evidence.fraudPackageRoot}`);
  }
  if (evidence.artifactPath !== 'packages/fraud/policy/phase20-closed-beta-owner-approved.json') {
    throw new Error(`unexpected relative artifactPath: ${evidence.artifactPath}`);
  }
  if (evidence.snapshotPath !== 'docs/phase20-step4c-preflight-snapshot.json') {
    throw new Error(`unexpected relative snapshotPath: ${evidence.snapshotPath}`);
  }
  return true;
}

/**
 * Require tracked source clean (unstaged + staged). Untracked files are ignored.
 * @param {string} repoRoot
 * @returns {{ sourceCommit: string }}
 */
export function assertTrackedSourceClean(repoRoot) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  if (head.status !== 0) {
    throw new Error(`git rev-parse HEAD failed: ${head.stderr ?? head.stdout}`);
  }
  const sourceCommit = (head.stdout ?? '').trim();
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
    throw new Error(`unexpected HEAD: ${sourceCommit}`);
  }

  const unstaged = spawnSync('git', ['diff', '--quiet'], { cwd: repoRoot, encoding: 'utf8' });
  if (unstaged.status !== 0) {
    throw new Error(
      'tracked source is dirty (unstaged changes); commit tooling before live preflight',
    );
  }
  const staged = spawnSync('git', ['diff', '--cached', '--quiet'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (staged.status !== 0) {
    throw new Error(
      'tracked source is dirty (staged changes); commit tooling before live preflight',
    );
  }
  return { sourceCommit };
}
