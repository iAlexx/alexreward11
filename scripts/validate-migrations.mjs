import { readFile, readdir } from 'node:fs/promises';

const directory = new URL('../migrations/', import.meta.url);
const files = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
const failures = [];
let previous = -1;

// A mutable authoritative balance shortcut on `users` is prohibited: money truth
// lives in the immutable ledger. Column names such as `balance`, `available_balance`
// or `balance_atomic` are rejected wherever they are defined.
const balanceColumnPattern = /^\s*"?([a-z_]*balance[a-z_]*)"?\s+(?![,)])/i;

/**
 * Remove `--` line comments so documentation that merely names the prohibited
 * column is not mistaken for a definition. Single-quoted strings and dollar-quoted
 * bodies are preserved.
 */
function stripLineComments(sql) {
  let output = '';
  let index = 0;
  while (index < sql.length) {
    if (sql.startsWith('--', index)) {
      const lineEnd = sql.indexOf('\n', index);
      index = lineEnd === -1 ? sql.length : lineEnd;
      continue;
    }
    if (sql[index] === "'") {
      const end = sql.indexOf("'", index + 1);
      const stop = end === -1 ? sql.length : end + 1;
      output += sql.slice(index, stop);
      index = stop;
      continue;
    }
    const dollarTag = /^\$[a-z_]*\$/i.exec(sql.slice(index));
    if (dollarTag !== null) {
      const tag = dollarTag[0];
      const end = sql.indexOf(tag, index + tag.length);
      const stop = end === -1 ? sql.length : end + tag.length;
      output += sql.slice(index, stop);
      index = stop;
      continue;
    }
    output += sql[index];
    index += 1;
  }
  return output;
}

function findUsersTableBody(sql) {
  const match = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?users"?\s*\(/i.exec(sql);
  if (match === null) return null;
  let depth = 0;
  for (let index = match.index + match[0].length - 1; index < sql.length; index += 1) {
    const character = sql[index];
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) return sql.slice(match.index + match[0].length, index);
    }
  }
  return null;
}

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
  const statements = stripLineComments(sql);
  if (/\busers\.balance\b/i.test(statements)) {
    failures.push(`${file}: users.balance is prohibited; money truth lives in the ledger`);
  }
  if (
    /ALTER\s+TABLE\s+(?:public\.)?"?users"?[\s\S]{0,200}ADD[\s\S]{0,100}\bbalance\b/i.test(
      statements,
    )
  ) {
    failures.push(`${file}: adding a users balance column is prohibited`);
  }
  const usersTableBody = findUsersTableBody(statements);
  if (usersTableBody !== null) {
    for (const line of usersTableBody.split('\n')) {
      const column = balanceColumnPattern.exec(line);
      if (column !== null) {
        failures.push(`${file}: users.${column[1]} is a prohibited mutable balance shortcut`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`Migration validation failed:\n- ${failures.join('\n- ')}`);
  process.exitCode = 1;
} else {
  console.log(`Migration validation passed (${files.length} Phase 2 SQL migrations).`);
}
