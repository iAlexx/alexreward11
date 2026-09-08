#!/usr/bin/env node
/**
 * Cross-platform phase archive helper for ALEx Rewards.
 *
 * Default behavior (every phase):
 *   1) deterministic canonical source ZIP via git archive
 *   2) acceptance report + MANIFEST + SHA256SUMS
 *   3) final Owner review-package ZIP (forward-slash ZIP entry names)
 *   4) PACKAGE_SHA256.txt (external authoritative outer hash)
 *   5) extract / prohibited-path / nested / checksum verification at both levels
 *
 * Usage:
 *   node scripts/create-phase-archive.mjs \
 *     --phase 01 --slug FOUNDATION --commit <sha> --report <file> \
 *     [--roadmap-version 1.2] [--final-ci-url <url>] [--quality-job <id:result>] \
 *     [--docker-smoke-job <id:result>] [--historical-ci <text>] \
 *     [--expected-source-sha256 <hex>] [--next-phase-status <text>]
 *
 * Backfill outer package around a sealed canonical source ZIP (does not mutate it):
 *   node scripts/create-phase-archive.mjs \
 *     --from-existing phase-archives/PHASE_01_FOUNDATION \
 *     --phase 01 --slug FOUNDATION --commit <sha> \
 *     --next-phase-status "No Phase 2 work had started at packaging time." \
 *     [--expected-source-sha256 <hex>]
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ARCHIVE_HELPER_VERSION = '2.1.0';

export const PROHIBITED_PATH_PATTERNS = [
  /(^|\/)node_modules(\/|$)/i,
  /(^|\/)dist(\/|$)/i,
  /(^|\/)\.next(\/|$)/i,
  /(^|\/)\.turbo(\/|$)/i,
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)phase-archives(\/|$)/i,
  /\.(vhdx|wal|pid)$/i,
  /(^|\/).*wallet[_-]?seed.*/i,
  /(^|\/).*seed[_-]?phrase.*/i,
  /(^|\/).*mnemonic.*/i,
  /(^|\/).*private[_-]?key.*/i,
  /(^|\/).*kms[_-]?(key|material).*/i,
  /(^|\/).*provider[_-]?secret.*/i,
  /(^|\/).*telegram[_-]?bot[_-]?(token|secret).*/i,
  /(secret|credentials)\.(json|txt|pem|key)$/i,
];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function usage(exitCode = 1) {
  console.error(
    [
      'Usage:',
      '  node scripts/create-phase-archive.mjs --phase <NN> --slug <SLUG> --commit <sha> --report <file> [options]',
      '  node scripts/create-phase-archive.mjs --from-existing <dir> --phase <NN> --slug <SLUG> --commit <sha> [options]',
      '',
      'Options: --roadmap-version --final-ci-url --quality-job --docker-smoke-job --historical-ci --expected-source-sha256 --next-phase-status',
    ].join('\n'),
  );
  process.exit(exitCode);
}

export function parseArgs(argv) {
  const out = {
    phase: null,
    slug: null,
    commit: null,
    report: null,
    fromExisting: null,
    roadmapVersion: '1.2',
    finalCiUrl: null,
    qualityJob: null,
    dockerSmokeJob: null,
    historicalCi: null,
    expectedSourceSha256: null,
    nextPhaseStatus: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) usage();
    switch (key) {
      case '--phase':
        out.phase = value;
        break;
      case '--slug':
        out.slug = value;
        break;
      case '--commit':
        out.commit = value;
        break;
      case '--report':
        out.report = value;
        break;
      case '--from-existing':
        out.fromExisting = value;
        break;
      case '--roadmap-version':
        out.roadmapVersion = value;
        break;
      case '--final-ci-url':
        out.finalCiUrl = value;
        break;
      case '--quality-job':
        out.qualityJob = value;
        break;
      case '--docker-smoke-job':
        out.dockerSmokeJob = value;
        break;
      case '--historical-ci':
        out.historicalCi = value;
        break;
      case '--expected-source-sha256':
        out.expectedSourceSha256 = value.toLowerCase();
        break;
      case '--next-phase-status':
        out.nextPhaseStatus = value;
        break;
      default:
        usage();
    }
    i += 1;
  }
  if (!out.phase || !out.slug || !out.commit) usage();
  if (!out.fromExisting && !out.report) usage();
  if (!/^\d{2}$/.test(out.phase)) {
    console.error('--phase must be two digits, e.g. 00 or 01');
    process.exit(1);
  }
  if (!/^[A-Z0-9_]+$/.test(out.slug)) {
    console.error('--slug must be UPPER_SNAKE_CASE');
    process.exit(1);
  }
  return out;
}

export function defaultNextPhaseStatus(phase) {
  const next = String(Number.parseInt(phase, 10) + 1).padStart(2, '0');
  return `No Phase ${next} work has started at packaging time.`;
}

export function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return (result.stdout || '').trim();
}

export function sha256File(filePath) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

export function listFilesRecursive(rootDir) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(rootDir);
  return files;
}

export function isProhibited(relativePath, { packageZipName = null } = {}) {
  const normalized = relativePath.replace(/\\/g, '/');
  const name = basename(normalized);

  if (name === '.env.example') return false;
  if (name === '.env' || /^\.env\./i.test(name)) return true;
  if (packageZipName && (name === packageZipName || normalized.endsWith(`/${packageZipName}`))) {
    return true;
  }
  return PROHIBITED_PATH_PATTERNS.some((re) => re.test(normalized));
}

export function timestampUtc(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `${y}${m}${d}-${hh}${mm}${ss}`;
}

export function extractZip(zipPath, destDir) {
  mkdirSync(destDir, { recursive: true });
  if (process.platform === 'win32') {
    const ps = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
      ],
      { encoding: 'utf8' },
    );
    if (ps.status !== 0) {
      throw new Error(`Expand-Archive failed: ${ps.stderr || ps.stdout}`);
    }
    return;
  }
  const unzip = spawnSync('unzip', ['-q', zipPath, '-d', destDir], { encoding: 'utf8' });
  if (unzip.status !== 0) {
    throw new Error(`unzip failed: ${unzip.stderr || unzip.stdout}`);
  }
}

export function assertNoProhibited(files, rootDir, options = {}) {
  const prohibited = [];
  for (const file of files) {
    const relativePath = relative(rootDir, file).replace(/\\/g, '/');
    if (isProhibited(relativePath, options)) prohibited.push(relativePath);
  }
  if (prohibited.length > 0) {
    throw new Error(
      `Archive rejected: prohibited paths present:\n${prohibited.map((p) => `  - ${p}`).join('\n')}`,
    );
  }
}

export function parseSha256Sums(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^([0-9a-f]{64})\s+(.+)$/i.exec(trimmed);
    if (!match) throw new Error(`Invalid SHA256SUMS line: ${trimmed}`);
    map.set(match[2], match[1].toLowerCase());
  }
  return map;
}

export async function verifySha256Sums(sumsPath, directory) {
  const expected = parseSha256Sums(readFileSync(sumsPath, 'utf8'));
  for (const [name, digest] of expected.entries()) {
    const actual = await sha256File(join(directory, name));
    if (actual !== digest) {
      throw new Error(`Checksum mismatch for ${name}: expected ${digest}, got ${actual}`);
    }
  }
  return expected;
}

export function resolvePnpmVersion(repoRoot) {
  const runtime = spawnSync('pnpm', ['--version'], { encoding: 'utf8', shell: false });
  if (runtime.status === 0) {
    const version = (runtime.stdout || '').trim().replace(/^v/, '');
    if (version && version.toLowerCase() !== 'unknown') return version;
  }
  const pkgPath = join(repoRoot, 'package.json');
  if (!existsSync(pkgPath)) {
    throw new Error('Unable to resolve pnpm version: package.json missing');
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const match = /^pnpm@(.+)$/.exec(pkg.packageManager || '');
  if (match?.[1]) return match[1];
  throw new Error('Unable to resolve pnpm version from runtime or packageManager pin');
}

function u16(n) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(n, 0);
  return buf;
}

function u32(n) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(n >>> 0, 0);
  return buf;
}

/**
 * Create a ZIP archive using STORE compression and forward-slash entry names only.
 * @param {{ name: string, data: Buffer }[]} entries
 * @returns {Buffer}
 */
export function buildZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    if (entry.name.includes('\\')) {
      throw new Error(`ZIP entry name must not contain backslashes: ${entry.name}`);
    }
    const name = entry.name;
    if (!name || name.startsWith('/')) {
      throw new Error(`Invalid ZIP entry name: ${name}`);
    }
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const localHeader = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),
      nameBuf,
    ]);
    localParts.push(localHeader, data);

    const centralHeader = Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBuf,
    ]);
    centralParts.push(centralHeader);
    offset += localHeader.length + data.length;
  }

  const central = Buffer.concat(centralParts);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(central.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...localParts, central, end]);
}

export function listZipEntryNames(zipBuffer) {
  const names = [];
  let i = 0;
  while (i + 4 <= zipBuffer.length) {
    const sig = zipBuffer.readUInt32LE(i);
    if (sig === 0x04034b50) {
      const nameLen = zipBuffer.readUInt16LE(i + 26);
      const extraLen = zipBuffer.readUInt16LE(i + 28);
      const compSize = zipBuffer.readUInt32LE(i + 18);
      const nameStart = i + 30;
      const name = zipBuffer.subarray(nameStart, nameStart + nameLen).toString('utf8');
      names.push(name);
      i = nameStart + nameLen + extraLen + compSize;
      continue;
    }
    if (sig === 0x02014b50 || sig === 0x06054b50) break;
    i += 1;
  }
  return names;
}

export function assertForwardSlashZipEntries(zipBuffer) {
  const names = listZipEntryNames(zipBuffer);
  if (names.length === 0) throw new Error('ZIP contains no local file entries');
  for (const name of names) {
    if (name.includes('\\')) {
      throw new Error(`ZIP entry uses backslash path separator: ${name}`);
    }
  }
  return names;
}

function findCanonicalSourceZip(dir, phase, slug) {
  const prefix = `ALEx_Rewards_PHASE_${phase}_${slug}_`;
  const matches = readdirSync(dir).filter(
    (name) => name.startsWith(prefix) && name.endsWith('.zip') && !name.includes('_PACKAGE_'),
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one canonical source ZIP matching ${prefix}*.zip in ${dir}, found ${matches.length}`,
    );
  }
  return matches[0];
}

async function createZipFromFiles(zipPath, entries) {
  const buffer = buildZipBuffer(entries);
  assertForwardSlashZipEntries(buffer);
  writeFileSync(zipPath, buffer);
  return buffer;
}

function buildManifest(fields) {
  return [
    '# Phase archive manifest',
    '',
    '- Project: ALEx Rewards',
    `- Phase number: ${fields.phase}`,
    `- Phase slug: ${fields.slug}`,
    `- Roadmap / specification version: ${fields.roadmapVersion}`,
    '- Acceptance status: PASS (archive created only after phase gate)',
    `- Full accepted commit SHA: \`${fields.fullSha}\``,
    `- Short SHA: \`${fields.shortSha}\``,
    `- Branch: \`${fields.branch}\``,
    `- Canonical source ZIP filename: \`${fields.sourceZipName}\``,
    `- Acceptance-report filename: \`${fields.reportOutName}\``,
    `- Final review-package filename: \`${fields.packageZipName}\``,
    `- Archive creation timestamp (UTC): ${new Date().toISOString()}`,
    `- Packaging stamp: ${fields.stamp}`,
    `- Historical CI evidence: ${fields.historicalCi || 'n/a'}`,
    `- Final CI run URL: ${fields.finalCiUrl || 'n/a'}`,
    `- quality job ID/result: ${fields.qualityJob || 'n/a'}`,
    `- docker-smoke job ID/result: ${fields.dockerSmokeJob || 'n/a'}`,
    `- Node.js: ${fields.nodeVersion}`,
    `- pnpm: ${fields.pnpmVersion}`,
    `- Archive helper version: ${ARCHIVE_HELPER_VERSION}`,
    '- Archive method: deterministic `git archive --format=zip` for canonical source; outer review package uses forward-slash ZIP entries',
    `- Next-phase status: ${fields.nextPhaseStatus}`,
    '',
  ].join('\n');
}

async function verifySourceZip(sourceZipPath, { packageZipName = null } = {}) {
  const extractRoot = mkdtempSync(join(tmpdir(), 'alex-source-extract-'));
  try {
    extractZip(sourceZipPath, extractRoot);
    const extracted = listFilesRecursive(extractRoot);
    if (extracted.length === 0) {
      throw new Error('Canonical source ZIP extraction produced zero files');
    }
    assertNoProhibited(extracted, extractRoot, { packageZipName });
    return {
      extractedFiles: extracted.length,
      extractionVerification: 'PASS',
      prohibitedPathScan: 'PASS',
    };
  } finally {
    rmSync(extractRoot, { recursive: true, force: true });
  }
}

async function verifyReviewPackage({
  packageZipPath,
  packageZipName,
  phaseDirName,
  expectedNames,
  sourceZipName,
}) {
  const zipBuffer = readFileSync(packageZipPath);
  const entryNames = assertForwardSlashZipEntries(zipBuffer);
  const expectedEntryNames = expectedNames.map((name) => `${phaseDirName}/${name}`).sort();
  const actualSorted = [...entryNames].sort();
  if (actualSorted.join('\n') !== expectedEntryNames.join('\n')) {
    throw new Error(
      `Review package ZIP entry mismatch.\nExpected:\n${expectedEntryNames.join('\n')}\nActual:\n${actualSorted.join('\n')}`,
    );
  }

  const extractRoot = mkdtempSync(join(tmpdir(), 'alex-package-extract-'));
  try {
    extractZip(packageZipPath, extractRoot);
    const extracted = listFilesRecursive(extractRoot);
    assertNoProhibited(extracted, extractRoot, { packageZipName });

    const packageRoot = join(extractRoot, phaseDirName);
    if (!existsSync(packageRoot) || !statSync(packageRoot).isDirectory()) {
      throw new Error(`Review package missing required root directory ${phaseDirName}/`);
    }

    const actualNames = readdirSync(packageRoot).sort();
    const expectedSorted = [...expectedNames].sort();
    if (actualNames.join('\n') !== expectedSorted.join('\n')) {
      throw new Error(
        `Review package contents mismatch.\nExpected:\n${expectedSorted.join('\n')}\nActual:\n${actualNames.join('\n')}`,
      );
    }

    await verifySha256Sums(join(packageRoot, 'SHA256SUMS.txt'), packageRoot);

    const nestedSource = join(packageRoot, sourceZipName);
    const nested = await verifySourceZip(nestedSource, { packageZipName });

    return {
      extractionVerification: 'PASS',
      prohibitedPathScan: 'PASS',
      nestedArchiveValidation: nested.extractionVerification,
      nestedProhibitedPathScan: nested.prohibitedPathScan,
      nestedExtractedFiles: nested.extractedFiles,
      zipEntryNames: entryNames,
    };
  } finally {
    rmSync(extractRoot, { recursive: true, force: true });
  }
}

export async function createPhaseArchive(args, { cwd = process.cwd(), now = new Date() } = {}) {
  const repoRoot = resolve(cwd);
  const fullSha = runGit(['rev-parse', `${args.commit}^{commit}`], repoRoot);
  if (!/^[0-9a-f]{40}$/i.test(fullSha)) {
    throw new Error(`Could not resolve full commit SHA from ${args.commit}`);
  }
  runGit(['cat-file', '-e', `${fullSha}^{commit}`], repoRoot);

  const shortSha = fullSha.slice(0, 7);
  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
  const nodeVersion = process.version.replace(/^v/, '');
  const pnpmVersion = resolvePnpmVersion(repoRoot);
  const stamp = timestampUtc(now);
  const phaseDirName = `PHASE_${args.phase}_${args.slug}`;
  const outDir = args.fromExisting
    ? resolve(repoRoot, args.fromExisting)
    : join(repoRoot, 'phase-archives', phaseDirName);
  mkdirSync(outDir, { recursive: true });

  const reportOutName = `PHASE_${args.phase}_ACCEPTANCE_REPORT.md`;
  const reportOutPath = join(outDir, reportOutName);
  const manifestPath = join(outDir, 'MANIFEST.md');
  const sumsPath = join(outDir, 'SHA256SUMS.txt');
  const nextPhaseStatus = args.nextPhaseStatus || defaultNextPhaseStatus(args.phase);

  let sourceZipName;
  let sourceZipPath;
  let createdSource = false;

  if (args.fromExisting) {
    if (!existsSync(outDir)) {
      throw new Error(`Existing archive directory not found: ${outDir}`);
    }
    sourceZipName = findCanonicalSourceZip(outDir, args.phase, args.slug);
    sourceZipPath = join(outDir, sourceZipName);
    if (!existsSync(reportOutPath)) {
      throw new Error(`Existing acceptance report missing: ${reportOutName}`);
    }
    if (!existsSync(manifestPath) || !existsSync(sumsPath)) {
      throw new Error('Existing MANIFEST.md / SHA256SUMS.txt required for --from-existing');
    }
  } else {
    const reportPath = resolve(repoRoot, args.report);
    if (!existsSync(reportPath)) {
      throw new Error(`Acceptance report not found: ${reportPath}`);
    }
    sourceZipName = `ALEx_Rewards_PHASE_${args.phase}_${args.slug}_${stamp}_${shortSha}.zip`;
    sourceZipPath = join(outDir, sourceZipName);
    const archive = spawnSync('git', ['archive', '--format=zip', '-o', sourceZipPath, fullSha], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    if (archive.status !== 0) {
      throw new Error(`git archive failed: ${archive.stderr || archive.stdout}`);
    }
    copyFileSync(reportPath, reportOutPath);
    createdSource = true;
  }

  const sourceHashBefore = await sha256File(sourceZipPath);
  if (args.expectedSourceSha256 && sourceHashBefore !== args.expectedSourceSha256) {
    throw new Error(
      `Canonical source ZIP SHA256 changed/unexpected.\nExpected: ${args.expectedSourceSha256}\nActual:   ${sourceHashBefore}`,
    );
  }

  const sourceVerify = await verifySourceZip(sourceZipPath);
  const sourceHash = await sha256File(sourceZipPath);
  if (sourceHash !== sourceHashBefore) {
    throw new Error('Canonical source ZIP checksum changed during verification');
  }

  // Remove previous outer packages for this directory so backfill replaces them cleanly.
  for (const name of readdirSync(outDir)) {
    if (name.includes('_PACKAGE_') && name.endsWith('.zip')) {
      rmSync(join(outDir, name), { force: true });
    }
  }

  const packageZipName = `${phaseDirName}_PACKAGE_${stamp}_${shortSha}.zip`;
  const packageZipPath = join(outDir, packageZipName);
  const packageShaPath = join(outDir, 'PACKAGE_SHA256.txt');

  const manifest = buildManifest({
    phase: args.phase,
    slug: args.slug,
    stamp,
    fullSha,
    shortSha,
    branch,
    roadmapVersion: args.roadmapVersion,
    sourceZipName,
    reportOutName,
    packageZipName,
    nodeVersion,
    pnpmVersion,
    finalCiUrl: args.finalCiUrl,
    qualityJob: args.qualityJob,
    dockerSmokeJob: args.dockerSmokeJob,
    historicalCi: args.historicalCi,
    nextPhaseStatus,
  });
  writeFileSync(manifestPath, manifest, 'utf8');

  const reportHash = await sha256File(reportOutPath);
  const manifestHash = await sha256File(manifestPath);
  writeFileSync(
    sumsPath,
    `${sourceHash}  ${sourceZipName}\n${reportHash}  ${reportOutName}\n${manifestHash}  MANIFEST.md\n`,
    'utf8',
  );

  const sourceHashAfterCompanions = await sha256File(sourceZipPath);
  if (sourceHashAfterCompanions !== sourceHash) {
    throw new Error('Canonical source ZIP mutated while writing companions');
  }

  const includeNames = [sourceZipName, reportOutName, 'MANIFEST.md', 'SHA256SUMS.txt'];
  const zipEntries = includeNames.map((name) => ({
    name: `${phaseDirName}/${name}`,
    data: readFileSync(join(outDir, name)),
  }));
  await createZipFromFiles(packageZipPath, zipEntries);

  const packageVerify = await verifyReviewPackage({
    packageZipPath,
    packageZipName,
    phaseDirName,
    expectedNames: includeNames,
    sourceZipName,
  });

  const packageHash = await sha256File(packageZipPath);
  writeFileSync(packageShaPath, `${packageHash}  ${packageZipName}\n`, 'utf8');
  const packageHashAfter = await sha256File(packageZipPath);
  if (packageHashAfter !== packageHash) {
    throw new Error('Review-package ZIP checksum changed after PACKAGE_SHA256 write');
  }
  const packageShaFile = readFileSync(packageShaPath, 'utf8').trim();
  if (packageShaFile !== `${packageHash}  ${packageZipName}`) {
    throw new Error('PACKAGE_SHA256.txt contents do not match recomputed package hash');
  }

  const summary = {
    ok: true,
    helperVersion: ARCHIVE_HELPER_VERSION,
    phase: args.phase,
    slug: args.slug,
    commit: fullSha,
    directory: outDir,
    createdSource,
    sourceZip: sourceZipPath,
    sourceSha256: sourceHash,
    report: reportOutPath,
    manifest: manifestPath,
    packageZip: packageZipPath,
    packageSha256: packageHash,
    packageShaFile: packageShaPath,
    pnpmVersion,
    nextPhaseStatus,
    sourceExtraction: sourceVerify.extractionVerification,
    sourceProhibitedPathScan: sourceVerify.prohibitedPathScan,
    packageExtraction: packageVerify.extractionVerification,
    packageProhibitedPathScan: packageVerify.prohibitedPathScan,
    nestedArchiveValidation: packageVerify.nestedArchiveValidation,
    zipEntryNames: packageVerify.zipEntryNames,
    overall: 'PASS',
  };

  console.log(JSON.stringify(summary, null, 2));
  console.log('PASS: canonical source ZIP + final review-package ZIP verified');
  return summary;
}

async function main() {
  const args = parseArgs(process.argv);
  await createPhaseArchive(args);
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
const selfPath = resolve(fileURLToPath(import.meta.url));
if (invoked && invoked.toLowerCase() === selfPath.toLowerCase()) {
  main().catch((error) => {
    console.error('FAIL:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
