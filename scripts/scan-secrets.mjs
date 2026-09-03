import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('../', import.meta.url);
const excludedDirectories = new Set([
  '.git',
  '.next',
  'coverage',
  'dist',
  'node_modules',
  'reports',
]);
const excludedFiles = new Set(['pnpm-lock.yaml']);
const patterns = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['GitHub token', /\bgh[oprsu]_[A-Za-z0-9_]{30,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ['Telegram bot token', /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/],
  ['generic JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
];

async function walk(relativePath = '') {
  const entries = await readdir(new URL(relativePath || './', root), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const child = join(relativePath, entry.name).replaceAll('\\', '/');
    if (entry.isDirectory()) files.push(...(await walk(`${child}/`)));
    else if (!excludedFiles.has(entry.name)) files.push(child);
  }
  return files;
}

const findings = [];
for (const file of await walk()) {
  let content;
  try {
    content = await readFile(new URL(file, root), 'utf8');
  } catch {
    continue;
  }
  if (content.includes('\0')) continue;
  for (const [label, pattern] of patterns) {
    if (pattern.test(content)) findings.push(`${file}: ${label}`);
  }
}

if (findings.length > 0) {
  console.error(`Potential secrets found:\n- ${findings.join('\n- ')}`);
  process.exitCode = 1;
} else {
  console.log('Secret-pattern scan passed.');
}
