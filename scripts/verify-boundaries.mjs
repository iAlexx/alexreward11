import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('../', import.meta.url);
const requiredApps = ['admin', 'api', 'bot', 'miniapp', 'signer', 'worker'];
const requiredPackages = [
  'ads',
  'auth',
  'config',
  'contracts',
  'control-center',
  'db',
  'fraud',
  'i18n',
  'ledger',
  'notifications',
  'observability',
  'referrals',
  'rewards',
  'signing',
  'support',
  'tasks',
  'telegram',
  'ton',
  'ui',
  'wallets',
  'withdrawals',
];
const financialShells = [
  'ads',
  'fraud',
  // ledger is implemented in Phase 4 (Ledger Core).
  // rewards is implemented in Phase 5 (Reward Engine).
  // ton + wallets are implemented in Phase 6 (TON Connect wallet ownership).
  // withdrawals is implemented in Phase 7 (Withdrawal Engine + fake chain).
  // control-center is implemented in Phase 8 (Telegram Owner Control Center).
  'referrals',
  'tasks',
];

const failures = [];

async function directoryNames(relativePath) {
  return (await readdir(new URL(relativePath, root), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function assertExactSet(actual, expected, label) {
  const missing = expected.filter((item) => !actual.includes(item));
  if (missing.length > 0) failures.push(`${label} missing: ${missing.join(', ')}`);
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, root), 'utf8'));
}

async function walk(relativePath) {
  const absolute = new URL(relativePath, root);
  const entries = await readdir(absolute, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = join(relativePath, entry.name).replaceAll('\\', '/');
    if (entry.isDirectory()) files.push(...(await walk(`${child}/`)));
    else files.push(child);
  }
  return files;
}

const apps = await directoryNames('apps/');
const packages = await directoryNames('packages/');
assertExactSet(apps, requiredApps, 'applications');
assertExactSet(packages, requiredPackages, 'packages');

for (const area of [
  '.',
  ...apps.map((name) => `apps/${name}`),
  ...packages.map((name) => `packages/${name}`),
]) {
  const manifest = await readJson(`${area}/package.json`);
  const dependencyGroups = ['dependencies', 'devDependencies', 'peerDependencies'];
  for (const group of dependencyGroups) {
    for (const [name, version] of Object.entries(manifest[group] ?? {})) {
      if (typeof version !== 'string') continue;
      if (!version.startsWith('workspace:') && !/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(version)) {
        failures.push(`${area}: ${name} must use an exact version, found ${version}`);
      }
      if (name.startsWith('@alex-rewards/') && apps.includes(name.replace('@alex-rewards/', ''))) {
        failures.push(`${area}: applications may not depend on application ${name}`);
      }
    }
  }
}

const sourceFiles = [...(await walk('apps/')), ...(await walk('packages/control-center/'))].filter(
  (path) => /\.(?:ts|tsx|js|mjs)$/.test(path),
);
for (const path of sourceFiles) {
  const source = await readFile(new URL(path, root), 'utf8');
  if (!path.startsWith('apps/signer/') && /from\s+['"]@aws-sdk\/client-kms['"]/.test(source)) {
    failures.push(`${path}: only apps/signer may import the KMS client`);
  }
  if (
    (path.startsWith('apps/bot/src/') || path.startsWith('packages/control-center/src/')) &&
    (/from\s+['"]@alex-rewards\/ledger['"]/.test(source) ||
      /from\s+['"]@alex-rewards\/ton['"]/.test(source) ||
      /from\s+['"]@aws-sdk\/client-kms['"]/.test(source))
  ) {
    failures.push(`${path}: Control Center/bot src must not import ledger, TON, or KMS`);
  }
  if (/users\s*\.\s*balance|\bbalance\s+(?:bigint|numeric|integer)/i.test(source)) {
    failures.push(`${path}: mutable authoritative balance shortcut is forbidden`);
  }
  if (
    (path.startsWith('apps/miniapp/src/') || path.startsWith('apps/admin/src/')) &&
    /process\.env\.([A-Z0-9_]+)/g.test(source)
  ) {
    for (const match of source.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
      const key = match[1];
      if (
        key !== undefined &&
        key !== 'NODE_ENV' &&
        key !== 'NEXT_RUNTIME' &&
        !key.startsWith('NEXT_PUBLIC_')
      ) {
        failures.push(`${path}: frontend source references non-public environment key ${key}`);
      }
    }
  }
}

const signerManifest = await readJson('apps/signer/package.json');
for (const name of Object.keys(signerManifest.dependencies ?? {})) {
  if (name.includes('toncenter') || name.includes('tonapi')) {
    failures.push(`apps/signer: must not depend on TON RPC package ${name}`);
  }
}

for (const path of [...(await walk('apps/signer/')), ...(await walk('packages/signing/'))].filter(
  (p) => {
    const normalized = p.replaceAll('\\', '/');
    return (
      /\.(?:ts|tsx|js|mjs)$/.test(normalized) &&
      !normalized.includes('/dist/') &&
      !normalized.includes('/node_modules/') &&
      !normalized.includes('/test/')
    );
  },
)) {
  const source = await readFile(new URL(path, root), 'utf8');
  if (/from\s+['"][^'"]*(toncenter|tonapi)[^'"]*['"]/.test(source)) {
    failures.push(`${path}: signer/signing must not import TON RPC clients`);
  }
  if (/\bTonClient\b/.test(source) || /\.sendBoc\s*\(/.test(source)) {
    failures.push(`${path}: signer/signing must not use TonClient or chain broadcast helpers`);
  }
  if (
    path.startsWith('packages/signing/') &&
    /from\s+['"]@aws-sdk\/client-kms['"]/.test(source)
  ) {
    failures.push(`${path}: packages/signing must not import KMS client`);
  }
}

for (const bannedRoot of [
  'apps/api/',
  'apps/bot/',
  'apps/admin/',
  'apps/worker/',
  'packages/withdrawals/',
]) {
  for (const path of (await walk(bannedRoot)).filter((p) => /\.(?:ts|tsx|js|mjs)$/.test(p))) {
    const source = await readFile(new URL(path, root), 'utf8');
    if (/from\s+['"]@aws-sdk\/client-kms['"]/.test(source)) {
      failures.push(`${path}: only apps/signer may import the KMS client`);
    }
  }
}

for (const name of financialShells) {
  const files = await walk(`packages/${name}/src/`);
  if (files.length !== 1 || files[0] !== `packages/${name}/src/index.ts`) {
    failures.push(`packages/${name}: Phase 1 financial boundary must remain implementation-free`);
  }
  const source = await readFile(new URL(`packages/${name}/src/index.ts`, root), 'utf8');
  if (!source.includes('export {};')) failures.push(`packages/${name}: boundary shell was changed`);
}

// Phase 8: bot + control-center must not import KMS or TON sign paths;
// control-center production src must not import ledger (tests may fund fixtures).
const phase8BoundaryRoots = ['apps/bot/', 'packages/control-center/'];
for (const rootPath of phase8BoundaryRoots) {
  const files = (await walk(rootPath)).filter((path) => /\.(?:ts|tsx|js|mjs)$/.test(path));
  for (const path of files) {
    const source = await readFile(new URL(path, root), 'utf8');
    if (/from\s+['"]@aws-sdk\/client-kms['"]/.test(source)) {
      failures.push(`${path}: Control Center / bot must not import KMS client`);
    }
    if (/from\s+['"]@alex-rewards\/ton['"]/.test(source)) {
      failures.push(`${path}: Control Center / bot must not import TON package`);
    }
    if (
      path.startsWith('packages/control-center/src/') &&
      /from\s+['"]@alex-rewards\/ledger['"]/.test(source)
    ) {
      failures.push(`${path}: control-center src must not import ledger`);
    }
  }
}

if (failures.length > 0) {
  console.error(`Architecture validation failed:\n- ${failures.join('\n- ')}`);
  process.exitCode = 1;
} else {
  console.log(`Architecture validation passed (${apps.length} apps, ${packages.length} packages).`);
}
