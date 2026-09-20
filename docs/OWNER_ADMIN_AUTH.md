# Owner admin authentication (password + TOTP + admin_sessions)

Interim **Owner-operated** authentication issuer for Phase 10 Recovery.
See ADR-019, `docs/OWNER_ADMIN_BOOTSTRAP_DESIGN.md`, and
`docs/OWNER_ADMIN_DB_IDENTITY_DESIGN.md`.

## Hard rules

- Secrets: interactive TTY only (stdin **and** stdout/stderr must be TTYs).
- Never pass password / TOTP / session token via argv, env, files, clipboard automation, or logs.
- `--expected-database <name>` is **required** and must match live `current_database()`.
- Prefer `OWNER_ADMIN_AUTH_DATABASE_URL` over ambient `DATABASE_URL`.
- **Operational default-deny:** all Owner-auth entry points refuse `alex_rewards`
  until an Owner-held endpoint trust ceremony is approved and implemented.
  Cluster `system_identifier` and confirmation literals are **not** operational approval.
- Operational first enrollment remains unconditionally refused (bootstrap not implemented).
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

- Operational first enrollment **BLOCKED** until bootstrap design is approved and implemented.
- Mixed ACTIVE WEBAUTHN + PASSWORD/TOTP: replacement refused until WebAuthn verification exists.
- Local TOTP seal is password-bound, not KMS.
- Terminal screen recording remains a residual channel even with TTY checks.
- Operational cluster identity requires Owner custody of `system_identifier` out-of-band.
