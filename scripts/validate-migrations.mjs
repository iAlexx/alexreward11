import { readFile, readdir } from 'node:fs/promises';

const directory = new URL('../migrations/', import.meta.url);
const files = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
const failures = [];
let previous = -1;

for (const file of files) {
  const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(file);
  if (match === null) {
    failures.push(`${file}: expected NNNN_lower_snake_case.sql`);
    continue;
  }
  const order = Number(match[1]);
  if (order <= previous) failures.push(`${file}: migration number is not strictly increasing`);
  previous = order;

  const sql = await readFile(new URL(file, directory), 'utf8');
  if (!/^BEGIN;/m.test(sql) || !/^COMMIT;/m.test(sql)) {
    failures.push(`${file}: explicit BEGIN/COMMIT transaction markers are required`);
  }
  if (/ALTER\s+TABLE\s+users[\s\S]{0,200}ADD[\s\S]{0,100}\bbalance\b/i.test(sql)) {
    failures.push(`${file}: users.balance is prohibited by v1.1`);
  }
}

if (failures.length > 0) {
  console.error(`Migration validation failed:\n- ${failures.join('\n- ')}`);
  process.exitCode = 1;
} else {
  console.log(`Migration validation passed (${files.length} Phase 1 SQL migrations).`);
}
