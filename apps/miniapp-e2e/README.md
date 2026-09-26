# Phase 12 Mini App browser E2E (Playwright)

Production-quality browser E2E for Phase 12 surfaces. These tests drive a real Chromium
session against a real API and Mini App build, backed by an **isolated** Postgres database.

## Not E2E

Vitest suites under `apps/miniapp/test` (including `phase12-authority-scenarios.test.ts`) are
**unit / contract / source-boundary** checks. Do not call them browser E2E.

## Isolation

- Database name must be approved for destructive tests (`alex_rewards_phase12_e2e` by default).
- Default local URL (docker postgres on host port **55432**):

  `postgresql://alex_rewards:local-alex-rewards-only@127.0.0.1:55432/alex_rewards_phase12_e2e`

- Never point `PHASE12_DATABASE_URL` at operational `alex_rewards` / production data.
- Requires `PHASE12_E2E=1`.

## Auth fixture

1. Build signed Telegram Mini App `initData` with `buildSignedInitDataForTests` (same Phase 3 HMAC helper).
2. Install it via Playwright `addInitScript`, intercepting `window.Telegram` so the official
   `telegram-web-app.js` cannot wipe `initData`.
3. Also call real `POST /v1/auth/telegram` and plant the returned session in `sessionStorage`
   before first paint (AuthProvider prefers an existing session).

No production security bypass. Claim codes are written only to an OS temp secrets file and are never logged.

## Run

```bash
# Ensure isolated DB exists, Redis is up, then:
export PHASE12_E2E=1
export PHASE12_DATABASE_URL='postgresql://alex_rewards:local-alex-rewards-only@127.0.0.1:55432/alex_rewards_phase12_e2e'
pnpm test:phase12:e2e
```

Root script builds API + Mini App dependency graphs, installs Chromium once, then runs Playwright.
