/**
 * Phase 20 Step 4C.2 — preflight path + clean-source reproducibility (no DB).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type Paths = {
  fraudPackageRoot: string;
  repoRoot: string;
  artifactPath: string;
  snapshotPath: string;
};

type Evidence = {
  fraudPackageRoot: string;
  repoRoot: string;
  artifactPath: string;
  snapshotPath: string;
};

function expectedPathsFromTestFile(): Paths {
  const fraudPackageRoot = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
  const repoRoot = normalize(join(fraudPackageRoot, '..', '..'));
  return {
    fraudPackageRoot,
    repoRoot,
    artifactPath: normalize(
      join(fraudPackageRoot, 'policy', 'phase20-closed-beta-owner-approved.json'),
    ),
    snapshotPath: normalize(join(repoRoot, 'docs', 'phase20-step4c-preflight-snapshot.json')),
  };
}

function runPathEvidenceHelpers(fraudPackageRoot: string): {
  paths: Paths;
  evidence: Evidence;
} {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {
  assertPhase20Step4cPathsHealthy,
  resolvePhase20Step4cPaths,
  toCanonicalPathEvidence,
} from './scripts/phase20-step4c-paths.mjs';
const paths = resolvePhase20Step4cPaths();
assertPhase20Step4cPathsHealthy(paths);
const evidence = toCanonicalPathEvidence(paths);
process.stdout.write(JSON.stringify({ paths, evidence }));`,
    ],
    { cwd: fraudPackageRoot, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`path helpers spawn failed: ${result.stderr ?? result.stdout}`);
  }
  return JSON.parse(result.stdout ?? '{}') as {
    paths: Paths;
    evidence: Evidence;
  };
}

describe('Phase 20 Step 4C.2 preflight path + clean-source seal', () => {
  it('resolves absolute paths correctly and serializes repo-relative evidence only', () => {
    const expected = expectedPathsFromTestFile();
    const { paths, evidence } = runPathEvidenceHelpers(expected.fraudPackageRoot);

    expect(paths.fraudPackageRoot).toBe(expected.fraudPackageRoot);
    expect(paths.repoRoot).toBe(expected.repoRoot);
    expect(paths.artifactPath).toBe(expected.artifactPath);
    expect(paths.snapshotPath).toBe(expected.snapshotPath);
    expect(existsSync(paths.artifactPath)).toBe(true);

    expect(evidence).toEqual({
      fraudPackageRoot: 'packages/fraud',
      repoRoot: '.',
      artifactPath: 'packages/fraud/policy/phase20-closed-beta-owner-approved.json',
      snapshotPath: 'docs/phase20-step4c-preflight-snapshot.json',
    });
    expect(JSON.stringify(evidence)).not.toMatch(/Users\\|Desktop|:[\\/]/);

    const artifact = JSON.parse(readFileSync(paths.artifactPath, 'utf8')) as {
      activationAuthorized: boolean;
    };
    expect(artifact.activationAuthorized).toBe(false);
  });

  it('assertTrackedSourceClean enforces tracked cleanliness', () => {
    const expected = expectedPathsFromTestFile();
    const unstaged = spawnSync('git', ['diff', '--quiet'], {
      cwd: expected.repoRoot,
      encoding: 'utf8',
    });
    const staged = spawnSync('git', ['diff', '--cached', '--quiet'], {
      cwd: expected.repoRoot,
      encoding: 'utf8',
    });
    const dirty = unstaged.status !== 0 || staged.status !== 0;

    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { assertTrackedSourceClean, resolvePhase20Step4cPaths } from './scripts/phase20-step4c-paths.mjs';
const { sourceCommit } = assertTrackedSourceClean(resolvePhase20Step4cPaths().repoRoot);
process.stdout.write(sourceCommit);`,
      ],
      { cwd: expected.fraudPackageRoot, encoding: 'utf8' },
    );

    if (dirty) {
      expect(result.status).not.toBe(0);
      expect(`${result.stderr ?? ''}${result.stdout ?? ''}`).toMatch(/dirty/i);
    } else {
      expect(result.status).toBe(0);
      const git = spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: expected.repoRoot,
        encoding: 'utf8',
      });
      expect((result.stdout ?? '').trim()).toBe((git.stdout ?? '').trim());
    }
  });

  it('refuses PHASE20_STEP4C_ACTIVATE=1 via root wrapper', () => {
    const { repoRoot } = expectedPathsFromTestFile();
    const result = spawnSync('pnpm', ['phase20:step4c:preflight'], {
      cwd: repoRoot,
      env: { ...process.env, PHASE20_STEP4C_ACTIVATE: '1' },
      encoding: 'utf8',
      shell: true,
    });
    expect(result.status).toBe(2);
    expect(`${result.stdout ?? ''}\n${result.stderr ?? ''}`).toMatch(/REFUSED/i);
  });
});
