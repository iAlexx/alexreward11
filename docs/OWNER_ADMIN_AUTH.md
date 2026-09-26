# Owner admin authentication (password + TOTP + admin_sessions)

Interim **Owner-operated** authentication issuer for Phase 10 Recovery.
See ADR-019, ADR-021, ADR-022 (isolated Telegram first-Owner bootstrap),
`docs/OWNER_ADMIN_BOOTSTRAP_DESIGN.md` (M1-A.1 Option C design — retained for ops),
`docs/OWNER_ADMIN_DB_IDENTITY_DESIGN.md`, and
`docs/M1_A1_TRUST_ESTABLISHMENT_CHECKLIST.md`.

## Phase 10 isolated first-Owner (practical path)

For **isolated Testnet only** (`alex_rewards_isolated_payout_test` @ `127.0.0.1:55440`),
first-Owner creation uses:

1. Explicitly configured Owner Telegram user id (`ISOLATED_OWNER_BOOTSTRAP_TELEGRAM_USER_ID`)
2. Verified Telegram Mini App `initData` (HMAC with bot token)
3. Password + TOTP (same factors as Owner admin auth)

Telegram **username is display-only** and never grants permissions.
Independent witnesses and paper Channel B are **not** required on this path.
Option C ceremony tooling remains in-repo for historical/ops design work and is
**not** the Phase 10 isolated activation path.

```powershell
pnpm --filter @alex-rewards/auth run build
# Load URL from local config file (preferred — avoids shell-history passwords):
$env:OWNER_ISOLATED_BOOTSTRAP_DATABASE_URL_FILE = "$env:USERPROFILE\ALExRewards\isolated-payout-testnet\config\database.url"
$env:ISOLATED_OWNER_BOOTSTRAP_TELEGRAM_USER_ID = '<your Telegram numeric id>'
$env:TELEGRAM_BOT_TOKEN = '<bot token>'  # set ephemerally; do not commit
pnpm --filter @alex-rewards/auth run owner-isolated-telegram-bootstrap -- preflight `
  --expected-database alex_rewards_isolated_payout_test
# enroll is Owner-interactive (TTY initData + password) — run only when authorized
```

### Mini App initData (isolated enroll)

Deploy `apps/miniapp` over HTTPS and set BotFather Web App URL to that host.
For isolated Telegram bootstrap, paste genuine Mini App `initData` only into the local
enroll TTY (never into chat, logs, or files). The temporary Mini App copy helper has been
removed after enrollment; do not re-enable it.

**Isolated status (2026-09-23):** Owner on `alex_rewards_isolated_payout_test` is enrolled;
TOTP was rotated after exposure; NEW login PASS / OLD reject PASS. Do not re-enroll.
Use `enroll --replace` only for future authenticated factor rotation.
Disable the flag and redeploy immediately after enrollment. Displayed Telegram
user fields are untrusted until the CLI validates initData.

## Hard rules

- Secrets: interactive TTY only (stdin **and** stdout/stderr must be TTYs).
- Never pass password / TOTP / session token via argv, env, files, clipboard automation, or logs.
- `--expected-database <name>` is **required** and must match live `current_database()`.
- Prefer `OWNER_ADMIN_AUTH_DATABASE_URL` over ambient `DATABASE_URL`.
- **Operational default-deny:** all Owner-auth entry points refuse `alex_rewards`
  until an Owner-held endpoint trust ceremony is approved and implemented.
  Cluster `system_identifier` and confirmation literals are **not** operational approval.
- Operational first enrollment remains refused. M1-A.1 status:
  `DESIGN READY — TRUST ESTABLISHMENT BLOCKED`
  (Option C + endpoint trust + redemption PoP designed; production trust anchor
  not independently established — Checklist **B** / **D**).
  Challenge lifecycle with enrollment-channel binding and FinalCredReq (P1)
  and TLS chain+hostname+Owner CA (P2) are specified in design docs.
  **Local Stage B** was Owner-authorized and implemented for isolated test DBs
  with ephemeral test-only keys (checklist §C; ADR-021 Stage B clarification).
  That does **not** establish Checklist **B** or authorize **D**.
  Ceremony schema validators (G1/G2/G8) are structural only — **not** authentic
  Owner provenance.
- JSON stdout never contains TOTP seeds, otpauth URIs, passwords, OTPs, or session tokens.
- Session tokens are returned only via `takeSessionTokenOnce()` for interactive stderr display.
- ACTIVE unsupported credentials (e.g. WEBAUTHN) **block enrollment/replacement**
  (fail-closed interim policy). WebAuthn is never removed or simulated.
- Failed authentications are durably counted under per-Owner serialization before the
  failure is returned (lockout is enforced).
- Lock hierarchy: Owner → throttle → credentials → sessions. Reauth checks factors under
  credential locks, then locks the session and revalidates **before** consuming TOTP.
- CLI enroll: read-only preflight (no INSERT/FOR UPDATE) → interactive secrets → final TX.
- Windows Terminal interactive smoke: **NOT TESTED** in automated closure (document only).

## Build

```bash
pnpm --filter @alex-rewards/auth run build
```

## Enrollment (isolated test DB only)

First enrollment works **only** against approved isolated `*_test` / `*_phaseN`
databases. Do **not** attempt operational first enrollment — it is refused in code.

```powershell
pnpm --filter @alex-rewards/auth run owner-admin-auth -- enroll `
  --expected-database alex_rewards_test `
  --admin-user-id <OWNER_ADMIN_UUID>
```

Provisioning material is shown once on interactive stderr. Terminal recordings remain sensitive.

## Login / reauth / logout

```powershell
pnpm --filter @alex-rewards/auth run owner-admin-auth -- login `
  --expected-database alex_rewards_test `
  --admin-user-id <OWNER_ADMIN_UUID>
# SESSION_TOKEN shown once on interactive stderr — paste into Recovery TTY
```

## Isolated tests

```powershell
$env:OWNER_ADMIN_AUTH_DATABASE_URL = 'postgresql://…@127.0.0.1:55432/alex_rewards_test'
pnpm --filter @alex-rewards/auth run test:owner-admin-auth
```

## Migration

`0024_owner_admin_auth_hardening.sql` adds `totp_last_accepted_step` and
`admin_auth_throttle`. Apply to isolated test DBs for local remediation only.
**Operational application of 0024 requires separate Owner migration approval** and
is not authorized by this document.

## Manual Windows Terminal smoke test (isolated; no real Owner credentials)

1. Open Windows Terminal (interactive TTY; do not redirect stdout/stderr).
2. Point `OWNER_ADMIN_AUTH_DATABASE_URL` at an approved isolated test database only.
3. Build auth; run `enroll` / `login` / `reauth` / `logout` with a **test** Owner UUID.
4. Confirm: secrets appear only on stderr once; JSON stdout has no secrets; redirected
   stdout/stderr is refused.
5. Do **not** use real Owner credentials, operational `alex_rewards`, or Recovery CLI.

## Security limitations

- Operational first enrollment **BLOCKED**. Design label:
  `DESIGN READY — TRUST ESTABLISHMENT BLOCKED`
  (F1 redemption PoP, F2 JCS/hard exp, F3 seal root, P1 challenge/ticket/channel
  binding + FinalCredReq + final TX, P2 mandatory TLS chain+hostname+Owner CA
  with optional SPKI add-on only documented; trust anchor not established —
  Checklist **B**; ops enrollment — Checklist **D**).
  Local Stage B isolated implementation exists (checklist §C); ephemeral
  test-only keys ≠ Checklist B/D complete. Structural seal/profile/derivative
  validation ≠ authentic Owner provenance.
- Mixed ACTIVE WEBAUTHN + PASSWORD/TOTP: replacement refused until WebAuthn verification exists.
- Local TOTP seal is password-bound, not KMS.
- Terminal screen recording remains a residual channel even with TTY checks.
- Operational cluster identity requires Owner custody of `system_identifier` out-of-band.
