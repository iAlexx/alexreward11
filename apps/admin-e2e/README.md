# Phase 13 Admin browser E2E (Playwright)

Production-quality browser E2E for Phase 13 Owner Admin surfaces. These tests drive a real
Chromium session against a real API and Admin build, backed by an **isolated** Postgres database.

## Isolation

- Database name must be approved for destructive tests (`alex_rewards_phase13_e2e` by default).
- Default local URL (docker postgres on host port **55432**):

  `postgresql://alex_rewards:local-alex-rewards-only@127.0.0.1:55432/alex_rewards_phase13_e2e`

- Never point `PHASE13_DATABASE_URL` / `PHASE13_ADMIN_E2E_DATABASE_URL` at operational
  `alex_rewards` / production data.
- Requires `PHASE13_ADMIN_E2E=1`.
- Ports: Admin **3031**, API **3032** (avoids Phase 12 3010/3012 and default 3001/3002).

## Auth fixture

1. Global setup migrates the isolated DB and enrolls an Owner admin with password+TOTP via
   `@alex-rewards/auth` helpers (`beginOwnerAdminTotpEnrollment` /
   `completeOwnerAdminTotpEnrollment`).
2. Public seed meta (email, adminUserId, ports) is written for Playwright workers.
3. Password + TOTP secret bytes are written only to an OS temp secrets file — never session
   tokens, and never planted into sessionStorage.

Cookie-only Admin auth: login JSON must omit `sessionToken`; HttpOnly `admin_session` cookie
authenticates. `DEPLOYMENT_ENV=test` omits the Secure flag so local HTTP E2E works without
weakening production cookie policy.

WebAuthn uses Chromium's virtual authenticator (CDP). RP ID / origin are the local/test
fixtures (`localhost` + Admin base URL).

## Run

```bash
# Ensure isolated DB exists, Redis is up, then:
export PHASE13_ADMIN_E2E=1
export PHASE13_DATABASE_URL='postgresql://alex_rewards:local-alex-rewards-only@127.0.0.1:55432/alex_rewards_phase13_e2e'
pnpm test:phase13:admin-e2e
```

Root script builds API + Admin dependency graphs, installs Chromium once, then runs Playwright.

## Local Docker ports

If host Redis is published on 56379 (see LOCAL_DEVELOPMENT.md), set:
`PHASE13_ADMIN_E2E_REDIS_URL=redis://127.0.0.1:56379/13`
