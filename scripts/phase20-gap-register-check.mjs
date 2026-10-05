/**
 * Phase 20 gap-register integrity gate.
 * Validates P20-GAP-001..018 headings, YES/NO blocker fields, and summary/tally consistency.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const path = join(root, 'docs', 'PHASE_20_GAP_REGISTER.md');
const text = readFileSync(path, 'utf8');

const headingRe = /^### (P20-GAP-(\d{3})) — (.+)$/gm;
const headings = [];
let m;
while ((m = headingRe.exec(text)) !== null) {
  headings.push({ id: m[1], num: Number(m[2]), title: m[3], index: m.index });
}

const expectedCount = 18;
const expected = Array.from(
  { length: expectedCount },
  (_, i) => `P20-GAP-${String(i + 1).padStart(3, '0')}`,
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
  if (!expected.includes(id)) errors.push(`unexpected gap heading ${id}`);
}
for (let i = 0; i < headings.length; i += 1) {
  if (headings[i].num !== i + 1) {
    errors.push(`non-contiguous numbering at ${headings[i].id} (index ${i + 1})`);
  }
}

function sectionFor(id) {
  const h = headings.find((x) => x.id === id);
  if (!h) return '';
  const next = headings.find((x) => x.index > h.index);
  return text.slice(h.index, next ? next.index : text.length);
}

function field(section, name) {
  const mm = section.match(new RegExp(`- \\*\\*${name}\\?\\*\\*\\s*(.+)`, 'i'));
  return mm ? mm[1].trim() : null;
}

function firstToken(value) {
  if (!value) return null;
  const tok = value.trim().split(/\s+/)[0]?.toUpperCase() ?? null;
  return tok;
}

const blockerFields = ['blocks Closed Beta', 'blocks real-money beta', 'blocks Phase 20 archive'];

const closedBeta = [];
const realMoney = [];
const archive = [];
const nonBoolean = [];

for (const id of expected) {
  const sec = sectionFor(id);
  for (const name of blockerFields) {
    const raw = field(sec, name);
    const tok = firstToken(raw);
    if (tok !== 'YES' && tok !== 'NO') {
      nonBoolean.push({ id, name, raw });
      errors.push(`${id} field "${name}?" must begin with YES or NO (got: ${raw ?? 'MISSING'})`);
    }
  }
  if (firstToken(field(sec, 'blocks Closed Beta')) === 'YES') closedBeta.push(id);
  if (firstToken(field(sec, 'blocks real-money beta')) === 'YES') realMoney.push(id);
  if (firstToken(field(sec, 'blocks Phase 20 archive')) === 'YES') archive.push(id);
}

function summaryCount(label) {
  const mm = text.match(new RegExp(`\\|\\s*${label}\\s*\\|\\s*(\\d+)\\s*\\|`, 'i'));
  return mm ? Number(mm[1]) : NaN;
}

const summaryClosed = summaryCount('Blocks Closed Beta \\(observation / non-money\\)');
const summaryReal = summaryCount('Blocks real-money beta');
const summaryArchive = summaryCount('Blocks Phase 20 archive \\(until resolved or Owner-scoped\\)');

if (summaryClosed !== closedBeta.length) {
  errors.push(`summary Closed Beta count ${summaryClosed} != derived ${closedBeta.length}`);
}
if (summaryReal !== realMoney.length) {
  errors.push(`summary real-money count ${summaryReal} != derived ${realMoney.length}`);
}
if (summaryArchive !== archive.length) {
  errors.push(`summary archive count ${summaryArchive} != derived ${archive.length}`);
}

function listedIds(label) {
  const re = new RegExp(`\\*\\*${label}\\*\\*[\\s\\S]*?(?=\\n\\*\\*P20_|\\n## |$)`);
  const block = text.match(re)?.[0] ?? '';
  return [...block.matchAll(/P20-GAP-\d{3}/g)].map((x) => x[0]);
}

function sameList(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

const listedClosed = listedIds('P20_BLOCKING_CLOSED_BETA_GAPS');
const listedReal = listedIds('P20_BLOCKING_REAL_MONEY_GAPS');
const listedArchive = listedIds('P20_BLOCKING_ARCHIVE_GAPS');

if (!sameList(listedClosed, closedBeta)) {
  errors.push(
    `listed Closed Beta IDs [${listedClosed.join(',')}] != derived [${closedBeta.join(',')}]`,
  );
}
if (!sameList(listedReal, realMoney)) {
  errors.push(
    `listed real-money IDs [${listedReal.join(',')}] != derived [${realMoney.join(',')}]`,
  );
}
if (!sameList(listedArchive, archive)) {
  errors.push(`listed archive IDs [${listedArchive.join(',')}] != derived [${archive.join(',')}]`);
}

const result = {
  ok: errors.length === 0,
  gapCount: expectedCount,
  gapIds: expected,
  duplicateGapIds: [...counts.entries()].filter(([, c]) => c > 1).map(([id]) => id),
  nonBooleanBlockerFields: nonBoolean,
  closedBetaCount: closedBeta.length,
  closedBetaGaps: closedBeta,
  realMoneyCount: realMoney.length,
  realMoneyGaps: realMoney,
  archiveCount: archive.length,
  archiveGaps: archive,
  summaryCountsMatchDerived:
    summaryClosed === closedBeta.length &&
    summaryReal === realMoney.length &&
    summaryArchive === archive.length,
  blockerListsMatchDerived:
    sameList(listedClosed, closedBeta) &&
    sameList(listedReal, realMoney) &&
    sameList(listedArchive, archive),
  errors,
};

if (!result.ok) {
  console.error('[phase20-gap-register] FAIL');
  console.error(JSON.stringify(result, null, 2));
  process.exit(1);
}

console.log('[phase20-gap-register] PASS');
console.log(JSON.stringify(result, null, 2));
