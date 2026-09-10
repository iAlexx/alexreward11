/**
 * Apply TR-aligned primary contact phone for Phase 9 AWS activation.
 * Usage: OWNER_TR_PHONE=+90XXXXXXXXXX node scripts/fix-aws-contact-phone.mjs
 * Never prints the phone number.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hydrateAwsLoginEnvFromCli } from './aws-login-env.mjs';

const phone = String(process.env.OWNER_TR_PHONE || '').trim();
if (!/^\+90\d{10}$/.test(phone)) {
  console.error(
    'Set OWNER_TR_PHONE to E.164 Turkish mobile, e.g. +905xxxxxxxxx (10 digits after +90).',
  );
  process.exit(2);
}

hydrateAwsLoginEnvFromCli();
const aws =
  process.platform === 'win32' ? 'C:\\\\Program Files\\\\Amazon\\\\AWSCLIV2\\\\aws.exe' : 'aws';

const get = spawnSync(aws, ['account', 'get-contact-information', '--output', 'json'], {
  encoding: 'utf8',
  env: process.env,
});
if (get.status !== 0) {
  console.error(get.stderr || get.stdout || 'get-contact-information failed');
  process.exit(get.status ?? 1);
}
const info = JSON.parse(get.stdout);
const c = info.ContactInformation || {};
const next = {
  FullName: c.FullName,
  AddressLine1: c.AddressLine1,
  ...(c.AddressLine2 ? { AddressLine2: c.AddressLine2 } : {}),
  City: c.City || c.CityName,
  StateOrRegion: c.StateOrRegion,
  PostalCode: c.PostalCode,
  CountryCode: 'TR',
  PhoneNumber: phone,
  ...(c.CompanyName ? { CompanyName: c.CompanyName } : {}),
};
const path = join(tmpdir(), `aws-contact-${process.pid}.json`);
writeFileSync(path, JSON.stringify({ ContactInformation: next }), 'utf8');
const fileUri = `file://${path.replace(/\\/g, '/')}`;
try {
  const put = spawnSync(aws, ['account', 'put-contact-information', '--cli-input-json', fileUri], {
    encoding: 'utf8',
    env: process.env,
  });
  process.stdout.write(put.stdout || '');
  process.stderr.write(put.stderr || '');
  if (put.status !== 0) process.exit(put.status ?? 1);
  console.log('contact_phone_updated=1 country=TR');
  const up = spawnSync(aws, ['freetier', 'upgrade-account-plan', '--account-plan-type', 'FREE'], {
    encoding: 'utf8',
    env: process.env,
  });
  process.stdout.write(up.stdout || '');
  process.stderr.write(up.stderr || '');
  console.log(`upgrade_rc=${up.status}`);
} finally {
  try {
    unlinkSync(path);
  } catch {}
}
