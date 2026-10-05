import pg from 'pg';
import {
  evaluateConfiguredEligibility,
  resolveActiveEligibilityPolicyVersion,
  resolveActiveRiskRuleVersion,
  resolveActiveTrustRuleVersion,
} from '../dist/index.js';

const url = process.env.PHASE20_STAGING_ACTIVATION_DATABASE_URL ?? '';
if (!url) {
  console.error('missing url');
  process.exit(1);
}
const pool = new pg.Pool({
  connectionString: url,
  application_name: 'phase20-step4c-post-validate',
  max: 1,
});
const c = await pool.connect();
try {
  const risk = await resolveActiveRiskRuleVersion(c);
  const trust = await resolveActiveTrustRuleVersion(c);
  const elig = await resolveActiveEligibilityPolicyVersion(c);
  console.log('RISK_ACTIVE_VERSION=' + risk.ruleVersion);
  console.log('TRUST_ACTIVE_VERSION=' + trust.ruleVersion);
  console.log('ELIGIBILITY_ACTIVE_VERSION=' + elig.policyVersion);

  const wrp = await c.query(
    `SELECT enabled FROM feature_flags WHERE flag_key='WITHDRAWAL_REQUESTS_PAUSE' AND environment='STAGING'`,
  );
  const payout = await c.query(
    `SELECT enabled FROM feature_flags WHERE flag_key='PAYOUT_DISPATCH_PAUSE' AND environment='STAGING'`,
  );
  const referral = await c.query(
    `SELECT enabled FROM feature_flags WHERE flag_key='REFERRAL_REWARD_PAUSE' AND environment='STAGING'`,
  );
  const ads = await c.query(
    `SELECT lifecycle_state::text AS ls, production_monetary_status::text AS ms FROM ad_providers WHERE code='ADSGRAM'`,
  );
  const ver = await c.query(
    `SELECT flag_version, old_enabled, new_enabled, reason FROM feature_flag_versions ffv JOIN feature_flags ff ON ff.id=ffv.feature_flag_id WHERE ff.flag_key='WITHDRAWAL_REQUESTS_PAUSE' AND ff.environment='STAGING'`,
  );
  console.log('WRP=' + wrp.rows[0]?.enabled + ' VER=' + JSON.stringify(ver.rows[0]));
  console.log('PAYOUT_PAUSE=' + payout.rows[0]?.enabled);
  console.log('REFERRAL_PAUSE=' + referral.rows[0]?.enabled);
  console.log('ADSGRAM=' + ads.rows[0]?.ls + '/' + ads.rows[0]?.ms);

  const policy = { policyVersion: elig.policyVersion, policyConfig: elig.policyConfig };
  const adOk = evaluateConfiguredEligibility(policy, 'AD_SESSION_START', [
    { code: 'ACCOUNT_STATE', eligible: true, reasonCode: 'ACCOUNT_STATE_OK' },
    { code: 'RISK_POLICY', eligible: true, reasonCode: 'RISK_POLICY_ALLOWED' },
  ]);
  const adHigh = evaluateConfiguredEligibility(policy, 'AD_SESSION_START', [
    { code: 'ACCOUNT_STATE', eligible: true, reasonCode: 'ACCOUNT_STATE_OK' },
    { code: 'RISK_POLICY', eligible: false, reasonCode: 'RISK_POLICY_BLOCKED' },
  ]);
  const adCrit = evaluateConfiguredEligibility(policy, 'AD_SESSION_START', [
    { code: 'ACCOUNT_STATE', eligible: true, reasonCode: 'ACCOUNT_STATE_OK' },
    { code: 'RISK_POLICY', eligible: false, reasonCode: 'RISK_POLICY_BLOCKED' },
  ]);
  const wdPause = evaluateConfiguredEligibility(policy, 'WITHDRAWAL_REQUEST', [
    { code: 'ACCOUNT_STATE', eligible: true, reasonCode: 'ACCOUNT_STATE_OK' },
    { code: 'RISK_POLICY', eligible: true, reasonCode: 'RISK_POLICY_ALLOWED' },
    { code: 'FEATURE_FLAG', eligible: false, reasonCode: 'FEATURE_FLAG_WITHDRAWAL_REQUESTS_PAUSE' },
  ]);
  console.log('AD_ORDINARY=' + adOk.outcome);
  console.log('AD_HIGH=' + adHigh.outcome);
  console.log('AD_CRIT=' + adCrit.outcome);
  console.log('WD_PAUSE=' + wdPause.outcome);

  const riskAllowed = elig.policyConfig.actions.AD_SESSION_START.riskAllowedActions;
  const highMappedIneligible = !riskAllowed.includes('HELD');
  const critMappedIneligible = !riskAllowed.includes('WITHDRAWAL_BLOCKED');
  console.log('HIGH_MAPPED_INELIGIBLE=' + highMappedIneligible);
  console.log('CRIT_MAPPED_INELIGIBLE=' + critMappedIneligible);

  const ok =
    risk.ruleVersion === 1 &&
    trust.ruleVersion === 1 &&
    elig.policyVersion === 1 &&
    wrp.rows[0]?.enabled === true &&
    ver.rows[0]?.flag_version === 1 &&
    ver.rows[0]?.new_enabled === true &&
    payout.rows[0]?.enabled === true &&
    referral.rows[0]?.enabled === true &&
    ads.rows[0]?.ls === 'SANDBOX' &&
    ads.rows[0]?.ms === 'BLOCKED' &&
    adOk.outcome === 'ELIGIBLE' &&
    adHigh.outcome === 'INELIGIBLE_RISK_POLICY' &&
    adCrit.outcome === 'INELIGIBLE_RISK_POLICY' &&
    wdPause.outcome === 'INELIGIBLE_FEATURE_DISABLED' &&
    highMappedIneligible &&
    critMappedIneligible;
  console.log(ok ? 'POST_VALIDATION=PASS' : 'POST_VALIDATION=FAIL');
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.error('POST_VALIDATION_ERROR', e?.message ?? e);
  process.exit(1);
} finally {
  c.release();
  await pool.end();
}
