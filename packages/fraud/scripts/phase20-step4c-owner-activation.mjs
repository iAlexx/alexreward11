/**
 * Phase 20 Step 4C Owner-authorized staging activation ceremony.
 * Requires PHASE20_STEP4C_OWNER_ACTIVATION=1 and PHASE20_STAGING_ACTIVATION_DATABASE_URL.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  evaluateRiskSignals,
  evaluateTrustSignals,
  resolveActiveEligibilityPolicyVersion,
  resolveActiveRiskRuleVersion,
  resolveActiveTrustRuleVersion,
} from '../dist/index.js';

const fraudRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(fraudRoot, '..', '..');
const artifactPath = join(fraudRoot, 'policy', 'phase20-closed-beta-owner-approved.json');
const evidencePath = join(repoRoot, 'docs', 'phase20-step4c-activation-evidence.json');

if (process.env.PHASE20_STEP4C_OWNER_ACTIVATION !== '1') {
  console.error('[step4c-activate] REFUSED: set PHASE20_STEP4C_OWNER_ACTIVATION=1');
  process.exit(2);
}
const url = process.env.PHASE20_STAGING_ACTIVATION_DATABASE_URL ?? '';
if (!url) {
  console.error('[step4c-activate] PHASE20_STAGING_ACTIVATION_DATABASE_URL required');
  process.exit(2);
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function stableEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
if (artifact.activationAuthorized !== false) {
  console.error('[step4c-activate] artifact.activationAuthorized must remain false');
  process.exit(2);
}
if (artifact.artifactId !== 'PHASE20_CLOSED_BETA_OWNER_APPROVED_POLICY') {
  console.error('[step4c-activate] unexpected artifactId');
  process.exit(2);
}

const EXPECTED = {
  riskDigest: 'c81bf1edeb82b2e3bf8da45ef9a4b409f1557412da4b87d78d8f322e0045ebb5',
  trustDigest: '8b0d26cc3d3df43595ade3e63f70abc4a460dcb93a2bcf7afc1dd98d58ee5ba1',
  eligibilityDigest: '69c714db79b687d85f199cf812d485bc243d6ef53e69c64bf05f830b392aac28',
  fullDigest: '8f8e4cba511900d7320ca8d80205389648d81a7778ce3b86a0add790bc039eeb',
};

if (digest(artifact.risk) !== EXPECTED.riskDigest) throw new Error('risk digest mismatch');
if (digest(artifact.trust) !== EXPECTED.trustDigest) throw new Error('trust digest mismatch');
if (digest(artifact.eligibility) !== EXPECTED.eligibilityDigest) {
  throw new Error('eligibility digest mismatch');
}
if (digest(artifact) !== EXPECTED.fullDigest) throw new Error('full digest mismatch');

const REASON = 'PHASE20_STEP4C_OWNER_AUTHORIZED_CLOSED_BETA';
const FLAG_REASON = 'PHASE20_CLOSED_BETA_WITHDRAWAL_REQUEST_PAUSE';
const ADVISORY_KEY = 20200403;

const pool = new pg.Pool({
  connectionString: url,
  application_name: 'phase20-step4c-owner-activation',
  max: 1,
  connectionTimeoutMillis: 20_000,
});

async function count(client, sql, params = []) {
  const r = await client.query(sql, params);
  return Number(r.rows[0].c);
}

async function assertPreconditions(client) {
  const riskTotal = await count(client, `SELECT count(*)::text AS c FROM risk_rule_versions`);
  const riskActive = await count(
    client,
    `SELECT count(*)::text AS c FROM risk_rule_versions WHERE status='ACTIVE' AND effective_from <= now() AND (effective_to IS NULL OR now() < effective_to)`,
  );
  const trustTotal = await count(client, `SELECT count(*)::text AS c FROM trust_rule_versions`);
  const trustActive = await count(
    client,
    `SELECT count(*)::text AS c FROM trust_rule_versions WHERE status='ACTIVE' AND effective_from <= now() AND (effective_to IS NULL OR now() < effective_to)`,
  );
  const eligTotal = await count(
    client,
    `SELECT count(*)::text AS c FROM eligibility_policy_versions`,
  );
  const eligActive = await count(
    client,
    `SELECT count(*)::text AS c FROM eligibility_policy_versions WHERE status='ACTIVE' AND effective_from <= now() AND (effective_to IS NULL OR now() < effective_to)`,
  );
  if (riskTotal !== 0 || riskActive !== 0)
    throw new Error(`pre risk not empty ${riskTotal}/${riskActive}`);
  if (trustTotal !== 0 || trustActive !== 0)
    throw new Error(`pre trust not empty ${trustTotal}/${trustActive}`);
  if (eligTotal !== 0 || eligActive !== 0)
    throw new Error(`pre elig not empty ${eligTotal}/${eligActive}`);

  const wrp = await client.query(
    `SELECT enabled FROM feature_flags WHERE flag_key='WITHDRAWAL_REQUESTS_PAUSE' AND environment='STAGING'::environment_name`,
  );
  if (wrp.rowCount !== 0) throw new Error('WITHDRAWAL_REQUESTS_PAUSE/STAGING unexpectedly present');

  const payout = await client.query(
    `SELECT enabled FROM feature_flags WHERE flag_key='PAYOUT_DISPATCH_PAUSE' AND environment='STAGING'::environment_name`,
  );
  if (payout.rowCount !== 1 || payout.rows[0].enabled !== true) {
    throw new Error('PAYOUT_DISPATCH_PAUSE/STAGING must be true');
  }
  const referral = await client.query(
    `SELECT enabled FROM feature_flags WHERE flag_key='REFERRAL_REWARD_PAUSE' AND environment='STAGING'::environment_name`,
  );
  if (referral.rowCount !== 1 || referral.rows[0].enabled !== true) {
    throw new Error('REFERRAL_REWARD_PAUSE/STAGING must be true');
  }
  const ads = await client.query(
    `SELECT lifecycle_state::text, production_monetary_status::text FROM ad_providers WHERE code='ADSGRAM'`,
  );
  if (ads.rowCount !== 1) throw new Error('ADSGRAM row missing');
  if (ads.rows[0].lifecycle_state !== 'SANDBOX') throw new Error('ADSGRAM lifecycle not SANDBOX');
  if (ads.rows[0].production_monetary_status !== 'BLOCKED') {
    throw new Error('ADSGRAM monetary not BLOCKED');
  }

  return {
    riskTotal,
    trustTotal,
    eligTotal,
    ledgerBefore: await count(client, `SELECT count(*)::text AS c FROM ledger_entries`),
    wdBefore: await count(client, `SELECT count(*)::text AS c FROM withdrawals`),
    payoutBefore: await count(client, `SELECT count(*)::text AS c FROM payout_publications`),
    flagCountBefore: await count(client, `SELECT count(*)::text AS c FROM feature_flags`),
    adsgram: ads.rows[0],
  };
}

async function assertPost(client, before) {
  const riskActive = await count(
    client,
    `SELECT count(*)::text AS c FROM risk_rule_versions WHERE status='ACTIVE' AND effective_from <= now() AND (effective_to IS NULL OR now() < effective_to)`,
  );
  const trustActive = await count(
    client,
    `SELECT count(*)::text AS c FROM trust_rule_versions WHERE status='ACTIVE' AND effective_from <= now() AND (effective_to IS NULL OR now() < effective_to)`,
  );
  const eligActive = await count(
    client,
    `SELECT count(*)::text AS c FROM eligibility_policy_versions WHERE status='ACTIVE' AND effective_from <= now() AND (effective_to IS NULL OR now() < effective_to)`,
  );
  if (riskActive !== 1 || trustActive !== 1 || eligActive !== 1) {
    throw new Error(`active counts risk=${riskActive} trust=${trustActive} elig=${eligActive}`);
  }

  const risk = await resolveActiveRiskRuleVersion(client);
  const trust = await resolveActiveTrustRuleVersion(client);
  const elig = await resolveActiveEligibilityPolicyVersion(client);
  if (risk.ruleVersion !== 1) throw new Error('risk version != 1');
  if (trust.ruleVersion !== 1) throw new Error('trust version != 1');
  if (elig.policyVersion !== 1) throw new Error('eligibility version != 1');

  const riskShape = {
    thresholds: risk.thresholds,
    signalWeights: risk.signalWeights,
    signalParams: risk.signalParams,
    actions: risk.actions,
  };
  if (!stableEqual(riskShape, artifact.risk)) throw new Error('post risk config != artifact');
  if (!stableEqual(trust.policyConfig, artifact.trust))
    throw new Error('post trust config != artifact');
  if (!stableEqual(elig.policyConfig, artifact.eligibility)) {
    throw new Error('post eligibility config != artifact');
  }

  const wrp = await client.query(
    `SELECT id, enabled FROM feature_flags WHERE flag_key='WITHDRAWAL_REQUESTS_PAUSE' AND environment='STAGING'::environment_name`,
  );
  if (wrp.rowCount !== 1 || wrp.rows[0].enabled !== true) {
    throw new Error('WITHDRAWAL_REQUESTS_PAUSE/STAGING not true');
  }
  const verCount = await count(
    client,
    `SELECT count(*)::text AS c FROM feature_flag_versions WHERE feature_flag_id=$1::uuid`,
    [wrp.rows[0].id],
  );
  if (verCount !== 1) throw new Error(`flag version count ${verCount}`);

  const payout = await client.query(
    `SELECT enabled FROM feature_flags WHERE flag_key='PAYOUT_DISPATCH_PAUSE' AND environment='STAGING'::environment_name`,
  );
  if (payout.rows[0].enabled !== true) throw new Error('payout pause changed');
  const referral = await client.query(
    `SELECT enabled FROM feature_flags WHERE flag_key='REFERRAL_REWARD_PAUSE' AND environment='STAGING'::environment_name`,
  );
  if (referral.rows[0].enabled !== true) throw new Error('referral pause changed');

  const ads = await client.query(
    `SELECT lifecycle_state::text, production_monetary_status::text FROM ad_providers WHERE code='ADSGRAM'`,
  );
  if (ads.rows[0].production_monetary_status !== 'BLOCKED') throw new Error('adsgram unblocked');
  if (ads.rows[0].lifecycle_state !== 'SANDBOX') throw new Error('adsgram lifecycle changed');

  const flagCountAfter = await count(client, `SELECT count(*)::text AS c FROM feature_flags`);
  if (flagCountAfter !== before.flagCountBefore + 1) {
    throw new Error(`feature flag count drift ${before.flagCountBefore}->${flagCountAfter}`);
  }
  if (
    (await count(client, `SELECT count(*)::text AS c FROM ledger_entries`)) !== before.ledgerBefore
  ) {
    throw new Error('ledger mutated');
  }
  if ((await count(client, `SELECT count(*)::text AS c FROM withdrawals`)) !== before.wdBefore) {
    throw new Error('withdrawals mutated');
  }
  if (
    (await count(client, `SELECT count(*)::text AS c FROM payout_publications`)) !==
    before.payoutBefore
  ) {
    throw new Error('payout_attempts mutated');
  }

  return { risk, trust, elig };
}

function validateBehavior(riskRule, trustPolicy) {
  const zero = evaluateRiskSignals(riskRule, []);
  if (!(zero.score === 0 && zero.riskTier === 'LOW' && zero.action === 'MANUAL_REVIEW')) {
    throw new Error('risk zero failed');
  }
  const high = evaluateRiskSignals(riskRule, [
    { code: 'OPEN_HIGH_FRAUD_FLAG', active: true, reasonCode: 'TEST_OPEN_HIGH' },
  ]);
  if (!(high.score === 55 && high.riskTier === 'HIGH' && high.action === 'HELD')) {
    throw new Error('risk high failed');
  }
  const crit = evaluateRiskSignals(riskRule, [
    { code: 'OPEN_CRITICAL_FRAUD_FLAG', active: true, reasonCode: 'TEST_OPEN_CRIT' },
  ]);
  if (!(
    crit.score === 80 &&
    crit.riskTier === 'CRITICAL' &&
    crit.action === 'WITHDRAWAL_BLOCKED'
  )) {
    throw new Error('risk crit failed');
  }
  const conf = evaluateRiskSignals(riskRule, [
    { code: 'CONFIRMED_FRAUD_FLAG', active: true, reasonCode: 'TEST_CONFIRMED' },
  ]);
  if (!(conf.score === 60 && conf.riskTier === 'HIGH' && conf.action === 'HELD')) {
    throw new Error('risk confirmed failed');
  }

  const t0 = evaluateTrustSignals(trustPolicy, []);
  if (!(t0.score === 0 && t0.trustState === 'NEW')) throw new Error('trust 0 failed');
  const basic = evaluateTrustSignals(trustPolicy, [
    { code: 'ACCOUNT_AGE', satisfied: true, reasonCode: 'TEST_AGE' },
  ]);
  if (!(basic.score === 25 && basic.trustState === 'BASIC')) throw new Error('trust 25 failed');
  const est = evaluateTrustSignals(trustPolicy, [
    { code: 'ACCOUNT_AGE', satisfied: true, reasonCode: 'TEST_AGE' },
    { code: 'VERIFIED_PRIMARY_WALLET_AGE', satisfied: true, reasonCode: 'TEST_WALLET' },
  ]);
  if (!(est.score === 50 && est.trustState === 'ESTABLISHED')) throw new Error('trust 50 failed');
  const trusted = evaluateTrustSignals(trustPolicy, [
    { code: 'ACCOUNT_AGE', satisfied: true, reasonCode: 'TEST_AGE' },
    { code: 'VERIFIED_PRIMARY_WALLET_AGE', satisfied: true, reasonCode: 'TEST_WALLET' },
    { code: 'REWARDED_AD_HISTORY', satisfied: true, reasonCode: 'TEST_AD' },
  ]);
  if (!(trusted.score === 75 && trusted.trustState === 'TRUSTED'))
    throw new Error('trust 75 failed');

  return {
    risk: {
      zero: { score: zero.score, tier: zero.riskTier, action: zero.action },
      high: { score: high.score, tier: high.riskTier, action: high.action },
      critical: { score: crit.score, tier: crit.riskTier, action: crit.action },
      confirmed: { score: conf.score, tier: conf.riskTier, action: conf.action },
    },
    trust: {
      s0: t0.trustState,
      s25: basic.trustState,
      s50: est.trustState,
      s75: trusted.trustState,
    },
  };
}

const client = await pool.connect();
const evidence = {
  activatedAt: null,
  sourceCommit: process.env.RUNTIME_HEAD ?? null,
  artifactPath: 'packages/fraud/policy/phase20-closed-beta-owner-approved.json',
  approvedDigests: EXPECTED,
  transactionResult: null,
  pre: null,
  post: null,
  behavior: null,
  moneySafety: null,
};
try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock($1)', [ADVISORY_KEY]);
  const before = await assertPreconditions(client);
  evidence.pre = {
    riskTotal: before.riskTotal,
    trustTotal: before.trustTotal,
    eligibilityTotal: before.eligTotal,
    withdrawalPauseState: 'MISSING',
    adsgram: before.adsgram,
  };
  console.log('[step4c-activate] preconditions PASS');

  const flagIns = await client.query(
    `INSERT INTO feature_flags (flag_key, environment, enabled, description)
     VALUES ('WITHDRAWAL_REQUESTS_PAUSE', 'STAGING'::environment_name, true, 'Kill switch: pause new withdrawal requests.')
     RETURNING id`,
  );
  await client.query(
    `INSERT INTO feature_flag_versions (
       feature_flag_id, flag_version, old_enabled, new_enabled, reason,
       changed_by_admin_id, audit_log_id
     ) VALUES ($1::uuid, 1, NULL, true, $2, NULL, NULL)`,
    [flagIns.rows[0].id, FLAG_REASON],
  );

  await client.query(
    `INSERT INTO risk_rule_versions (
       rule_version, thresholds, signal_weights, signal_params, actions, status,
       effective_from, effective_to, reason, audit_reference, created_by_admin_id
     ) VALUES (
       1, $1::jsonb, $2::jsonb, $3::jsonb, $4::jsonb, 'ACTIVE'::rule_version_status,
       now(), NULL, $5, $5, NULL
     )`,
    [
      JSON.stringify(artifact.risk.thresholds),
      JSON.stringify(artifact.risk.signalWeights),
      JSON.stringify(artifact.risk.signalParams),
      JSON.stringify(artifact.risk.actions),
      REASON,
    ],
  );

  await client.query(
    `INSERT INTO trust_rule_versions (
       rule_version, status, effective_from, effective_to, reason, audit_reference,
       created_by_admin_id, policy_config
     ) VALUES (
       1, 'ACTIVE'::rule_version_status, now(), NULL, $1, $1, NULL, $2::jsonb
     )`,
    [REASON, JSON.stringify(artifact.trust)],
  );

  await client.query(
    `INSERT INTO eligibility_policy_versions (
       policy_version, status, effective_from, effective_to, reason, audit_reference,
       created_by_admin_id, policy_config
     ) VALUES (
       1, 'ACTIVE'::rule_version_status, now(), NULL, $1, $1, NULL, $2::jsonb
     )`,
    [REASON, JSON.stringify(artifact.eligibility)],
  );

  const post = await assertPost(client, before);
  const behavior = validateBehavior(post.risk, post.trust.policyConfig);
  evidence.behavior = behavior;
  evidence.post = {
    riskActiveVersion: 1,
    trustActiveVersion: 1,
    eligibilityActiveVersion: 1,
    riskActiveCount: 1,
    trustActiveCount: 1,
    eligibilityActiveCount: 1,
    withdrawalRequestsPauseStaging: true,
    withdrawalPauseFlagVersion: 1,
    riskConfigDigest: EXPECTED.riskDigest,
    trustConfigDigest: EXPECTED.trustDigest,
    eligibilityConfigDigest: EXPECTED.eligibilityDigest,
  };
  evidence.moneySafety = {
    adsgramLifecycle: before.adsgram.lifecycle_state,
    adsgramProductionMonetaryStatus: before.adsgram.production_monetary_status,
    payoutDispatchPauseStaging: true,
    referralRewardPauseStaging: true,
    withdrawalRequestsPauseStaging: true,
  };

  await client.query('COMMIT');
  evidence.transactionResult = 'COMMITTED';
  evidence.activatedAt = new Date().toISOString();
  console.log('[step4c-activate] COMMITTED');
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  console.log('[step4c-activate] PASS');
} catch (err) {
  try {
    await client.query('ROLLBACK');
  } catch {
    /* ignore */
  }
  evidence.transactionResult = 'ROLLED_BACK';
  console.error('[step4c-activate] FAIL', err?.message ?? err);
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
