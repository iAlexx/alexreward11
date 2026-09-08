import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ARCHIVE_HELPER_VERSION,
  isProhibited,
  parseSha256Sums,
  timestampUtc,
} from './create-phase-archive.mjs';

test('helper version is set for dual-package workflow', () => {
  assert.equal(ARCHIVE_HELPER_VERSION, '2.0.0');
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
