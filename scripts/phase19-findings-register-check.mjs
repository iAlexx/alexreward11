/**
 * Phase 19 finding-register integrity gate.
 * Requires exactly one canonical heading per P19-SEC-001..023 and consistent counts.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const path = join(root, 'docs', 'PHASE_19_SECURITY_FINDINGS.md');
const text = readFileSync(path, 'utf8');

const headingRe = /^### (P19-SEC-(\d{3})) — (.+)$/gm;
const headings = [];
let m;
while ((m = headingRe.exec(text)) !== null) {
  headings.push({ id: m[1], num: Number(m[2]), title: m[3], index: m.index });
}

const expected = Array.from(
  { length: 23 },
  (_, i) => `P19-SEC-${String(i + 1).padStart(3, '0')}`,
);
const errors = [];

const counts = new Map();
for (const h of headings) {
  counts.set(h.id, (counts.get(h.id) ?? 0) + 1);
}
for (const id of expected) {
  const c = counts.get(id) ?? 0;
  if (c !== 1) errors.push(`canonical heading count for ${id} = ${c} (want 1)`);
}
for (const id of counts.keys()) {
  if (!expected.includes(id)) errors.push(`unexpected finding heading ${id}`);
}

function sectionFor(id) {
  const h = headings.find((x) => x.id === id);
  if (!h) return '';
  const next = headings.find((x) => x.index > h.index);
  return text.slice(h.index, next ? next.index : text.length);
}

function field(section, name) {
  const mm = section.match(new RegExp(`- \\*\\*${name}:\\*\\*\\s*(.+)`, 'i'));
  return mm ? mm[1].trim() : null;
}

const openBySev = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
const openIds = [];
const resolvedIds = [];
const fpIds = [];
const mainnetFromSections = [];

for (const id of expected) {
  const sec = sectionFor(id);
  const status = (field(sec, 'status') ?? '').toUpperCase();
  const severity = (field(sec, 'severity') ?? '').toUpperCase();
  const blocker = (field(sec, 'Mainnet blocker') ?? '').toUpperCase();
  if (status === 'OPEN') {
    openIds.push(id);
    if (openBySev[severity] !== undefined) openBySev[severity] += 1;
    else errors.push(`${id} unknown severity ${severity}`);
    if (blocker.startsWith('YES')) mainnetFromSections.push(id);
  } else if (status === 'RESOLVED') resolvedIds.push(id);
  else if (status === 'FALSE_POSITIVE') fpIds.push(id);
  else errors.push(`${id} missing/invalid status: ${status}`);
}

const summaryOpen = {
  CRITICAL: Number((text.match(/\|\s*CRITICAL\s*\|\s*(\d+)/i) || [])[1]),
  HIGH: Number((text.match(/\|\s*HIGH\s*\|\s*(\d+)/i) || [])[1]),
  MEDIUM: Number((text.match(/\|\s*MEDIUM\s*\|\s*(\d+)/i) || [])[1]),
  LOW: Number((text.match(/\|\s*LOW\s*\|\s*(\d+)/i) || [])[1]),
  INFO: Number((text.match(/\|\s*INFO\s*\|\s*(\d+)/i) || [])[1]),
};

for (const sev of Object.keys(openBySev)) {
  if (Number.isFinite(summaryOpen[sev]) && summaryOpen[sev] !== openBySev[sev]) {
    errors.push(`summary OPEN ${sev}=${summaryOpen[sev]} != derived ${openBySev[sev]}`);
  }
}

const mainnetLine = text.match(/\*\*Mainnet-blocking open IDs:\*\*\s*(.+)/i);
if (mainnetLine) {
  const listed = [...mainnetLine[1].matchAll(/P19-SEC-\d{3}/g)].map((x) => x[0]);
  for (const id of listed) {
    if (!openIds.includes(id)) errors.push(`Mainnet list references non-OPEN ${id}`);
    if (!expected.includes(id)) errors.push(`Mainnet list unknown ${id}`);
  }
  for (const id of mainnetFromSections) {
    if (!listed.includes(id)) {
      errors.push(`OPEN Mainnet-blocker ${id} missing from summary list`);
    }
  }
} else if (mainnetFromSections.length > 0) {
  errors.push('Mainnet-blocking open IDs summary line missing');
} else if (!/\*\*Mainnet-blocking open IDs:\*\*\s*(none|—|-|n\/a)/i.test(text)) {
  // allow explicit none when no blockers
  if (!/\*\*Mainnet-blocking open IDs:\*\*\s*none/i.test(text)) {
    errors.push('Mainnet-blocking open IDs summary line missing (expected none)');
  }
}

if (errors.length > 0) {
  console.error('[phase19-findings-register] FAIL');
  for (const e of errors) console.error(' -', e);
  process.exit(1);
}

console.log('[phase19-findings-register] PASS');
console.log(
  JSON.stringify({ openBySev, openIds, resolvedIds, fpIds, mainnetFromSections }, null, 2),
);
