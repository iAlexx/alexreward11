/**
 * Exact financial-package import allowlist for restore-drill production source.
 * Rejects subpath, namespace, default, require, dynamic import, and re-export forms.
 */

export const RESTORE_DRILL_ALLOWED_LEDGER_IMPORTS = ['checkLedgerInvariants'] as const;
export const RESTORE_DRILL_ALLOWED_WITHDRAWALS_IMPORTS = [
  'runPhase10RestoreReconcileScan',
  'runPhase10ChainHistoryReadonlyValidate',
] as const;
export const RESTORE_DRILL_ALLOWED_DB_IMPORTS = ['listMigrationFiles'] as const;

const FINANCIAL_PACKAGES = [
  {
    pkg: '@alex-rewards/ledger',
    allowed: new Set<string>(RESTORE_DRILL_ALLOWED_LEDGER_IMPORTS),
  },
  {
    pkg: '@alex-rewards/withdrawals',
    allowed: new Set<string>(RESTORE_DRILL_ALLOWED_WITHDRAWALS_IMPORTS),
  },
  {
    pkg: '@alex-rewards/db',
    allowed: new Set<string>(RESTORE_DRILL_ALLOWED_DB_IMPORTS),
  },
] as const;

export interface RestoreDrillImportViolation {
  readonly packageName: string;
  readonly reason: string;
  readonly detail: string;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function collectNamedBindings(clause: string): string[] {
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

/**
 * Scan TypeScript/JavaScript source for forbidden financial package import forms.
 */
export function findRestoreDrillFinancialImportViolations(
  source: string,
): readonly RestoreDrillImportViolation[] {
  const code = stripComments(source);
  const violations: RestoreDrillImportViolation[] = [];

  for (const { pkg, allowed } of FINANCIAL_PACKAGES) {
    const escaped = pkg.replace('/', '\\/');

    if (new RegExp(`(?:from|import|require\\()\\s*['"]${escaped}\\/[^'"]+['"]`, 'g').test(code)) {
      violations.push({
        packageName: pkg,
        reason: 'SUBPATH_IMPORT',
        detail: `subpath import of ${pkg} is forbidden`,
      });
    }

    if (new RegExp(`import\\s+\\*\\s+as\\s+\\w+\\s+from\\s+['"]${escaped}['"]`).test(code)) {
      violations.push({
        packageName: pkg,
        reason: 'NAMESPACE_IMPORT',
        detail: `namespace import of ${pkg} is forbidden`,
      });
    }

    if (new RegExp(`import\\s+[A-Za-z_$][\\w$]*\\s+from\\s+['"]${escaped}['"]`).test(code)) {
      violations.push({
        packageName: pkg,
        reason: 'DEFAULT_IMPORT',
        detail: `default import of ${pkg} is forbidden`,
      });
    }

    if (new RegExp(`require\\(\\s*['"]${escaped}(?:\\/[^'"]*)?['"]\\s*\\)`).test(code)) {
      violations.push({
        packageName: pkg,
        reason: 'REQUIRE',
        detail: `require() of ${pkg} is forbidden`,
      });
    }

    if (new RegExp(`import\\(\\s*['"]${escaped}(?:\\/[^'"]*)?['"]\\s*\\)`).test(code)) {
      violations.push({
        packageName: pkg,
        reason: 'DYNAMIC_IMPORT',
        detail: `dynamic import() of ${pkg} is forbidden`,
      });
    }

    if (new RegExp(`export\\s+\\*\\s+from\\s+['"]${escaped}(?:\\/[^'"]*)?['"]`).test(code)) {
      violations.push({
        packageName: pkg,
        reason: 'REEXPORT_STAR',
        detail: `export * from ${pkg} is forbidden`,
      });
    }

    const exportNamed = new RegExp(
      `export\\s+(?:type\\s+)?\\{([^}]+)\\}\\s+from\\s+['"]${escaped}['"]`,
      'g',
    );
    let exportMatch: RegExpExecArray | null;
    while ((exportMatch = exportNamed.exec(code)) !== null) {
      const exported = exportMatch[1] ?? '';
      violations.push({
        packageName: pkg,
        reason: 'REEXPORT_NAMED',
        detail: `named re-export from ${pkg} is forbidden (${exported.trim()})`,
      });
    }

    const namedImport = new RegExp(
      `import\\s+(?:type\\s+)?\\{([^}]+)\\}\\s+from\\s+['"]${escaped}['"]`,
      'g',
    );
    let namedMatch: RegExpExecArray | null;
    while ((namedMatch = namedImport.exec(code)) !== null) {
      for (const name of collectNamedBindings(namedMatch[1] ?? '')) {
        if (!allowed.has(name)) {
          violations.push({
            packageName: pkg,
            reason: 'DISALLOWED_NAMED_IMPORT',
            detail: `${pkg} may only import { ${[...allowed].join(', ')} } (found ${name})`,
          });
        }
      }
    }
  }

  return violations;
}