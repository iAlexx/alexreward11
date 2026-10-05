# LOOTRA Mini App — Screen ↔ Existing Server API Mapping

**Branch:** `lootra-miniapp-ui-integration`  
**Baseline:** `staging-integration` @ `c85723c174241cb831f5e4113ce4449ec1967303`  
**Document type:** audit / mapping only — **no runtime UI implementation in this commit**  
**Authority rule:** every visible value must come from server truth, an approved external SDK, or honest local presentation. **Do not invent data because Figma shows it.**

Cross-checked against:

- `apps/miniapp/src/lib/api/client.ts`
- `apps/miniapp/src/lib/query/keys.ts`
- `apps/miniapp/src/components/*`, `apps/miniapp/src/ads/*`, `apps/miniapp/src/providers/*`
- `apps/api/src/**/*.controller.ts` (user surface)
- `packages/contracts/src/{home,earn,tasks,referrals,settings,wallets,support,balances}.ts`

---

## Authority categories

| Code | Meaning |
| --- | --- |
| `EXISTING_SERVER_ENDPOINT` | HTTP route exists and is the source of truth |
| `DERIVED_FROM_EXISTING_SERVER_DATA` | UI state computed from an existing response (no new invent) |
| `PRESENTATION_ONLY_LOCAL` | Visual / motion / onboarding preference only |
| `EXTERNAL_TON_CONNECT` | TonConnect SDK / wallet extension UI |
| `EXTERNAL_TELEGRAM_UI` | Telegram WebApp chrome / initData |
| `BACKEND_NOT_PRESENT` | No user API; cannot be shown as live data |
| `ENGINE_NOT_ENABLED` | Route exists but returns `UNAVAILABLE` / `ENGINE_NOT_ENABLED` |
| `DESIGN_ONLY_REFERENCE` | Figma reference only; not product truth |

## Implementation status values

| Status | Meaning |
| --- | --- |
| `READY_EXISTING` | Server + (usually) client wrapper ready |
| `CLIENT_WRAPPER_MISSING` | Server exists; Mini App `createApiClient` lacks a typed wrapper |
| `DERIVED_FROM_SERVER_DATA` | Safe client derivation |
| `PRESENTATION_ONLY` | Local UI / assets |
| `EXTERNAL_SDK` | TonConnect / AdsGram / Telegram |
| `ENGINE_NOT_ENABLED` | Honest unavailable until engine phase |
| `BACKEND_NOT_PRESENT` | No user endpoint |
| `BLOCKED_BY_POLICY` | Policy gate (e.g. AdsGram monetary BLOCKED) |

---

## Master mapping table

| LOOTRA SCREEN / COMPONENT | USER ACTION / STATE | SERVER SOURCE | HTTP ENDPOINT | CLIENT METHOD | QUERY KEY | AUTHORITY | IMPLEMENTATION STATUS | NOTES / LIMITATION |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Splash | Load brand / 3D | — | — | — | — | PRESENTATION_ONLY_LOCAL | PRESENTATION_ONLY | Never balances / membership / rewards |
| Onboarding | Swipes / complete | — | — | — | local preference only | PRESENTATION_ONLY_LOCAL | PRESENTATION_ONLY | No server onboarding field today — do not add one in UI task alone |
| Telegram session bootstrap | Open Mini App | Auth | `POST /v1/auth/telegram` | `authTelegram` | session store | EXISTING_SERVER_ENDPOINT + EXTERNAL_TELEGRAM_UI | READY_EXISTING | initData only; never Telegram unsafe user |
| Session refresh | Token near expiry | Auth | `POST /v1/auth/refresh` | `refresh` | session store | EXISTING_SERVER_ENDPOINT | READY_EXISTING | |
| Sign out | Logout | Auth | `POST /v1/auth/logout` | `logout` | clear session | EXISTING_SERVER_ENDPOINT | READY_EXISTING | |
| Home shell | Open Home | Home aggregate | `GET /v1/me/home` | `getHome` | `queryKeys.home` | EXISTING_SERVER_ENDPOINT | READY_EXISTING | Per-domain envelopes; one UNAVAILABLE domain must not blank others |
| Home balances | Available / pending / reserved / lifetime | Home → balances | via home or `GET /v1/me/balances` | `getHome` / `getBalances` | `home` / `balances` | EXISTING_SERVER_ENDPOINT | READY_EXISTING | Atomic strings only |
| Home today ads | Remaining opportunities | Home → todayAds | via `GET /v1/me/home` | `getHome` | `home` | EXISTING_SERVER_ENDPOINT | READY_EXISTING | Includes `monetaryEligible`; AdsGram may still be BLOCKED |
| Home missions | Mission counts card | Home → missions | via home | `getHome` | `home` | ENGINE_NOT_ENABLED | ENGINE_NOT_ENABLED | Controller hard-codes unavailable; **no claimable task IDs** |
| Home referrals | Referral card | Home → referrals | via home | `getHome` | `home` | ENGINE_NOT_ENABLED | ENGINE_NOT_ENABLED | Same as `/v1/referrals/summary` |
| Home latest withdrawal | Pending / processing CTA | Home → latestWithdrawal | via home | `getHome` | `home` | EXISTING_SERVER_ENDPOINT | READY_EXISTING | `id`, `state`, `netAmountAtomic`, `requestedAt` |
| Home announcement | Single banner | Home → announcement | via home (SQL on `notifications`) | `getHome` | `home` | EXISTING_SERVER_ENDPOINT | READY_EXISTING | **One** latest non-SECURITY row — not a notification inbox |
| Home membership brief | Founder / plan chip | Home → membershipBrief | via home | `getHome` | `home` | EXISTING_SERVER_ENDPOINT | READY_EXISTING | Identity only; `securityBypass` never true |
| Smart Action #1 | Wallet verification required | Wallets | `GET /v1/wallets` | `getWallets` | `queryKeys.wallets` | EXISTING_SERVER_ENDPOINT | READY_EXISTING | **Not** in HomeSummary — must also query wallets |
| Smart Action #2 | Claimable task | Home missions | via home | `getHome` | `home` | ENGINE_NOT_ENABLED | ENGINE_NOT_ENABLED | May route to `/tasks` shell only; **no task detail ID** |
| Smart Action #3 | Pending / processing withdrawal | Home latestWithdrawal | via home | `getHome` | `home` | DERIVED_FROM_EXISTING_SERVER_DATA | DERIVED_FROM_SERVER_DATA | Route to withdrawal detail when client wrapper added |
| Smart Action #4 | Earning opportunity | todayAds / earn-summary | home and/or earn | `getHome` / `getEarnSummary` | `home` / `earnSummary` | DERIVED_FROM_EXISTING_SERVER_DATA | DERIVED_FROM_SERVER_DATA | Honor `monetaryEligible` + BLOCKED status |
| Smart Action #5 | Hide | — | — | — | — | PRESENTATION_ONLY_LOCAL | PRESENTATION_ONLY | When no higher priority truth |
| Earn screen | Provider cards / limits | Earn summary | `GET /v1/ads/earn-summary?provider=` | `getEarnSummary` | `earnSummary(provider)` | EXISTING_SERVER_ENDPOINT | READY_EXISTING | Map `productionMonetaryStatus`, `monetaryEligible`, `reasonCodes`, `health`, `rewardedUseAllowed`, request/success remaining, `usageBasis`, `blockIdPublic`, authorize locators |
| Earn authorize | Start rewarded session | Ads | `POST /v1/ads/sessions/authorize` | `authorizeAdSession` | — | EXISTING_SERVER_ENDPOINT | READY_EXISTING | Server publishes `authorizeAssetId` / `authorizeBudgetPeriodId` |
| Earn provider SDK | Show ad | AdsGram SDK | — | `AdsGramRewardedBridge` | — | EXTERNAL_TELEGRAM_UI / ads SDK | EXTERNAL_SDK | Not financial truth |
| Earn client evidence | SDK events | Ads | `POST /v1/ads/sessions/:id/client-signal` | **raw `fetch` in bridge** (no typed client method) | — | EXISTING_SERVER_ENDPOINT | CLIENT_WRAPPER_MISSING | Evidence only; never credits |
| Earn attempt-verify | Completion check | Ads | `POST /v1/ads/sessions/:id/attempt-verify` | `attemptVerifyAdSession` | invalidate earn/home/balances | EXISTING_SERVER_ENDPOINT | READY_EXISTING | **No optimistic credit** |
| Reward Drop / confirmation motion | Celebrate reward | attempt-verify result | — | local motion | — | DERIVED_FROM_EXISTING_SERVER_DATA | PRESENTATION_ONLY | Run credit animation **only if** `issued === true`. If `alreadyRewarded === true`: show already-rewarded copy / non-double-credit motion — **never** animate as a new issuance |
| Earn monetary blocked UI | Production earnings unavailable | earn-summary + verify | — | — | — | BLOCKED_BY_POLICY | BLOCKED_BY_POLICY | AdsGram production monetary remains **BLOCKED**; design must not imply live production earnings |
| Tasks list | Browse missions | Tasks | `GET /v1/tasks` | `getTasks` | `queryKeys.tasks` | ENGINE_NOT_ENABLED | ENGINE_NOT_ENABLED | Returns `{ status: UNAVAILABLE, items: [], reasonCode: ENGINE_NOT_ENABLED }` |
| Task claim / verify / Claim Reward | Mutate progress | — | **none** | — | — | BACKEND_NOT_PRESENT | BACKEND_NOT_PRESENT | **No** task mutation/claim endpoint exists |
| Friends / Referrals summary | Code + counts | Referrals | `GET /v1/referrals/summary` | `getReferralsSummary` | `queryKeys.referrals` | ENGINE_NOT_ENABLED | ENGINE_NOT_ENABLED | `{ status: UNAVAILABLE, data: null, reasonCode: ENGINE_NOT_ENABLED }` — contract fields `referralCode` / `invitedCount` / `activatedCount` exist for a future READY engine, not today |
| Friends list rows | Pending users, usernames | — | **none** | — | — | BACKEND_NOT_PRESENT | BACKEND_NOT_PRESENT | No referral list endpoint |
| Friends earnings / % benefit | “3.81 USDT”, “10%” | — | **none** | — | — | BACKEND_NOT_PRESENT / ENGINE_NOT_ENABLED | BACKEND_NOT_PRESENT | Never fabricate Mikhail/Sofia/Nour, 12 active, 4 pending |
| Wallet summary | Connected wallets | Wallets | `GET /v1/wallets` | `getWallets` | `queryKeys.wallets` | EXISTING_SERVER_ENDPOINT | READY_EXISTING | Primary, verified, cooldown |
| Wallet Disconnected | No primary / empty | wallets response | `GET /v1/wallets` | `getWallets` | `wallets` | DERIVED_FROM_EXISTING_SERVER_DATA | DERIVED_FROM_SERVER_DATA | |
| Wallet Connecting / Waiting | TonConnect in flight | TonConnect SDK | — | `WalletTonConnectPanel` | — | EXTERNAL_TON_CONNECT | EXTERNAL_SDK | Transient local |
| Wallet Verifying | Challenge issued | Challenge | `POST /v1/wallets/ton-proof/challenge` | `createTonProofChallenge` | — | EXISTING_SERVER_ENDPOINT | READY_EXISTING | Server domain / network — never client |
| Wallet Verified | Bind success | Bind | `POST /v1/wallets/ton-proof/bind` | `bindTonProofWallet` | invalidate wallets/balances | EXISTING_SERVER_ENDPOINT | READY_EXISTING | Invalidate `home` as well when Smart Action depends on it |
| Wallet Failure | Reject / error | Bind / challenge errors | same | same | — | EXISTING_SERVER_ENDPOINT | READY_EXISTING | |
| Wallet disconnect / delete | Remove wallet | — | **none** on user API | — | — | BACKEND_NOT_PRESENT | BACKEND_NOT_PRESENT | Do **not** invent disconnect endpoint; TonConnect UI disconnect ≠ server unbind |
| Withdrawal amount entry | User types amount | — | — | local input | — | PRESENTATION_ONLY_LOCAL | PRESENTATION_ONLY | Input only; fees/net from quote |
| Withdrawal quote | Show fee / net / expiry | Quote | `POST /v1/withdrawals/quote` | `createWithdrawalQuote` | — | EXISTING_SERVER_ENDPOINT | READY_EXISTING | Server authoritative: amounts, fee versions, `expiresAt`, `priorityReview` |
| Withdrawal quote cancel | Cancel open quote | Cancel | `POST /v1/withdrawal-quotes/:id/cancel` | **missing** | — | EXISTING_SERVER_ENDPOINT | CLIENT_WRAPPER_MISSING | Add client wrapper only — not new backend |
| Withdrawal confirm | Create withdrawal | Create | `POST /v1/withdrawals` | `createWithdrawal` | invalidate withdrawals/balances/home | EXISTING_SERVER_ENDPOINT | READY_EXISTING | Generated **idempotencyKey** required |
| Withdrawal history | List | List | `GET /v1/withdrawals` | `getWithdrawals` | `queryKeys.withdrawals` | EXISTING_SERVER_ENDPOINT | READY_EXISTING | |
| Withdrawal detail | Single withdrawal | Detail | `GET /v1/withdrawals/:id` | **missing** | suggest `['withdrawals', id]` | EXISTING_SERVER_ENDPOINT | CLIENT_WRAPPER_MISSING | Server exists; add `getWithdrawal(id)` |
| Activity Center | Cross-product feed | — | **no** `/v1/activity` | — | — | BACKEND_NOT_PRESENT | BACKEND_NOT_PRESENT | May show visual shell + empty/unavailable only |
| Activity partial truth | Withdrawals / announcement / membership | Existing domains | withdrawals / home | existing | existing | DERIVED_FROM_EXISTING_SERVER_DATA | DERIVED_FROM_SERVER_DATA | Must not synthesize fake events |
| Notification Center | List / unread / mark-read | — | **no** user notifications list/read API | — | — | BACKEND_NOT_PRESENT | BACKEND_NOT_PRESENT | Admin campaigns API is **not** a user inbox |
| Home announcement (limited) | One banner | Home announcement | via home | `getHome` | `home` | EXISTING_SERVER_ENDPOINT | READY_EXISTING | Must not pretend to be a full notification system; no mark-read user API |
| Profile | Account status | Auth user + settings | settings + session | `getSettings` | `settings` | EXISTING_SERVER_ENDPOINT | READY_EXISTING | |
| Language EN / AR / RU | Change locale | Settings write | `PATCH /v1/me/settings` | `patchSettings` | invalidate settings/home | EXISTING_SERVER_ENDPOINT | READY_EXISTING | Writable: `preferredLocale` only among locales |
| Payout Privacy | SHOW_USERNAME / HIDE_IDENTITY | Settings write | `PATCH /v1/me/settings` | `patchSettings` | settings/home | EXISTING_SERVER_ENDPOINT | READY_EXISTING | Writable: `publicPayoutIdentityMode` |
| Notification Preferences toggle | marketing on/off | Settings read | `GET /v1/me/settings` | `getSettings` | `settings` | BACKEND_NOT_PRESENT (write) | BACKEND_NOT_PRESENT | `marketingNotificationsEnabled` is **read-only** in response; **not** in `PatchUserSettingsRequest`. Do not show a lying toggle. Security notifications are always `true` and non-disableable |
| Founder status | Standard / Founder / number | Membership | `GET /v1/membership` | `getMembership` | `membership` | EXISTING_SERVER_ENDPOINT | READY_EXISTING | |
| Founder entitlements | Benefit list | Entitlements | `GET /v1/membership/entitlements` | `getEntitlements` | `entitlements` | EXISTING_SERVER_ENDPOINT | READY_EXISTING | |
| Founder claim | Submit claim code | Claim | `POST /v1/membership/founder/claim` | `claimFounder` | invalidate membership/entitlements/home | EXISTING_SERVER_ENDPOINT | READY_EXISTING | **claimCode required** — never remove for one-tap Figma; never store in localStorage/sessionStorage/logs/analytics |
| Support ticket list | Browse tickets | Support | `GET /v1/support/tickets` | `listSupportTickets` | `supportTickets` | EXISTING_SERVER_ENDPOINT | READY_EXISTING | |
| Support create | New ticket | Support | `POST /v1/support/tickets` | `createSupportTicket` | invalidate list | EXISTING_SERVER_ENDPOINT | READY_EXISTING | |
| Support ticket detail / thread | Open ticket | Support | `GET /v1/support/tickets/:id` | `getSupportTicket` | `supportTicket(id)` | EXISTING_SERVER_ENDPOINT | READY_EXISTING | Client wrapper exists; dedicated LOOTRA thread UI not yet built |
| Support send message | Reply | Support | `POST /v1/support/tickets/:id/messages` | `postSupportMessage` | invalidate detail/list | EXISTING_SERVER_ENDPOINT | READY_EXISTING | Wrapper exists; wire in LOOTRA thread UI |
| Account deletion | Request review | Support | `POST /v1/support/account-deletion-requests` | `requestAccountDeletion` | invalidate tickets | EXISTING_SERVER_ENDPOINT | READY_EXISTING | Review request only — never ledger wipe |
| Legal Terms / Privacy | Open docs | Public env URLs | — | `termsOfServiceUrl` / `privacyPolicyUrl` | — | PRESENTATION_ONLY_LOCAL (URL config) | PRESENTATION_ONLY | `NEXT_PUBLIC_TERMS_URL` / `NEXT_PUBLIC_PRIVACY_URL`; no server-hosted legal body |
| Offline / degraded / error / loading | Resilience | Domain envelopes + fetch errors | — | `DomainStateView` | — | DERIVED_FROM_EXISTING_SERVER_DATA | READY_EXISTING | Preserve Phase 12 domain honesty |
| LOOTRA 3D assets | Visual | — | — | — | — | PRESENTATION_ONLY_LOCAL | PRESENTATION_ONLY | Never financial truth |
| TonConnect manifest | Wallet UI config | Public env | — | `tonConnectManifestUrl` | — | EXTERNAL_TON_CONNECT | EXTERNAL_SDK | Absent → honest degrade |

---

## Domain deep-dives

### A. Tasks

- **Endpoint:** `GET /v1/tasks` → always `UNAVAILABLE` + `ENGINE_NOT_ENABLED` + `items: []`.
- **Mutations:** **none** (no claim, verify, progress POST).
- **UI rule:** LOOTRA Tasks screen must use designed unavailable / engine-not-enabled state. **Forbidden:** fake active tasks, fake verification, fake Claim Reward, local reward issuance.

### B. Referrals / Friends

- **Endpoint:** `GET /v1/referrals/summary` → always `UNAVAILABLE` + `ENGINE_NOT_ENABLED` + `data: null`.
- **Not provided:** individual referral list, pending rows, usernames, monetary earnings, current percentage benefit.
- **Forbidden fabrication:** “12 active”, “4 pending”, “3.81 USDT”, “Mikhail / Sofia / Nour”, “10%”.

### C. Activity Center

- **Confirmed:** no user `GET /v1/activity` (or equivalent) in API controllers.
- **Partial truth sources only:** `GET /v1/withdrawals`, home `latestWithdrawal`, home `announcement`, home `membershipBrief`.
- **Rule:** do not synthesize a cross-product history. Full Activity Center = `BACKEND_NOT_PRESENT` → visual shell + empty/unavailable.

### D. Notifications

- **Confirmed:** no user notification list / mark-as-read / unread-count / deep-link API.
- Admin `GET/POST /v1/admin/notifications/campaigns*` is Owner Admin only — **not** Mini App.
- **Home announcement:** single latest non-`SECURITY` notification row projected into `HomeSummaryResponse.announcement`. May power a **one-banner** Home slot only. Must not pretend to be Notification Center. No user mark-read API.

### E. Settings

Writable via `PatchUserSettingsRequest` **only**:

- `preferredLocale`
- `publicPayoutIdentityMode`

Readable but **not** writable:

- `marketingNotificationsEnabled`
- `securityNotificationsEnabled` (always `true`; cannot disable)

LOOTRA Notification Preferences must not present a functioning marketing toggle that cannot persist.

### F. Wallet states

| UI state | Source |
| --- | --- |
| Disconnected | `GET /v1/wallets` empty / no verified primary |
| Connecting / Waiting | TonConnect SDK local |
| Verifying | `POST .../challenge` + proof UX |
| Verified | `POST .../bind` success |
| Failure | Server/SDK errors |
| Cooldown | `withdrawalCooldownUntil` on wallet summary |

**No** user wallet disconnect/delete endpoint.

### G. Withdrawals

| Step | Endpoint | Client |
| --- | --- | --- |
| Amount entry | — | local |
| Quote | `POST /v1/withdrawals/quote` | `createWithdrawalQuote` **exists** |
| Cancel quote | `POST /v1/withdrawal-quotes/:id/cancel` | **CLIENT_WRAPPER_MISSING** |
| Confirm | `POST /v1/withdrawals` + idempotencyKey | `createWithdrawal` **exists** |
| History | `GET /v1/withdrawals` | `getWithdrawals` **exists** |
| Detail | `GET /v1/withdrawals/:id` | **CLIENT_WRAPPER_MISSING** |

### H. Earn + Reward Drop

Flow: authorize → AdsGram SDK → client-signal evidence → attempt-verify → **server** `issued` / `alreadyRewarded`.

- **Never** optimistic credit.
- Animate new Reward Drop **only** when `issued === true`.
- `alreadyRewarded === true`: acknowledge prior issuance; **no** second credit animation / no balance bump claim.
- While `productionMonetaryStatus === BLOCKED` (current AdsGram policy): UI must show blocked / unavailable production earnings — not live production money.

### I. Home / Smart Action queries

Required for honest Smart Action:

1. `GET /v1/wallets` (verification) — **required in addition to Home**
2. `GET /v1/me/home` (missions counts — currently ENGINE_NOT_ENABLED; latestWithdrawal; todayAds; announcement; membershipBrief)
3. Optionally `GET /v1/ads/earn-summary` for richer earn CTA

If missions later become READY with counts but **no task ID**, Smart Action routes to `/tasks`, never invents a Task Detail ID.

### J. Founder

Preserve: claim **code** input, server rejection (400/403/409), rate limit (429), success, already-Founder.  
**claimCode** never enters localStorage, sessionStorage, logs, or analytics (existing `FounderClaimForm` pattern).

### K. Support

Fully real with existing endpoints: list, create, detail, messages, account-deletion request.  
Detail/thread client methods already exist; LOOTRA screens can wire them immediately.

### L. Legal

Terms/Privacy are **public URL env** (`NEXT_PUBLIC_TERMS_URL`, `NEXT_PUBLIC_PRIVACY_URL`), not server document bodies. Absent URL → honest “not configured”.

### M. Splash / Onboarding / 3D

`PRESENTATION_ONLY_LOCAL`. Never financial / membership / wallet / reward truth. Onboarding completion may be local UI preference only (no new backend field in this program without a later approved phase).

---

## Query invalidation matrix

| After | Invalidate |
| --- | --- |
| Reward issuance (`issued` or terminal verify) | `earnSummary(provider)`, `home`, `balances` |
| Wallet bind success | `wallets`, `balances`, `home` (for Smart Action) |
| Withdrawal create | `withdrawals`, `balances`, `home` |
| Founder claim | `membership`, `entitlements`, `home` |
| Settings patch | `settings`, `home` (if locale/payout identity shown on Home) |
| Support create / message / deletion request | `supportTickets`; `supportTicket(id)` when detail open |
| Quote cancel (when wrapper added) | local quote UI state; no list change required unless quote appears in UI caches |

Do not invalidate unrelated domains (e.g. tasks after wallet bind).

---

## DO NOT FABRICATE

Figma / prototype elements that **cannot** be backed by current backend truth:

1. Active / claimable mission rows with progress or Claim Reward
2. Referral invitee list (Pending / Active people)
3. Referral usernames (e.g. Mikhail, Sofia, Nour)
4. Referral monetary earnings (e.g. 3.81 USDT)
5. Referral percentage benefit (e.g. 10%)
6. Fabricated referral counts (e.g. 12 active / 4 pending) while engine is `ENGINE_NOT_ENABLED`
7. Full Activity Center event timeline
8. Notification inbox, unread badges, mark-as-read, deep-link targets
9. Marketing notification preference as a working write toggle
10. Server wallet disconnect / delete
11. Live production AdsGram earnings while monetary status is **BLOCKED**
12. Optimistic Reward Drop without `issued === true`
13. One-tap Founder claim without claim code
14. Server-hosted Terms/Privacy document bodies
15. Task Detail IDs when only counts exist (and currently even counts are unavailable)

---

## SAFE TO IMPLEMENT NOW

Screens/features that can be fully implemented against existing server authority (LOOTRA visuals OK):

1. Splash / 3D / motion shells (presentation)
2. Onboarding (local presentation)
3. Telegram auth + session refresh/logout
4. Home aggregate (balances, todayAds, latestWithdrawal, announcement, membershipBrief) with domain honesty
5. Smart Action using `home` + `wallets` (+ earn as needed), with engine-disabled branches honest
6. Earn summary + authorize + SDK + attempt-verify + blocked monetary UX
7. Reward Drop gated on `issued`
8. Wallet list + TonConnect challenge/bind + failure/cooldown
9. Withdrawal amount → quote → confirm → history
10. Profile language + payout privacy
11. Founder status / entitlements / claim-code flow
12. Support list + create + deletion request
13. Support detail/thread (wrappers already present)
14. Legal external links
15. Offline / degraded / error / loading patterns

**SAFE_TO_IMPLEMENT_NOW_COUNT: 15**

---

## VISUAL SHELL ONLY FOR NOW

LOOTRA design may render chrome, but must show unavailable / empty / engine-not-enabled — not fake data:

1. Tasks / Missions center
2. Friends referral list, pending rows, earnings, % benefit
3. Activity Center (full feed)
4. Notification Center (full inbox)
5. Marketing notifications toggle (as functional control)
6. Smart Action “claimable task” priority (until engine READY + IDs exist)
7. Wallet disconnect affordance as server action

**VISUAL_SHELL_ONLY_COUNT: 7**

---

## REQUIRED CLIENT-ONLY ADDITIONS

Not backend work — typed Mini App wrappers / keys for **existing** routes:

1. `getWithdrawal(id)` → `GET /v1/withdrawals/:id` + query key `['withdrawals', id]`
2. `cancelWithdrawalQuote(id)` → `POST /v1/withdrawal-quotes/:id/cancel`
3. Optional: typed `postAdClientSignal(sessionId, body)` → `POST /v1/ads/sessions/:id/client-signal` (today: raw `fetch` in `AdsGramRewardedBridge`)
4. Wire Support detail/message UI to existing `getSupportTicket` / `postSupportMessage`
5. Invalidate `home` after wallet bind (if Smart Action uses wallets + home)

---

## BACKEND WORK DEFERRED

Do **not** implement in the LOOTRA UI integration task:

1. Mission / task engine + claim/mutation APIs
2. Referral engine activation + list / earnings APIs
3. User Activity feed API
4. User Notifications list / read / unread APIs
5. Writable `marketingNotificationsEnabled`
6. User wallet disconnect/delete API
7. AdsGram production monetary unblocking
8. Fake-chain or real-chain payout enablement
9. Server-hosted legal document bodies
10. Removing Founder claim-code requirement
11. Any Phase 14 product engines

---

## Endpoint existence checklist (verified in source)

| Capability | Server | Client wrapper |
| --- | --- | --- |
| Task mutation / claim | **NO** | N/A |
| Referral list | **NO** | N/A |
| `/v1/activity` | **NO** | N/A |
| User notifications list/read | **NO** | N/A |
| `GET /v1/withdrawals/:id` | **YES** | **NO** |
| `POST /v1/withdrawal-quotes/:id/cancel` | **YES** | **NO** |
| `POST /v1/ads/sessions/:id/client-signal` | **YES** | Partial (raw fetch only) |
| Support detail / messages | **YES** | **YES** |

---

## Counts for closeout report

| Bucket | Count |
| --- | --- |
| SAFE_TO_IMPLEMENT_NOW | 15 |
| VISUAL_SHELL_ONLY | 7 |
| BACKEND_NOT_PRESENT (major gaps listed in DO NOT FABRICATE / deferred) | 11 |

---

## Explicit non-goals

- No Phase 14 start  
- No Phase 13 / PR #9 changes  
- No AdsGram monetary enablement  
- No fake/real chain enablement  
- No signer deploy  
- No schema / new API endpoints in this documentation task  

*End of mapping. Implementation of LOOTRA UI is a separate Owner-authorized follow-up that must obey this document.*
