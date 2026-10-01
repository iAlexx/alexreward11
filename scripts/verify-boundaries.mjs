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
  'ops-health',
  'referrals',
  'restore-drill',
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
  // ads is implemented in Phase 11 (AdsGram + provider framework).
  // fraud risk-rule core is implemented in Phase 14 (no ledger / payout authority).
  // ledger is implemented in Phase 4 (Ledger Core).
  // rewards is implemented in Phase 5 (Reward Engine).
  // ton + wallets are implemented in Phase 6 (TON Connect wallet ownership).
  // withdrawals is implemented in Phase 7 (Withdrawal Engine + fake chain).
  // control-center is implemented in Phase 8 (Telegram Owner Control Center).
  // referrals: Phase 15 rule authority + PENDING attribution (no money / activation).
  // tasks: Phase 16 mission version authority (no monetary issuance).
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
      if (name === '@aws-sdk/client-kms') {
        failures.push(
          `${area}: @aws-sdk/client-kms is forbidden in product apps/packages (AWS production custody OWNER REJECTED; use self-hosted FALLBACK_ENCRYPTED)`,
        );
      }
    }
  }
}

const sourceFiles = [...(await walk('apps/')), ...(await walk('packages/control-center/'))].filter(
  (path) => /\.(?:ts|tsx|js|mjs)$/.test(path),
);
for (const path of sourceFiles) {
  const source = await readFile(new URL(path, root), 'utf8');
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

// Forbid @aws-sdk/client-kms anywhere in product apps/packages (including signer).
const productTreeFiles = [...(await walk('apps/')), ...(await walk('packages/'))].filter((path) => {
  const normalized = path.replaceAll('\\', '/');
  return (
    /\.(?:ts|tsx|js|mjs)$/.test(normalized) &&
    !normalized.includes('/dist/') &&
    !normalized.includes('/node_modules/')
  );
});
for (const path of productTreeFiles) {
  const source = await readFile(new URL(path, root), 'utf8');
  if (
    /from\s+['"]@aws-sdk\/client-kms['"]/.test(source) ||
    /require\(['"]@aws-sdk\/client-kms['"]\)/.test(source)
  ) {
    failures.push(
      `${path}: @aws-sdk/client-kms import is forbidden in product apps/packages (self-hosted encrypted custody only)`,
    );
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
}

for (const name of financialShells) {
  const files = await walk(`packages/${name}/src/`);
  if (files.length !== 1 || files[0] !== `packages/${name}/src/index.ts`) {
    failures.push(`packages/${name}: Phase 1 financial boundary must remain implementation-free`);
  }
  const source = await readFile(new URL(`packages/${name}/src/index.ts`, root), 'utf8');
  if (!source.includes('export {};')) failures.push(`packages/${name}: boundary shell was changed`);
}

// Phase 11: ads may use Reward Engine but must never import ledger write APIs directly.
{
  const adsFiles = (await walk('packages/ads/')).filter((path) =>
    /\.(?:ts|tsx|js|mjs)$/.test(path.replaceAll('\\', '/')),
  );
  for (const path of adsFiles) {
    const source = await readFile(new URL(path, root), 'utf8');
    if (/from\s+['"]@alex-rewards\/ledger['"]/.test(source)) {
      failures.push(`${path}: packages/ads must not import @alex-rewards/ledger (use Reward Engine)`);
    }
    if (
      /postLedgerTransaction/.test(source) &&
      !path.includes('certification') &&
      !path.includes('.test.')
    ) {
      failures.push(`${path}: packages/ads must not call postLedgerTransaction`);
    }
  }
}

// Phase 14: fraud owns risk-rule resolution / snapshots only — never money, payout, or chain.
{
  const fraudFiles = (await walk('packages/fraud/')).filter((path) => {
    const normalized = path.replaceAll('\\', '/');
    return (
      /\.(?:ts|tsx|js|mjs)$/.test(normalized) &&
      !normalized.includes('/dist/') &&
      !normalized.includes('/node_modules/')
    );
  });
  for (const path of fraudFiles) {
    const source = await readFile(new URL(path, root), 'utf8');
    if (/from\s+['"]@alex-rewards\/ledger['"]/.test(source)) {
      failures.push(`${path}: packages/fraud must not import @alex-rewards/ledger`);
    }
    if (/from\s+['"]@alex-rewards\/withdrawals['"]/.test(source)) {
      failures.push(`${path}: packages/fraud must not import @alex-rewards/withdrawals`);
    }
    if (/from\s+['"]@alex-rewards\/control-center['"]/.test(source)) {
      failures.push(`${path}: packages/fraud must not import @alex-rewards/control-center`);
    }
    if (/from\s+['"]@alex-rewards\/signing['"]/.test(source)) {
      failures.push(`${path}: packages/fraud must not import @alex-rewards/signing`);
    }
    if (/from\s+['"]@alex-rewards\/ton['"]/.test(source)) {
      failures.push(`${path}: packages/fraud must not import @alex-rewards/ton`);
    }
    if (/from\s+['"]@alex-rewards\/rewards['"]/.test(source)) {
      failures.push(`${path}: packages/fraud must not import @alex-rewards/rewards`);
    }
    if (/\beval\s*\(/.test(source) || /\bnew\s+Function\s*\(/.test(source)) {
      failures.push(`${path}: packages/fraud must not use eval/Function executable rules`);
    }
  }
}

// Phase 15: referrals may resolve rules, PENDING attribution, and activation — never money/payout/chain.
{
  const referralFiles = (await walk('packages/referrals/')).filter((path) => {
    const normalized = path.replaceAll('\\', '/');
    return (
      /\.(?:ts|tsx|js|mjs)$/.test(normalized) &&
      !normalized.includes('/dist/') &&
      !normalized.includes('/node_modules/')
    );
  });
  for (const path of referralFiles) {
    const source = await readFile(new URL(path, root), 'utf8');
    if (/from\s+['"]@alex-rewards\/ledger['"]/.test(source)) {
      failures.push(`${path}: packages/referrals must not import @alex-rewards/ledger`);
    }
    if (/from\s+['"]@alex-rewards\/withdrawals['"]/.test(source)) {
      failures.push(`${path}: packages/referrals must not import @alex-rewards/withdrawals`);
    }
    if (/from\s+['"]@alex-rewards\/signing['"]/.test(source)) {
      failures.push(`${path}: packages/referrals must not import @alex-rewards/signing`);
    }
    if (/from\s+['"]@alex-rewards\/ton['"]/.test(source)) {
      failures.push(`${path}: packages/referrals must not import @alex-rewards/ton`);
    }
    if (/from\s+['"]@alex-rewards\/control-center['"]/.test(source)) {
      failures.push(`${path}: packages/referrals must not import @alex-rewards/control-center`);
    }
    if (/from\s+['"]@alex-rewards\/auth['"]/.test(source)) {
      failures.push(`${path}: packages/referrals must not import @alex-rewards/auth`);
    }
    if (/from\s+['"]@alex-rewards\/rewards['"]/.test(source)) {
      failures.push(`${path}: packages/referrals must not import @alex-rewards/rewards`);
    }
    if (/from\s+['"]@alex-rewards\/worker['"]/.test(source) || /from\s+['"]@alex-rewards\/worker\//.test(source)) {
      failures.push(`${path}: packages/referrals must not import @alex-rewards/worker`);
    }
    if (/\beval\s*\(/.test(source) || /\bnew\s+Function\s*\(/.test(source)) {
      failures.push(`${path}: packages/referrals must not use eval/Function executable rules`);
    }
  }
}

// Phase 16: tasks/mission may resolve versions via pg only — never money/payout/chain/signing.
{
  const taskFiles = (await walk('packages/tasks/')).filter((path) => {
    const normalized = path.replaceAll('\\', '/');
    return (
      /\.(?:ts|tsx|js|mjs)$/.test(normalized) &&
      !normalized.includes('/dist/') &&
      !normalized.includes('/node_modules/')
    );
  });
  for (const path of taskFiles) {
    const source = await readFile(new URL(path, root), 'utf8');
    if (/from\s+['"]@alex-rewards\/ledger['"]/.test(source)) {
      failures.push(`${path}: packages/tasks must not import @alex-rewards/ledger`);
    }
    if (/from\s+['"]@alex-rewards\/withdrawals['"]/.test(source)) {
      failures.push(`${path}: packages/tasks must not import @alex-rewards/withdrawals`);
    }
    if (/from\s+['"]@alex-rewards\/signing['"]/.test(source)) {
      failures.push(`${path}: packages/tasks must not import @alex-rewards/signing`);
    }
    if (/from\s+['"]@alex-rewards\/ton['"]/.test(source)) {
      failures.push(`${path}: packages/tasks must not import @alex-rewards/ton`);
    }
    if (/from\s+['"]@alex-rewards\/control-center['"]/.test(source)) {
      failures.push(`${path}: packages/tasks must not import @alex-rewards/control-center`);
    }
    if (/from\s+['"]@alex-rewards\/rewards['"]/.test(source)) {
      failures.push(`${path}: packages/tasks must not import @alex-rewards/rewards`);
    }
    if (/from\s+['"]@alex-rewards\/worker['"]/.test(source) || /from\s+['"]@alex-rewards\/worker\//.test(source)) {
      failures.push(`${path}: packages/tasks must not import @alex-rewards/worker`);
    }
    if (/\beval\s*\(/.test(source) || /\bnew\s+Function\s*\(/.test(source)) {
      failures.push(`${path}: packages/tasks must not use eval/Function executable rules`);
    }
  }
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

// Phase 14 Step 14: Admin SPA must not import the fraud package (API + SQL evidence only).
{
  const adminFiles = (await walk('apps/admin/')).filter((path) => {
    const normalized = path.replaceAll('\\', '/');
    return (
      /\.(?:ts|tsx|js|mjs)$/.test(normalized) &&
      !normalized.includes('/dist/') &&
      !normalized.includes('/node_modules/') &&
      !normalized.includes('/.next/')
    );
  });
  for (const path of adminFiles) {
    const source = await readFile(new URL(path, root), 'utf8');
    if (/from\s+['"]@alex-rewards\/fraud['"]/.test(source)) {
      failures.push(`${path}: apps/admin must not import @alex-rewards/fraud`);
    }
  }
}

// Committed .env.example must not assign real plaintext signer secrets.
const envExample = await readFile(new URL('.env.example', root), 'utf8');
const forbiddenPlaintextEnvKeys = [
  'SIGNER_PRIVATE_KEY',
  'SIGNER_SEED',
  'SIGNER_MNEMONIC',
  'SIGNER_KEY_PASSPHRASE',
];
for (const key of forbiddenPlaintextEnvKeys) {
  // Allow comment lines that mention the key as forbidden; reject assignments.
  const assignment = new RegExp(`^\\s*${key}\\s*=`, 'm');
  if (assignment.test(envExample)) {
    failures.push(
      `.env.example: ${key}= is forbidden (plaintext signer secrets must never be committed; comments that mark them FORBIDDEN are OK)`,
    );
  }
}

// Phase 18: ops-health is a read-model package — no financial mutation imports / SQL writes.
{
  const forbiddenOpsHealthImports = [
    '@alex-rewards/ledger',
    '@alex-rewards/withdrawals',
    '@alex-rewards/rewards',
    '@alex-rewards/signing',
    '@alex-rewards/ton',
    '@alex-rewards/control-center',
    '@alex-rewards/ads',
    '@alex-rewards/wallets',
    '@alex-rewards/fraud',
  ];
  const opsHealthSrc = (await walk('packages/ops-health/src/')).filter((path) =>
    /\.(?:ts|tsx|js|mjs)$/.test(path.replaceAll('\\', '/')),
  );
  for (const path of opsHealthSrc) {
    const normalized = path.replaceAll('\\', '/');
    if (normalized.includes('/dist/') || normalized.includes('.test.')) continue;
    const source = await readFile(new URL(path, root), 'utf8');
    for (const pkg of forbiddenOpsHealthImports) {
      const escaped = pkg.replace('/', '\\/');
      if (
        new RegExp(`from\\s+['"]${escaped}['"]`).test(source) ||
        new RegExp(`require\\(['"]${escaped}['"]\\)`).test(source)
      ) {
        failures.push(
          `${path}: ops-health must not import financial mutation package ${pkg}`,
        );
      }
    }
    // Strip comments before mutation scan so documentation of forbidden verbs is allowed.
    const withoutBlock = source.replace(/\/\*[\s\S]*?\*\//g, ' ');
    const withoutLine = withoutBlock
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
      .replace(/(^|[\s;(])--[^\n]*/g, '$1');
    if (
      /\bINSERT\s+INTO\b/i.test(withoutLine) ||
      /\bUPDATE\s+[A-Za-z_][\w.]*/i.test(withoutLine) ||
      /\bDELETE\s+FROM\b/i.test(withoutLine) ||
      /\bMERGE\s+INTO\b/i.test(withoutLine)
    ) {
      failures.push(`${path}: ops-health production source must not execute SQL mutations`);
    }
  }
}

// Phase 18 Step 2B: restore-drill may only import exact read-only financial symbols.
{
  const forbiddenRestoreDrillImports = [
    '@alex-rewards/signing',
    '@alex-rewards/ton',
    '@alex-rewards/ads',
    '@alex-rewards/rewards',
    '@alex-rewards/control-center',
    '@alex-rewards/fraud',
    '@alex-rewards/wallets',
  ];
  const financialAllowlists = [
    {
      pkg: '@alex-rewards/ledger',
      allowed: new Set(['checkLedgerInvariants']),
    },
    {
      pkg: '@alex-rewards/withdrawals',
      allowed: new Set([
        'runPhase10RestoreReconcileScan',
        'runPhase10ChainHistoryReadonlyValidate',
        'checkPhase10PayoutInvariants',
        'assertPhase10ReadonlyValidationReportIntegrity',
      ]),
    },
    {
      pkg: '@alex-rewards/db',
      allowed: new Set(['listMigrationFiles']),
    },
  ];
  const forbiddenNamedSurfaces = [
    'createDatabasePool',
    'migrateDatabase',
    'postLedger',
    'decideWithdrawal',
    'approveWithdrawal',
    'rejectWithdrawal',
    'dispatchPayout',
    'replayOutbox',
    'sendBoc',
    'workflow.start',
    'workflow.execute',
    'workflow.signal',
    'workflow.signalWithStart',
    'workflow.update',
    'workflow.cancel',
    'workflow.terminate',
  ];

  function stripComments(source) {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  }

  function collectNamedBindings(clause) {
    return clause
      .split(',')
      .map((part) =>
        part
          .replace(/\btype\b/g, '')
          .replace(/\bas\s+\w+/g, '')
          .trim(),
      )
      .filter((name) => name !== '');
  }

  function financialImportViolations(source) {
    const code = stripComments(source);
    const violations = [];
    for (const { pkg, allowed } of financialAllowlists) {
      const escaped = pkg.replace('/', '\\/');
      if (new RegExp(`(?:from|import|require\\()\\s*['"]${escaped}\\/[^'"]+['"]`).test(code)) {
        violations.push(`${pkg}: SUBPATH_IMPORT`);
      }
      if (new RegExp(`import\\s+\\*\\s+as\\s+\\w+\\s+from\\s+['"]${escaped}['"]`).test(code)) {
        violations.push(`${pkg}: NAMESPACE_IMPORT`);
      }
      if (new RegExp(`import\\s+[A-Za-z_$][\\w$]*\\s+from\\s+['"]${escaped}['"]`).test(code)) {
        violations.push(`${pkg}: DEFAULT_IMPORT`);
      }
      if (new RegExp(`require\\(\\s*['"]${escaped}(?:\\/[^'"]*)?['"]\\s*\\)`).test(code)) {
        violations.push(`${pkg}: REQUIRE`);
      }
      if (new RegExp(`import\\(\\s*['"]${escaped}(?:\\/[^'"]*)?['"]\\s*\\)`).test(code)) {
        violations.push(`${pkg}: DYNAMIC_IMPORT`);
      }
      if (new RegExp(`export\\s+\\*\\s+from\\s+['"]${escaped}(?:\\/[^'"]*)?['"]`).test(code)) {
        violations.push(`${pkg}: REEXPORT_STAR`);
      }
      const exportNamed = new RegExp(
        `export\\s+(?:type\\s+)?\\{([^}]+)\\}\\s+from\\s+['"]${escaped}['"]`,
        'g',
      );
      let exportMatch;
      while ((exportMatch = exportNamed.exec(code)) !== null) {
        violations.push(`${pkg}: REEXPORT_NAMED (${exportMatch[1].trim()})`);
      }
      const namedImport = new RegExp(
        `import\\s+(?:type\\s+)?\\{([^}]+)\\}\\s+from\\s+['"]${escaped}['"]`,
        'g',
      );
      let namedMatch;
      while ((namedMatch = namedImport.exec(code)) !== null) {
        for (const name of collectNamedBindings(namedMatch[1])) {
          if (!allowed.has(name)) {
            violations.push(
              `${pkg}: DISALLOWED_NAMED_IMPORT ${name} (allowed: ${[...allowed].join(', ')})`,
            );
          }
        }
      }
    }
    return violations;
  }

  const restoreDrillSrc = (await walk('packages/restore-drill/src/')).filter((path) =>
    /\.(?:ts|tsx|js|mjs)$/.test(path.replaceAll('\\', '/')),
  );
  for (const path of restoreDrillSrc) {
    const normalized = path.replaceAll('\\', '/');
    if (normalized.includes('/dist/') || normalized.includes('.test.')) continue;
    const source = await readFile(new URL(path, root), 'utf8');
    for (const pkg of forbiddenRestoreDrillImports) {
      const escaped = pkg.replace('/', '\\/');
      if (
        new RegExp(`from\\s+['"]${escaped}['"]`).test(source) ||
        new RegExp(`require\\(['"]${escaped}['"]\\)`).test(source)
      ) {
        failures.push(
          `${path}: restore-drill must not import mutation-capable package ${pkg}`,
        );
      }
    }

    for (const violation of financialImportViolations(source)) {
      failures.push(`${path}: restore-drill financial import boundary: ${violation}`);
    }

    const withoutLine = stripComments(source);
    if (
      /\bINSERT\s+INTO\b/i.test(withoutLine) ||
      /\bUPDATE\s+[A-Za-z_][\w.]*/i.test(withoutLine) ||
      /\bDELETE\s+FROM\b/i.test(withoutLine) ||
      /\bMERGE\s+INTO\b/i.test(withoutLine)
    ) {
      failures.push(`${path}: restore-drill production source must not execute SQL mutations`);
    }
    for (const surface of forbiddenNamedSurfaces) {
      const escaped = surface.replace('.', '\\.');
      if (new RegExp(`\\b${escaped}\\b`).test(withoutLine)) {
        failures.push(`${path}: restore-drill must not reference ${surface}`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`Architecture validation failed:\n- ${failures.join('\n- ')}`);
  process.exitCode = 1;
} else {
  console.log(`Architecture validation passed (${apps.length} apps, ${packages.length} packages).`);
}
