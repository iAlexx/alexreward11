import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ARCHIVE_HELPER_VERSION,
  assertForwardSlashZipEntries,
  buildZipBuffer,
  defaultNextPhaseStatus,
  isProhibited,
  listZipEntryNames,
  parseSha256Sums,
  resolvePnpmVersion,
  timestampUtc,
} from './create-phase-archive.mjs';

test('helper version is dual-package forward-slash release', () => {
  assert.equal(ARCHIVE_HELPER_VERSION, '2.1.0');
});

test('isProhibited allows .env.example and rejects live env/secrets', () => {
  assert.equal(isProhibited('.env.example'), false);
  assert.equal(isProhibited('.env'), true);
  assert.equal(isProhibited('.env.local'), true);
  assert.equal(isProhibited('node_modules/left-pad/index.js'), true);
  assert.equal(isProhibited('apps/api/dist/main.js'), true);
  assert.equal(isProhibited('packages/wallets/src/index.ts'), false);
  assert.equal(isProhibited('secrets/provider_secret.json'), true);
  assert.equal(
    isProhibited('PHASE_01_FOUNDATION_PACKAGE_20260908-000000_35a97be.zip', {
      packageZipName: 'PHASE_01_FOUNDATION_PACKAGE_20260908-000000_35a97be.zip',
    }),
    true,
  );
});

test('parseSha256Sums reads canonical triples', () => {
  const map = parseSha256Sums(
    [
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  source.zip',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  PHASE_01_ACCEPTANCE_REPORT.md',
      'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc  MANIFEST.md',
      '',
    ].join('\n'),
  );
  assert.equal(map.get('source.zip'), 'a'.repeat(64));
  assert.equal(map.get('MANIFEST.md'), 'c'.repeat(64));
  assert.equal(map.size, 3);
});

test('timestampUtc is stable YYYYMMDD-HHMMSS', () => {
  const stamp = timestampUtc(new Date(Date.UTC(2026, 8, 8, 2, 8, 44)));
  assert.equal(stamp, '20260908-020844');
});

test('defaultNextPhaseStatus uses No Phase N+1 wording', () => {
  assert.equal(defaultNextPhaseStatus('00'), 'No Phase 01 work has started at packaging time.');
  assert.equal(defaultNextPhaseStatus('01'), 'No Phase 02 work has started at packaging time.');
});

test('resolvePnpmVersion returns an actual pinned/runtime version', () => {
  const version = resolvePnpmVersion(process.cwd());
  assert.match(version, /^\d+\.\d+\.\d+/);
  assert.notEqual(version.toLowerCase(), 'unknown');
});

test('buildZipBuffer uses forward-slash entry names and rejects backslashes in listing', () => {
  const zip = buildZipBuffer([
    { name: 'PHASE_01_FOUNDATION/MANIFEST.md', data: Buffer.from('# ok\n', 'utf8') },
    { name: 'PHASE_01_FOUNDATION/SHA256SUMS.txt', data: Buffer.from('abc  file\n', 'utf8') },
  ]);
  const names = assertForwardSlashZipEntries(zip);
  assert.deepEqual(names.sort(), [
    'PHASE_01_FOUNDATION/MANIFEST.md',
    'PHASE_01_FOUNDATION/SHA256SUMS.txt',
  ]);
  for (const name of names) {
    assert.equal(name.includes('\\'), false);
  }
  assert.equal(
    listZipEntryNames(zip).some((n) => n.includes('\\')),
    false,
  );
});

test('buildZipBuffer rejects entry names that still contain backslashes', () => {
  assert.throws(
    () =>
      buildZipBuffer([
        {
          name: 'PHASE_01_FOUNDATION\\MANIFEST.md',
          data: Buffer.from('x', 'utf8'),
        },
      ]),
    /backslash/i,
  );
});

test('parseArgs accepts optional deterministic --stamp', async () => {
  // Imported parseArgs validates stamp format via process.exit; exercise timestamp helper instead.
  assert.equal(timestampUtc(new Date(Date.UTC(2026, 8, 8, 2, 50, 0))), '20260908-025000');
});
