import pg from 'pg';
const url = process.env.PHASE20_STAGING_PREFLIGHT_DATABASE_URL ?? '';
if (!url) {
  console.error('missing url');
  process.exit(1);
}
const pool = new pg.Pool({
  connectionString: url,
  application_name: 'phase20-pre-activation-ro',
  options: '-c default_transaction_read_only=on',
  max: 1,
});
const c = await pool.connect();
try {
  await c.query('BEGIN READ ONLY');
  const one = async (sql) => (await c.query(sql)).rows[0];
  const many = async (sql) => (await c.query(sql)).rows;
  const risk = await one(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE status='ACTIVE')::int AS active FROM risk_rule_versions`,
  );
  const trust = await one(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE status='ACTIVE')::int AS active FROM trust_rule_versions`,
  );
  const elig = await one(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE status='ACTIVE')::int AS active FROM eligibility_policy_versions`,
  );
  const wrp = await many(
    `SELECT enabled FROM feature_flags WHERE flag_key='WITHDRAWAL_REQUESTS_PAUSE' AND environment='STAGING'`,
  );
  const payout = await one(
    `SELECT enabled FROM feature_flags WHERE flag_key='PAYOUT_DISPATCH_PAUSE' AND environment='STAGING'`,
  );
  const referral = await one(
    `SELECT enabled FROM feature_flags WHERE flag_key='REFERRAL_REWARD_PAUSE' AND environment='STAGING'`,
  );
  const ads = await one(
    `SELECT lifecycle_state::text, production_monetary_status::text FROM ad_providers WHERE code='ADSGRAM'`,
  );
  console.log(
    JSON.stringify({ risk, trust, elig, wrp: wrp[0] ?? 'MISSING', payout, referral, ads }, null, 2),
  );
  const ok =
    risk.total === 0 &&
    risk.active === 0 &&
    trust.total === 0 &&
    trust.active === 0 &&
    elig.total === 0 &&
    elig.active === 0 &&
    wrp.length === 0 &&
    payout?.enabled === true &&
    referral?.enabled === true &&
    ads?.lifecycle_state === 'SANDBOX' &&
    ads?.production_monetary_status === 'BLOCKED';
  console.log(ok ? 'PRE_ACTIVATION_STATE=OK' : 'PRE_ACTIVATION_STATE=BLOCKED');
  await c.query('ROLLBACK');
  process.exit(ok ? 0 : 1);
} finally {
  c.release();
  await pool.end();
}
