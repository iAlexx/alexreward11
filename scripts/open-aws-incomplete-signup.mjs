/**
 * Open AWS incomplete-signup / payment console via root AK + GetFederationToken.
 * Reads credentials from %TEMP%/phase9-root-ak.env (created during Phase 9 unblock).
 * Never prints secrets.
 *
 * Opens a short localhost redirect (:8766/aws) so Edge/IDE avoid HTTP 400 on long
 * federation URLs. Destination: incomplete signup / paymentmethods.
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const envPath = join(tmpdir(), 'phase9-root-ak.env');
if (!existsSync(envPath)) {
  console.error('Missing phase9-root-ak.env in temp. Create a root access key once, then retry.');
  process.exit(2);
}
for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = /^(AWS_[A-Z_]+)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2];
}
delete process.env.AWS_SESSION_TOKEN;

const aws = process.platform === 'win32' ? 'C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe' : 'aws';

const policy = {
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Action: [
        'aws-portal:*',
        'billing:*',
        'payments:*',
        'account:*',
        'freetier:*',
        'support:*',
        'kms:*',
      ],
      Resource: '*',
    },
  ],
};
const policyPath = join(tmpdir(), `phase9-fed-policy-${process.pid}.json`);
writeFileSync(policyPath, JSON.stringify(policy));

const fed = spawnSync(
  aws,
  [
    'sts',
    'get-federation-token',
    '--name',
    'phase9console',
    '--policy',
    `file://${policyPath.replace(/\\/g, '/')}`,
    '--duration-seconds',
    '3600',
    '--output',
    'json',
  ],
  { encoding: 'utf8', env: process.env },
);
if (fed.status !== 0) {
  console.error(fed.stderr || fed.stdout || 'get-federation-token failed');
  process.exit(fed.status ?? 1);
}
const fc = JSON.parse(fed.stdout).Credentials;
const session = encodeURIComponent(
  JSON.stringify({
    sessionId: fc.AccessKeyId,
    sessionKey: fc.SecretAccessKey,
    sessionToken: fc.SessionToken,
  }),
);
const tokenRes = await fetch(
  `https://signin.aws.amazon.com/federation?Action=getSigninToken&SessionType=json&Session=${session}`,
);
const { SigninToken } = await tokenRes.json();
// Prefer console billing destination — verified HTTP 302 and works in Edge/IDE
// short-redirect flow. Direct incomplete-signup Destination often returns 400.
const dest = encodeURIComponent(
  'https://console.aws.amazon.com/billing/home#/paymentmethods',
)
const url =
  'https://signin.aws.amazon.com/federation?Action=login&Issuer=alex-rewards-phase9' +
  `&Destination=${dest}&SigninToken=${encodeURIComponent(SigninToken)}`;

writeFileSync(join(tmpdir(), 'aws-fed-sts-incomplete.txt'), url, 'utf8');
writeFileSync(
  join(tmpdir(), 'aws-fed-sts-incomplete.url'),
  `[InternetShortcut]\r\nURL=${url}\r\n`,
  'utf8',
);
const htmlPath = join(tmpdir(), 'aws-fed-sts-incomplete.html');
writeFileSync(
  htmlPath,
  `<!doctype html><meta charset="utf-8"><title>AWS incomplete signup</title>` +
    `<p>Opening payment setup…</p><script>location.replace(${JSON.stringify(url)})</script>` +
    `<p><a href="${url.replace(/&/g, '&amp;')}">Continue</a></p>\n`,
  'utf8',
);

const redirectScript = join(tmpdir(), 'phase9-fed-redirect.mjs');
if (!existsSync(redirectScript)) {
  writeFileSync(
    redirectScript,
    [
      'import { createServer } from "node:http";',
      'import { readFileSync, existsSync } from "node:fs";',
      'import { join } from "node:path";',
      'import { tmpdir } from "node:os";',
      'function load() {',
      '  const p = join(tmpdir(), "aws-fed-sts-incomplete.html");',
      '  if (!existsSync(p)) throw new Error("missing html");',
      '  const html = readFileSync(p, "utf8");',
      '  const m = html.match(/location\\.replace\\((\\"[^\\"]+\\")\\)/);',
      '  if (!m) throw new Error("no url");',
      '  return JSON.parse(m[1]);',
      '}',
      'createServer((req, res) => {',
      '  if (req.url && req.url.startsWith("/aws")) {',
      '    try {',
      '      res.writeHead(302, { Location: load(), "Cache-Control": "no-store" });',
      '      res.end();',
      '    } catch (e) {',
      '      res.writeHead(500, { "Content-Type": "text/plain" });',
      '      res.end(String(e));',
      '    }',
      '    return;',
      '  }',
      '  res.writeHead(200, { "Content-Type": "text/plain" });',
      '  res.end("phase9 federation redirect: GET /aws\\n");',
      '}).listen(8766, "127.0.0.1");',
      '',
    ].join('\n'),
    'utf8',
  );
}

async function redirectUp() {
  try {
    const r = await fetch('http://127.0.0.1:8766/', { redirect: 'manual' });
    return r.status === 200 || r.status === 302;
  } catch {
    return false;
  }
}
if (!(await redirectUp())) {
  const child = spawn(process.execPath, [redirectScript], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await redirectUp()) break;
  }
}

const shortUrl = 'http://127.0.0.1:8766/aws';
const openTarget = (await redirectUp()) ? shortUrl : htmlPath;

if (process.platform === 'win32') {
  const edgeCandidates = [
    join(
      process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
      'Microsoft',
      'Edge',
      'Application',
      'msedge.exe',
    ),
    join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  let launched = false;
  for (const edge of edgeCandidates) {
    if (!existsSync(edge)) continue;
    const child = spawn(edge, ['--new-window', openTarget], {
      shell: false,
      windowsHide: false,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    launched = true;
    break;
  }
  if (!launched) {
    spawnSync('cmd', ['/c', 'start', '', openTarget], {
      shell: false,
      windowsHide: true,
      timeout: 5000,
    });
  }
} else {
  spawnSync('xdg-open', [openTarget], { shell: false, timeout: 5000 });
}

console.log('opened_incomplete_signup=1');
console.log(`open_target=${openTarget}`);
console.log(
  'Add Visa/Mastercard/Amex (+ MFA). Prefer OWNER_TR_PHONE=+90… or %TEMP%\\phase9-owner-tr-phone.txt',
);
console.log('Then: aws account get-account-information');
