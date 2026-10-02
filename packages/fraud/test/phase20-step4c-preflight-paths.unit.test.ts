/**
 * Phase 20 Step 4C.1 — preflight path reproducibility (no DB).
 * Does not import .mjs into the TypeScript graph; validates via Node spawn + independent path math.
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

function loadPathsFromScriptModule(fraudPackageRoot: string): Paths {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { assertPhase20Step4cPathsHealthy, resolvePhase20Step4cPaths } from './scripts/phase20-step4c-paths.mjs';
const p = resolvePhase20Step4cPaths();
assertPhase20Step4cPathsHealthy(p);
process.stdout.write(JSON.stringify(p));`,
    ],
    { cwd: fraudPackageRoot, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`path module spawn failed: ${result.stderr ?? result.stdout}`);
  }
  return JSON.parse(result.stdout ?? '{}') as Paths;
}

describe('Phase 20 Step 4C.1 preflight path reproducibility', () => {
  it('resolves artifact under fraud package and snapshot under repo docs', () => {
    const expected = expectedPathsFromTestFile();
    const actual = loadPathsFromScriptModule(expected.fraudPackageRoot);

    expect(actual.fraudPackageRoot).toBe(expected.fraudPackageRoot);
    expect(actual.repoRoot).toBe(expected.repoRoot);
    expect(actual.artifactPath).toBe(expected.artifactPath);
    expect(actual.snapshotPath).toBe(expected.snapshotPath);

    expect(existsSync(actual.artifactPath)).toBe(true);
    expect(actual.artifactPath.replaceAll('\\', '/')).toMatch(
      /packages\/fraud\/policy\/phase20-closed-beta-owner-approved\.json$/,
    );
    expect(actual.snapshotPath.replaceAll('\\', '/')).toMatch(
      /docs\/phase20-step4c-preflight-snapshot\.json$/,
    );
    expect(
      actual.artifactPath.includes(`${sep}packages${sep}fraud${sep}packages${sep}fraud${sep}`),
    ).toBe(false);
    expect(actual.snapshotPath.includes(`${sep}packages${sep}fraud${sep}docs${sep}`)).toBe(false);

    const artifact = JSON.parse(readFileSync(actual.artifactPath, 'utf8')) as {
      activationAuthorized: boolean;
    };
    expect(artifact.activationAuthorized).toBe(false);
  });

  it('resolves git HEAD from repoRoot', () => {
    const { repoRoot } = expectedPathsFromTestFile();
    const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
    expect(git.status).toBe(0);
    expect((git.stdout ?? '').trim()).toMatch(/^[0-9a-f]{40}$/);
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
