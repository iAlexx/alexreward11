#!/usr/bin/env node
/**
 * Phase 18 restore-drill CLI — read-only evidence against an isolated restored DB.
 *
 * Required env:
 *   PHASE18_RESTORE_DRILL_ENABLED=true
 *   PHASE18_RESTORE_DATABASE_URL=...
 *   PHASE18_RESTORE_EXPECTED_DATABASE_NAME=...
 *   PHASE18_RESTORE_EXPECTED_HOST=...
 *   PHASE18_RESTORE_FEATURE_FLAG_ENVIRONMENT=STAGING|LOCAL|...
 *
 * Optional:
 *   PHASE18_SOURCE_DATABASE_HOST=... (required for FULL_STEP2B)
 *   PHASE18_RESTORE_VERIFY_USER_IDS=uuid,uuid
 *
 * Never uses DATABASE_URL as fallback. Isolation is host/service based.
 */

import { writeFile } from 'node:fs/promises';

import { RestoreTargetGuardError } from './target-guard.js';
import { renderRestoreDrillMarkdown, serializeRestoreDrillReport } from './report.js';
import { runRestoreDrill } from './run-restore-drill.js';

async function main(): Promise<void> {
  try {
    const report = await runRestoreDrill({ mode: 'DB_ONLY_STEP2A' });
    const stamp = report.observedAt.replace(/[:.]/g, '-');
    const jsonPath = `phase18-restore-drill-${stamp}.json`;
    const mdPath = `phase18-restore-drill-${stamp}.md`;
    await writeFile(jsonPath, serializeRestoreDrillReport(report), 'utf8');
    await writeFile(mdPath, renderRestoreDrillMarkdown(report), 'utf8');
    process.stdout.write(renderRestoreDrillMarkdown(report));
    process.stdout.write(`\nWrote ${jsonPath}\nWrote ${mdPath}\n`);
    if (report.mode === 'DB_ONLY_STEP2A') {
      // Step 2A never allows resume; exit 0 only when DB-side validation itself passed.
      process.exitCode = report.restoreValidationPass ? 0 : 2;
    } else {
      process.exitCode = report.fullRestoreGatePass && report.payoutResumeAllowed ? 0 : 2;
    }
  } catch (error: unknown) {
    if (error instanceof RestoreTargetGuardError) {
      process.stderr.write(`RESTORE_TARGET_GUARD ${error.code}: ${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`RESTORE_DRILL_FAILED: ${message}\n`);
    process.exitCode = 1;
  }
}

await main();
