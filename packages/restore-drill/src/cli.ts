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
 * Mode:
 *   PHASE18_RESTORE_DRILL_MODE=DB_ONLY_STEP2A|FULL_STEP2B (default DB_ONLY_STEP2A)
 *
 * FULL_STEP2B additional:
 *   PHASE18_SOURCE_DATABASE_HOST=...
 *   PHASE18_SOURCE_COUNT_CAPTURE_PATH=...
 *   PHASE18_TEMPORAL_ADDRESS=...
 *   PHASE18_TEMPORAL_NAMESPACE=...
 *   PHASE18_RESTORE_VERIFY_ALL_USERS=true  OR  PHASE18_RESTORE_VERIFY_USER_IDS=...
 *
 * Never uses DATABASE_URL as fallback. Isolation is host/service based.
 */

import { writeFile } from 'node:fs/promises';

import { RestoreTargetGuardError } from './target-guard.js';
import { parseRestoreDrillEnv } from './target-guard.js';
import { renderRestoreDrillMarkdown, serializeRestoreDrillReport } from './report.js';
import { runRestoreDrill } from './run-restore-drill.js';

async function main(): Promise<void> {
  try {
    const config = parseRestoreDrillEnv(process.env);
    const mode = config.drillMode;
    const report = await runRestoreDrill({ mode });
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
      // FULL gate may pass technically; resume remains Owner-gated (never auto-true here).
      process.exitCode = report.fullRestoreGatePass ? 0 : 2;
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