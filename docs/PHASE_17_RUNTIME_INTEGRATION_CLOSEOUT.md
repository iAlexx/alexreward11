# Phase 17 Runtime Integration Closeout

**Status:** CLOSEOUT CANDIDATE (not archived; not Phase 18)  
**Branch:** `staging-runtime-validation`  
**Phase 17 implementation candidate:** `25627ee16fb76ddd25d3a09f63a2c0c8b3f5a487`  
**Runtime-integration HEAD reviewed:** `bea319ae389a458d87b4f874e4468b1b087d5e9f`  
**Date:** 2026-09-30

This document separates (A) the Phase 17 Public Payout Logs feature implementation from
(B) post-implementation staging runtime/integration remediations carried on
`staging-runtime-validation`. Remediations are product runtime fixes. They did **not** alter
Phase 17 payout semantics, ledger authority, withdrawal financial state machines, signer
behavior, or referral monetary rules.

---

## A) Phase 17 feature implementation — Public Payout Logs

Authoritative implementation landed at `25627ee` (and its Phase 17 ancestor commits on the
payout-logs line). Scope:

- Confirmed-only publication source (`withdrawal.confirmed` outbox after settled/confirmed
  withdrawal authority).
- Worker creates `payout_publications` work only; Worker does **not** send Telegram messages.
- Bot owns Telegram transport (public payout delivery poller + sender).
- Publication uniqueness/idempotency (`ON CONFLICT (withdrawal_id, destination_id)`).
- Privacy preference snapshotted at publication create; settings downgrade path freezes
  identity toward `HIDE_IDENTITY` under shared `users` lock contract.
- Founder/member status is **not** a privacy bypass.
- Ambiguous Telegram send outcomes finalize `AMBIGUOUS` and are **not** blindly resent
  (`AMBIGUOUS` must not auto-return to `SENDING`).
- Feature flag `PUBLIC_PAYOUT_LOGS_ENABLED` + destination purpose checks remain fail-closed;
  non-MAINNET / Testnet publication remains blocked unless Owner policy later authorizes it.
- No production publication destination seeds; no historical backfill.

These payout surfaces are **byte-identical** between `25627ee` and `bea319a` for:

- `packages/withdrawals/**` (public-payout builder/delivery/outbox/feature)
- `apps/bot/src/public-payout-poller.ts`
- `apps/bot/src/public-payout-telegram-sender.ts`
- `apps/bot/test/public-payout-delivery.test.ts`
- `packages/auth/**` (referral attribution still `created === true` only)
- Control Center gate: `apps/bot/src/telegram-control-center-gate.ts`

---

## B) Post-implementation staging integration remediations

Diff reviewed: `25627ee..bea319a` (4 commits, 17 files). Classification:

| Commit | Purpose | Class |
|--------|---------|-------|
| `c5c9872` | Expose `/tonconnect-manifest.json` from Mini App | Runtime / Mini App transport |
| `c1399a6` | Plain `/start` replies with LOOTRA welcome + launch path | Bot UX / transport |
| `bf31a0f` | Native `web_app` button; `MINIAPP_PUBLIC_URL`; API referral deep link uses `?startapp=` | Bot UX + config + referral **transport** URL only |
| `bea319a` | Telegram account-context mismatch forces server reauth | Mini App auth session hygiene |

### Changed files (full list)

**Mini App / TonConnect**

- `apps/miniapp/src/app/tonconnect-manifest.json/route.ts`
- `apps/miniapp/src/lib/tonconnect-manifest.ts`
- `apps/miniapp/test/tonconnect-manifest.test.ts`

**Bot /start transport**

- `apps/bot/src/main.ts` (`/start` only; Control Center + payout poller wiring unchanged in behavior)
- `apps/bot/src/referral-start.ts`
- `apps/bot/test/referral-start.test.ts`

**Config**

- `packages/config/src/index.ts` (`MINIAPP_PUBLIC_URL` optional, HTTPS outside local/test, rejects `t.me`)
- `packages/config/test/config.test.ts`

**Referral deep-link transport (user-facing URL shape only)**

- `apps/api/src/referrals/referrals.controller.ts` (`buildReferralMiniAppLaunchLink` → `?startapp=ref_<code>`)
- `apps/api/test/phase15-referral-deeplink.test.ts`
- `packages/referrals/src/telegram-links.ts` (`buildMainMiniAppLaunchLink`)
- `packages/referrals/src/index.ts`
- `packages/referrals/test/phase15-telegram-transport.unit.test.ts`

**Auth session account context**

- `apps/miniapp/src/lib/auth/telegram-user-id-hint.ts` (UNTRUSTED hint only)
- `apps/miniapp/src/lib/auth/boot-decision.ts`
- `apps/miniapp/src/providers/AuthProvider.tsx`
- `apps/miniapp/test/auth-account-context.test.ts`

### Explicit non-changes (verified by empty diff `25627ee..bea319a`)

- No Ledger mutation logic
- No withdrawal financial state machine
- No signer / KMS / Temporal payout workflow changes
- No public-payout publication authority / privacy / confirmed-only / AMBIGUOUS semantics changes
- No Mainnet configuration / networkGlobalId changes
- No production seeds / migrations in this remediation range
- No referral reward/economic calculation changes
- No move of referral attribution authority to client or Bot

---

## Staging runtime observations (already validated operationally)

- Telegram bot polling works (`BOT_TRANSPORT_MODE=polling`).
- Plain `/start` responds with welcome + native Mini App `web_app` button when
  `MINIAPP_PUBLIC_URL` is configured.
- Direct `?startapp` / `?startapp=ref_<code>` Mini App entry works.
- Brand-new invited Telegram account created a PENDING referral edge; referrer
  `invitedCount = 1`.
- Existing LOOTRA accounts do **not** receive late referral attribution (`created === true` only).
- Staging referral activation policy exists operationally (account age, rewarded ads, fraud gate).
- `REFERRAL_REWARD_PAUSE` enabled in STAGING (no monetary referral rewards paid).
- Mainnet remains OFF; TON Keeper/Testnet account-network mismatch is **deferred** and was
  not modified by these remediations.

---

## Phase 17 invariant regression (current HEAD)

1. Public payout source remains authoritative confirmed withdrawal/outbox state.
2. Worker creates publication work only; does not send Telegram.
3. Bot remains Telegram transport owner for public payout delivery.
4. No public payout send before confirmed/settled proof.
5. Publication uniqueness/idempotency remains enforced.
6. Privacy preference is applied at publication create; settings downgrade anti-TOCTOU contract
   remains; Founder/member does not override payout-public privacy.
7. Ambiguous Telegram send is fail-closed (`AMBIGUOUS`, no blind resend).
8. Production/Testnet destination and feature checks remain fail-closed.
9. Public payout feature remains disabled unless DB feature flag + destination are explicitly
   configured.

---

## Bot / auth / referral regression (current HEAD)

- `BOT_TRANSPORT_MODE=polling` and Control Center owner allowlist gate unchanged.
- Plain `/start` → native `web_app` + `style: primary` using `MINIAPP_PUBLIC_URL` (fail-closed if unset/unsafe).
- Valid `/start ref_<code>` → `?startapp=ref_<code>` URL button (transport only; no Bot attribution).
- Malformed referral payloads → `IGNORE` (not forwarded).
- Raw Telegram `initData` remains server HMAC authority (`POST /v1/auth/telegram`).
- Client Telegram user-id hint is UNTRUSTED reauthentication context only.
- Account-context mismatch clears stored session + query cache and forces server reauth.
- Self-referral remains blocked; attribution remains one-time / created-only; no client-created
  referral edges; no client monetary authority.

---

## Deferred items (explicitly NOT solved by this closeout)

1. **TON Keeper / Testnet account-network compatibility validation** — deferred; do not change
   wallet/network configuration in closeout.
2. **Mainnet** — remains OFF.
3. **Public payout production destination** — remains unconfigured/disabled unless Owner
   explicitly configures feature flag + destination.
4. **Historical payout backfill** — Owner policy decision; not implemented.
5. **Multiple payout mirrors/destinations** — Owner policy decision; not implemented.
6. **Testnet public payout publication** — Owner policy decision; code remains fail-closed for
   non-MAINNET in STAGING/PRODUCTION publication paths.
7. **Ambiguous Telegram delivery manual reconciliation / operations runbook** — unresolved;
   `docs/OPERATIONS_RUNBOOK.md` does not yet document Phase 17 AMBIGUOUS publication handling.

---

## Gate evidence (run at `bea319a` before this document commit)

| Gate | Result |
|------|--------|
| `@alex-rewards/bot` test / typecheck / build | PASS (18 tests) |
| `@alex-rewards/miniapp` test / typecheck / build | PASS (151 tests) |
| `@alex-rewards/api` test / typecheck / build | PASS (97 tests) |
| `@alex-rewards/referrals` test | PASS (64 tests) |
| `@alex-rewards/auth` test | PASS (90 tests) |
| `pnpm test:phase17` (withdrawals phase17 + api privacy + worker + bot) | PASS (66 + 5 + 16 + 18) |
| `pnpm verify:boundaries` | PASS |
| `pnpm security:secrets` | PASS |

---

## Closeout statement

Carrying `c5c9872`, `c1399a6`, `bf31a0f`, and `bea319a` forward with Phase 17 does **not**
change Phase 17 authoritative payout semantics or financial boundaries. They are required
staging/runtime integration fixes for TonConnect manifest exposure, Telegram entry UX, Mini App
startapp referral transport URLs, and Telegram account-context session safety.

**Not archived.** **Phase 18 not started.**

### Deployment accuracy (docs commit `c67d5bc`)

- **No manual deployment** was performed as part of the closeout documentation task
  (Cursor did not trigger Railway deploy, and no operator deploy command was run).
- Pushing `c67d5bc5180f1597e089fd74dff56eb5537d3001` to `staging-runtime-validation`
  triggered the **normal Railway auto-deploy** for the branch-connected
  **miniapp-staging** service only.
- That auto-deploy completed **SUCCESS**:
  - Railway Deployment ID: `6703476f-b40f-46c4-8874-1cf12f0da949`
  - Service: `miniapp-staging`
  - Commit: `c67d5bc5180f1597e089fd74dff56eb5537d3001`
- This docs commit did **not** trigger an API / Bot / Worker Phase 17 financial or
  public-payout deployment.
- **No Mainnet deployment** occurred.
