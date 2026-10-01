/**
 * Phase 20 Step 4C — staging policy activation PREFLIGHT (read-only / dry-run).
 *
 * Default behavior: refuse to run without PHASE20_STAGING_PREFLIGHT_DATABASE_URL,
 * enforce default_transaction_read_only=on, SELECT-only discovery, write snapshot JSON.
 *
 * This script intentionally does NOT implement activation / INSERT / UPDATE.
 * There is no PHASE20_STEP4C_ACTIVATE path in this Step.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import pg from 'pg';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

if (process.env.PHASE20_STEP4C_ACTIVATE === '1') {
  console.error('[phase20-step4c] REFUSED: activation mode is not implemented in Step 4C preflight tooling');
  process.exit(2);
}

const url = process.env.PHASE20_STAGING_PREFLIGHT_DATABASE_URL ?? '';
if (!url) {
  console.error('[phase20-step4c] PHASE20_STAGING_PREFLIGHT_DATABASE_URL required for live staging read-only discovery');
  console.error('[phase20-step4c] Use railway connect Postgres --tunnel-only and point a read-only session at the tunnel.');
  console.error('[phase20-step4c] Tip: existing snapshot docs/phase20-step4c-preflight-snapshot.json may already record a prior discovery.');
  process.exit(1);
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

const artifact = JSON.parse(
  readFileSync(join(root, 'packages/fraud/policy/phase20-closed-beta-owner-approved.json'), 'utf8'),
);
if (artifact.activationAuthorized !== false) {
  console.error('[phase20-step4c] REFUSED: artifact activationAuthorized must remain false');
  process.exit(2);
}

const pool = new pg.Pool({
  connectionString: url,
  application_name: 'phase20-step4c-preflight-ro',
  options: '-c default_transaction_read_only=on',
  max: 1,
  connectionTimeoutMillis: 15_000,
});

async function assertRo(client) {
  const r = await client.query(
    `SELECT current_setting('default_transaction_read_only') AS d, current_setting('transaction_read_only') AS t`,
  );
  const row = r.rows[0];
  if ((row?.d || '').toLowerCase() !== 'on' || (row?.t || '').toLowerCase() !== 'on') {
    throw new Error(`READ_ONLY_NOT_ENFORCED d=${row?.d} t=${row?.t}`);
  }
}

async function domainSummary(client, table, versionCol) {
  const counts = await client.query(`
    SELECT count(*)::int AS total_rows,
           count(*) FILTER (WHERE status = 'ACTIVE')::int AS active_rows,
           coalesce(max(${versionCol}), 0)::int AS highest_version
    FROM ${table}`);
  const nowActive = await client.query(`
    SELECT id::text, ${versionCol} AS version, status::text, effective_from, effective_to, reason, audit_reference
    FROM ${table}
    WHERE status = 'ACTIVE' AND effective_from <= now() AND (effective_to IS NULL OR now() < effective_to)
    ORDER BY ${versionCol} ASC`);
  const recent = await client.query(`
    SELECT id::text, ${versionCol} AS version, status::text, effective_from, effective_to, reason, audit_reference, created_at
    FROM ${table} ORDER BY ${versionCol} DESC LIMIT 5`);
  return { table, ...counts.rows[0], resolverNowMatches: nowActive.rows, recentVersions: recent.rows };
}

function plan(domain) {
  const activeNow = domain.resolverNowMatches;
  return {
    activeCountNow: activeNow.length,
    currentActiveVersion: activeNow.length === 1 ? activeNow[0].version : activeNow.length === 0 ? null : 'MULTIPLE',
    currentActiveId: activeNow.length === 1 ? activeNow[0].id : null,
    highestExistingVersion: domain.highest_version,
    proposedNextVersion: domain.highest_version + 1,
    conflict: activeNow.length > 1,
    zeroActive: activeNow.length === 0,
  };
}

const client = await pool.connect();
try {
  await assertRo(client);
  let mutationRefused = false;
  try {
    await client.query('CREATE TEMP TABLE phase20_preflight_probe(x int)');
  } catch (e) {
    mutationRefused = /read-only|cannot execute/i.test(String(e.message));
    if (!mutationRefused) throw e;
  }

  await client.query('BEGIN READ ONLY');
  await assertRo(client);
  const identity = await client.query(
    `SELECT current_database() AS database, current_user AS db_user, current_setting('application_name') AS application_name, now() AS observed_at`,
  );
  const risk = await domainSummary(client, 'risk_rule_versions', 'rule_version');
  const trust = await domainSummary(client, 'trust_rule_versions', 'rule_version');
  const eligibility = await domainSummary(client, 'eligibility_policy_versions', 'policy_version');
  const flags = await client.query(`
    SELECT flag_key, environment::text, enabled FROM feature_flags
    WHERE flag_key IN ('WITHDRAWAL_REQUESTS_PAUSE','PAYOUT_DISPATCH_PAUSE','MISSION_REWARD_PAUSE','REFERRAL_REWARD_PAUSE')
    ORDER BY flag_key, environment`);
  const ads = await client.query(`
    SELECT code, status::text, lifecycle_state::text, production_monetary_status::text
    FROM ad_providers WHERE code = 'ADSGRAM' LIMIT 1`);
  await client.query('ROLLBACK');

  const approvedRisk = {
    thresholds: artifact.risk.thresholds,
    signalWeights: artifact.risk.signalWeights,
    signalParams: artifact.risk.signalParams,
    actions: artifact.risk.actions,
  };
  const plans = { risk: plan(risk), trust: plan(trust), eligibility: plan(eligibility) };
  const report = {
    preflightAt: new Date().toISOString(),
    sourceCommit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
    artifactPath: 'packages/fraud/policy/phase20-closed-beta-owner-approved.json',
    activationAuthorized: false,
    readOnlyConfirmed: true,
    mutationRefused,
    identity: {
      database: identity.rows[0].database,
      dbUser: identity.rows[0].db_user,
      applicationName: identity.rows[0].application_name,
      observedAt: identity.rows[0].observed_at,
      accessMethod: 'PHASE20_STAGING_PREFLIGHT_DATABASE_URL + default_transaction_read_only=on',
    },
    approvedDigests: {
      risk: digest(approvedRisk),
      trust: digest(artifact.trust),
      eligibility: digest(artifact.eligibility),
      fullArtifact: digest(artifact),
    },
    risk,
    trust,
    eligibility,
    featureFlagsObserved: flags.rows,
    adsgramMonetary: ads.rows[0] ?? null,
    plans,
    activationPreflight:
      plans.risk.conflict || plans.trust.conflict || plans.eligibility.conflict
        ? 'BLOCKED'
        : 'READY_FOR_OWNER_AUTHORIZATION',
  };

  const out = join(root, 'docs/phase20-step4c-preflight-snapshot.json');
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log('[phase20-step4c] wrote', out);
  console.log('[phase20-step4c] ACTIVATION_PREFLIGHT=', report.activationPreflight);
  console.log('[phase20-step4c] plans=', JSON.stringify(report.plans));
  console.log('[phase20-step4c] PASS (read-only; no activation)');
} catch (e) {
  try {
    await client.query('ROLLBACK');
  } catch {
    /* ignore */
  }
  console.error('[phase20-step4c] FAIL', e instanceof Error ? e.message : e);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}