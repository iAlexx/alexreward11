# ALEx Rewards
## Master Product, Financial, Security & Engineering Specification
### Consolidated Master Specification — Version 1.2

**Status:** Consolidated implementation baseline with V1.2 product/platform expansion  
**Date:** 2026-09-08  
**Primary audience:** OpenAI Codex and future ALEx Rewards engineers  
**Project owner:** Single Owner account  
**Primary platform:** Telegram Mini App + Telegram Bot  
**Initial ad provider:** AdsGram  
**Initial payout asset/network:** USDT on TON

---


# CHANGELOG — V1.1 TO V1.2

Version 1.2 preserves the approved Version 1.1 financial, security, payout, ledger, fraud, reconciliation, signer, and provider-safety baseline, then adds the product/platform expansion decisions approved after Version 1.1.

Version 1.2 adds or strengthens:

- the **ALEx Rewards Founder Lifetime Pass** at **50 USD one-time**, represented as a membership/entitlement product rather than equity, profit sharing, or guaranteed investment return;
- Founder numbering, permanent Founder status history, one-time claim codes for pre-launch/manual purchasers, Owner grant flow, anti-resale controls, benefit auditability, and future membership-tier extensibility;
- a typed **Membership + Entitlements** architecture so benefits are not implemented through scattered `if (isFounder)` branches;
- separate, auditable platform-funded Founder bonuses, referral boosts, fee benefits, priority review/support, exclusive missions, competitions, and early-access entitlements without bypassing fraud, provider, wallet, payout, legal, or security rules;
- **versioned provider limits** and the rule that provider request/success limits MUST NOT be hardcoded in application business logic;
- separate provider hard/contract limits and ALEx Rewards soft/user/tier limits, so a provider change such as AdsGram `30 -> 100` requests/day is an audited configuration change rather than a code rewrite;
- a formal **Provider Plugin/Adapter Framework**, capability manifests, provider contract registry, onboarding lifecycle, certification test harness, settlement/reconciliation model, health routing, country rules, and future failover/optimization;
- a typed **Policy/Rules Center** that coordinates domain-specific versioned rules without allowing arbitrary executable code or bypassing the ledger;
- a **User Eligibility Engine** and a separate **Trust Score** foundation; Founder/Premium status never equals trusted and never bypasses fraud;
- **economic guardrails**, bonus budgets, exposure limits, margin protection, provider settlement data, and an Owner Economics dashboard;
- a unified manual **Review Queue** for withdrawal, fraud, provider, invalid-traffic, referral, Founder-claim, and support escalation cases;
- a generic **Mission Engine** replacing hardcoded task growth, while preserving the V1 basic task requirements;
- notification campaign/segmentation foundations, granular feature flags and kill switches, domain-event conventions, and safe experimentation boundaries;
- explicit future support for Premium/Partner/Influencer memberships, advertiser self-service, more providers, multiple payout networks/assets, and scale-out without making those items Initial V1 blockers;
- a mandatory **phase archive rule**: after every accepted phase, create under `phase-archives/` both a deterministic canonical source ZIP and a single self-contained final review-package ZIP (plus acceptance report, MANIFEST, SHA256SUMS, and PACKAGE_SHA256), verify both levels, then stop for Owner approval before the next phase.

All Version 1.2 language supersedes conflicting Version 1.1 language. All Version 1.1 requirements not expressly changed by Version 1.2 remain fully in force.


# CURRENT EXECUTION / RESUME NOTE — 2026-09-08

The repository already contains a Phase 1 foundation implementation. Version 1.2 does **not** authorize rebuilding or discarding correct Phase 1 work. Cursor/Codex must inspect the current repository and the existing Phase 1 acceptance report, close any remaining Phase 1 runtime/CI acceptance gates, create the mandatory Phase 1 archive from the accepted commit, and wait for Owner approval before Phase 2.

If later evidence shows Phase 1 has already passed every gate, document the evidence rather than rerunning destructive setup or inventing a new foundation.

---


Where Version 1.2 describes an initial value as `OWNER_DECISION_REQUIRED`, `PROPOSED_DEFAULT`, or `configurable`, Codex/Cursor MUST NOT silently invent a production value. It must preserve the configurable architecture and request explicit Owner approval before production enablement of the affected economic or policy behavior.

---

# CHANGELOG — V1.0 TO V1.1

Version 1.1 consolidates the approved Phase 0 safety amendments directly into this specification. It:

- adds transactionally maintained, rebuildable `ledger_account_balances` projections and database-enforced ledger immutability;
- replaces mutable reversal status with new linked reversal transactions using `reverses_transaction_id`;
- corrects and expands the accounting posting templates;
- fixes Reward Engine arithmetic to integer-only `FLOOR` calculation and adds atomic reward-budget reservations;
- replaces the linear ad-event assumption with independent append-only client/provider evidence and a derived aggregate state;
- blocks AdsGram production monetary rewards pending provider clarification about callback authenticity, correlation, delivery/retry behavior, and provider-side request limiting;
- adopts the corrected withdrawal state machine, preserves Reserved funds through ambiguity, and forbids blind post-broadcast retries;
- defines `CONFIRMED` as proof of the intended successful TEP-74 Jetton transfer, not seqno advancement alone;
- introduces a separate `apps/signer` trust boundary and removes KMS signing permission from general workers;
- makes Temporal withdrawal workflow starts Transactional-Outbox-driven with deterministic workflow IDs;
- introduces the V1 `WithdrawalRiskPolicy`, separate TON network verification, and mandatory post-restore reconciliation;
- adds the approved database tables, uniqueness constraints, withdrawal limits, Hot Wallet thresholds, invalid-traffic rules, referral rules, risk actions, and Owner authentication model;
- updates failure and test matrices; and
- separates Phase 1 development blockers from production/mainnet launch blockers.

All Version 1.1 language supersedes conflicting Version 1.0 language. Original product requirements not expressly changed remain in force.

---

# 0. READ THIS FIRST — NON-NEGOTIABLE INSTRUCTIONS FOR CODEX

This document is the source of truth for ALEx Rewards V1 and for the architecture that must support later phases.

Codex MUST NOT invent missing financial rules, weaken security requirements, silently change state machines, or implement shortcuts around the ledger, payout workflow, fraud engine, or audit system.

If a requirement appears ambiguous:

1. Stop the affected implementation.
2. State the ambiguity explicitly.
3. Propose the safest options.
4. Do not choose a financial or security-sensitive behavior without approval.

Codex MUST work phase-by-phase. A later phase MUST NOT start until the current phase's acceptance criteria and mandatory test gates pass.

No production money may be used until TON Testnet, failure-recovery, idempotency, ledger-invariant, concurrency, reconciliation, and security gates defined in this document have passed.

Critical paths MUST NOT contain unfinished TODOs, mock security, placeholder authorization, fake payout confirmation, or client-trusted financial logic.

The application is a financial rewards platform. Correctness, recoverability, auditability, idempotency, and fraud resistance take priority over speed of implementation.

---

# 1. PRODUCT DEFINITION

## 1.1 Product name

**ALEx Rewards**

The brand name is user-facing. Internal modules should use stable technical names that do not couple the codebase to branding unnecessarily.

Examples:

- `rewards`
- `ledger`
- `withdrawals`
- `ad-providers`
- `fraud`
- `wallets`

Do not create business logic that depends on the literal brand string.

## 1.2 Product model

ALEx Rewards is a Telegram-based reward platform where real users can voluntarily complete rewarded advertising and other future tasks, accumulate rewards, and withdraw eligible balances.

The platform consists of:

1. Telegram Mini App for users.
2. Telegram Bot as entry point, referral router, notification channel, and user communication layer.
3. Web Admin Dashboard for deep administration and analytics.
4. Private Telegram Admin Control Center implemented as a Telegram Supergroup with Forum Topics.
5. Public Telegram Payout Logs channel.
6. Public Official ALEx Rewards channel.
7. Backend API.
8. PostgreSQL financial ledger.
9. Dynamic Reward Engine.
10. Ad Provider Abstraction Layer.
11. Fraud / Risk Engine.
12. Wallet ownership verification.
13. TON payout infrastructure.
14. Temporal durable workflows.
15. Reconciliation subsystem.
16. Monitoring, alerting, audit, backup, and disaster recovery systems.

The platform must be valuable and usable without forcing the user to watch an advertisement for every action.

Rewarded advertising is an optional earning action, not a requirement to access basic application functionality.

---

# 2. LOCKED PRODUCT DECISIONS

| Requirement | Approved decision |
|---|---|
| Product | ALEx Rewards |
| User client | Telegram Mini App |
| Telegram Bot | Yes |
| Admin web dashboard | Yes |
| Languages | Arabic, English, Russian |
| Initial rewarded ad provider | AdsGram |
| Provider architecture | Multi-provider from day one |
| AdsGram production monetary status | BLOCKED pending provider security/correlation clarification |
| User-visible daily rewarded opportunities | 25 successful rewarded ads/day |
| AdsGram safety request limit | Maximum 30 provider requests/user/day |
| Reward model | Dynamic, server-controlled |
| Initial withdrawal asset | USDT |
| Initial withdrawal network | TON |
| Minimum withdrawal request | 0.20 USDT before platform withdrawal fee |
| Withdrawal fee | Paid by the user; initial fixed fee 0.01 USDT; versioned/configurable |
| Maximum single withdrawal | 5 USDT gross initially; versioned/configurable |
| Per-user withdrawal limits | 5 USDT gross/hour and 10 USDT gross/UTC day initially; versioned/configurable |
| Hot Wallet payout volume limits | 25 USDT gross/hour and 100 USDT gross/UTC day initially; versioned/configurable |
| User wallet connection | TON Connect |
| Wallet ownership verification | `ton_proof` |
| Payout wallet | Dedicated ALEx Rewards Hot Wallet |
| Treasury wallet | Owner-controlled, not accessible by application server |
| Initial payout authorization | Manual review / approval |
| Future trusted-user payout | Automatic, policy-controlled |
| KYC in V1 | Disabled |
| Future KYC | Architecture must be KYC-ready |
| Referral V1 | Level 1 only |
| Referral percentage | Admin-configurable |
| Default referral placeholder | 5%, not hardcoded |
| Referral reward deduction from invitee | Never; referrer reward is separate |
| Levels | Later phase |
| Sponsored task marketplace | Later phase |
| Payout public proof channel | Yes |
| Telegram private control group | Yes |
| Admin model in V1 | One Owner |
| Ledger model | Immutable double-entry |
| Money arithmetic | Atomic integer units only |
| Primary financial truth | PostgreSQL ledger |
| Long-running critical workflows | Temporal |
| Redis financial authority | None |
| Adult ad categories | Disabled by default |
| Gambling ad categories | Disabled by default |
| Internal timestamps | UTC |
| Wallet-change withdrawal cooldown | 24 hours by default, configurable |
| Pending reward hold | 24 hours for new/untrusted accounts by default, configurable |
| Reward arithmetic rounding | FLOOR after full integer numerator/denominator calculation |
| Reward quote budget handling | Atomically reserve on quote; release on pre-start expiry; consume on reward |
| Hot Wallet operational thresholds | Target 50 USDT; warning 20 USDT; critical 10 USDT |
| Founder product | `FOUNDER_LIFETIME` membership / Founder Pass |
| Founder price | 50 USD one-time; lifetime membership status |
| Founder legal/economic meaning | Membership benefits only; no equity, ownership, profit share, guaranteed ROI, guaranteed payback, or fixed earnings promise |
| Founder numbering | Permanent unique sequential Founder number, e.g. `Founder #0001` |
| Founder pre-launch/manual purchase claim | One-time Owner-issued claim code or audited direct grant; bind once to validated Telegram user |
| Founder transfer/resale | No self-service transfer; any exceptional reassignment requires Owner-controlled reviewed/audited process |
| Founder reward bonus | Platform-funded separate bonus; initial proposed launch profile `+5%` (`500 bps`) on eligible rewards, configurable/versioned and budget-capped |
| Founder referral profile | Initial proposed effective referral profile `7%` where base V1 is `5%`; configurable/versioned; invitee reward is never reduced |
| Founder withdrawal benefit | Configurable platform-fee discount/waiver entitlement; exact launch rule must be explicitly approved before public promise/enablement |
| Founder payout behavior | Priority review/queue only; never bypass fraud/risk, wallet proof, cooldowns, liquidity, legal rules, limits, signer or reconciliation |
| Founder non-financial benefits | Founder badge, Founder number, priority support, exclusive missions/campaigns, competitions, early access |
| Membership architecture | Typed membership + entitlement model; future Premium/Partner/Influencer tiers architecture-ready |
| Provider limits | Versioned configuration/capability data; no business-logic hardcoding of provider request/success limits |
| Provider limit hierarchy | Provider/contract hard limits are absolute; ALEx Rewards platform/user/tier limits may be stricter but never looser than an approved provider hard limit |
| Provider limit change | Audited/effective-dated Owner configuration change with source/reference and impact preview; no deployment required when only the approved numeric/config rule changes |
| Provider integration architecture | Compile-time registered Provider Adapter/Plugin framework with capability manifest, certification suite and production-monetary approval gate |
| Provider routing | Architecture-ready for country/health/fill/eCPM/margin/cap-aware routing; only approved providers may receive monetary traffic |
| Provider failover | Allowed only through explicit session-safe routing; never switch an already-started rewarded session in a way that can create duplicate/ambiguous reward evidence |
| Rules/policy model | Typed, versioned, allowlisted domain rules; no arbitrary code/eval in database configuration |
| Trust model | Trust score/state is separate from Fraud/Risk and separate from membership; Founder status never implies trusted |
| Economic safety | Provider, country, membership, referral, task/mission and global reward exposure budgets/limits with kill switches |
| Review operations | Unified review queue/control surface; domain systems remain the source of state and money truth |
| Mission model | Generic versioned Mission Engine; all monetary mission rewards still flow Reward Engine -> immutable Ledger |
| Feature flags | Granular, versioned/environment-aware flags and kill switches; never used to weaken required financial/security invariants |
| Phase archives | Mandatory dual-archive after every accepted phase under `phase-archives/`: deterministic canonical source ZIP + final Owner review-package ZIP with report/MANIFEST/SHA256SUMS/PACKAGE_SHA256; archives excluded from normal source commits |
| Support | In-app ticket system |
| Account deletion | Anonymize eligible personal data; never delete required financial/audit history |

The AdsGram 30-request/day limit is based on the direct answer received from AdsGram support for this exact business model. Treat it as a provider-specific safety rule unless AdsGram later gives a new written rule.

## 2.1 V1.2 provider-limit rule

The current AdsGram `30 provider requests/user/UTC day` value is a provider-specific approved safety value, not a permanent application constant.

The implementation MUST distinguish at minimum:

```text
provider_hard_request_limit
provider_hard_success_limit (if provider defines one)
contract_request_limit
contract_success_limit
platform_soft_request_limit
platform_soft_success_limit
user/tier request limit
user/tier success limit
country/provider override
hourly limit where configured
cooldown_seconds
valid_from / valid_to
rule_version
source_reference
approved_by
```

The effective limit is the safest applicable allowed limit. Membership or experimentation may make ALEx Rewards limits stricter, but MUST NOT exceed a provider/contract hard limit.

Example future change:

```text
AdsGram written rule today: 30 requests/day
AdsGram written rule later: 100 requests/day
```

The Owner must be able to create a new approved provider-limit rule version, attach/reference the new written provider basis, see an impact preview, confirm the change, and activate it at an effective time. Normal numeric rule changes MUST NOT require editing application business logic or redeploying merely to replace `30` with `100`.

A provider limit may not be raised from an unverified rumor, client-provided value, or user tier. Provider hard-limit changes require a recorded trusted source such as contract, official provider documentation, written provider support, or approved provider account configuration evidence.


---

# 3. CORE SYSTEM PRINCIPLES

## 3.1 Frontend has zero financial authority

The Mini App may request actions but may never be trusted to:

- increase a balance;
- decrease a balance;
- mark an advertisement as financially valid;
- decide the reward amount;
- approve a withdrawal;
- claim that a blockchain payment succeeded;
- modify a risk decision;
- bypass a daily limit.

Client data is input, not truth.

## 3.2 PostgreSQL ledger is the financial source of truth

The following must never be sources of financial truth:

- React state;
- browser local storage;
- Telegram messages;
- Redis counters;
- Temporal workflow state alone;
- blockchain RPC cache;
- AdsGram browser callback alone;
- analytics databases.

The canonical financial record is the immutable PostgreSQL ledger plus corresponding domain transaction records.

## 3.3 Redis is disposable

Redis may contain:

- rate limits;
- short-lived locks;
- session acceleration;
- temporary idempotency cache;
- ad cooldown cache;
- frequently used non-authoritative computed data.

If Redis is completely lost, no user money may be lost, duplicated, or changed.

## 3.4 Telegram is an interface, not the financial system

A Telegram `Approve` action performs:

`Telegram callback -> Bot -> Backend authorization -> Current-state validation -> Audit record -> DB state transition + Outbox -> deterministic Temporal workflow start`

It MUST NOT directly sign or send money.

## 3.5 Blockchain role

The TON blockchain is authoritative for whether an external payout transaction exists and reached the required confirmed state. It is not the internal user-balance database.

## 3.6 No floating-point money

Never use JavaScript floating-point `number` for money calculations.

Use:

- PostgreSQL `BIGINT` for atomic token amounts when appropriate;
- TypeScript `bigint` internally;
- arbitrary-precision integer intermediates (TypeScript `bigint` or PostgreSQL `NUMERIC` with scale 0) where multiplication could overflow `BIGINT`, followed by explicit bounds checking before storage;
- decimal strings in JSON API responses because JSON does not natively serialize BigInt;
- an asset registry containing `asset_code`, `decimals`, token identity, and network.

Example for USDT on TON:

- UI: `0.20 USDT`
- Atomic value: `200000`
- Decimals: `6`

At deployment, the system MUST verify the official token metadata and allowlisted USDT Jetton master. Never allow a user or frontend to select the token master contract used for payouts.

---

# 4. RECOMMENDED TECH STACK

Use stable patched releases current at implementation time and pin exact versions in lockfile and deployment artifacts.

## 4.1 Language

**TypeScript** end-to-end where appropriate.

## 4.2 Runtime

**Node.js 24 LTS**, pinned to a patched version satisfying NestJS 12 application and CLI requirements.

Do not use experimental runtime replacements for the payout worker or Temporal workers.

## 4.3 User Mini App

- Next.js 16.x stable, latest security-patched release
- React 19.x compatible stable release
- TypeScript
- App Router
- Tailwind CSS
- TanStack Query
- Zod for boundary validation where useful
- `next-intl` or equivalent mature i18n library
- `@tonconnect/ui-react`
- AdsGram official React package / SDK
- Telegram WebApp official script/API

## 4.4 Admin Dashboard

- Next.js 16.x stable
- React
- TypeScript
- Tailwind CSS
- controlled component system such as shadcn/ui
- TanStack Query
- chart library such as Recharts
- WebAuthn / Passkeys for primary Owner authentication
- password + TOTP fallback
- recovery codes

All financial writes go through backend API.

## 4.5 Backend API

**NestJS 12 + Fastify adapter**

Responsibilities:

- authentication;
- authorization;
- user management;
- wallet verification;
- ad session authorization;
- reward decisions;
- ledger posting;
- withdrawals;
- fraud decisions;
- admin APIs;
- provider webhooks;
- Telegram action validation;
- configuration;
- support.

## 4.6 Database

**PostgreSQL**

Use ACID transactions, unique constraints, foreign keys, row-level locks, and stronger isolation where required.

## 4.7 SQL layer

**Kysely + `pg` + explicit SQL migrations**

Financial code should remain close to visible SQL semantics.

## 4.8 Workflow engine

**Temporal**

Use durable workflows for:

- withdrawal lifecycle;
- waiting for Owner approval;
- TON signing/broadcast/confirmation;
- reconciliation after unknown outcomes;
- future auto-payout policy;
- reward maturity batching;
- referral maturity;
- daily reports;
- payout publication retries;
- provider reporting reconciliation.

Temporal is not the ledger. PostgreSQL remains the financial source of truth.

## 4.9 Cache / rate limiting

**Redis**

Use for rate limiting, temporary action tokens, ad cooldown, cached availability, short-lived locks, session revocation cache, and health cache.

## 4.10 Telegram Bot

Recommended library: **grammY**, unless an implementation spike proves another mature TypeScript library materially better.

## 4.11 TON

Use current official/maintained TON libraries after testnet validation:

- TON Connect;
- `ton_proof`;
- Wallet V5 R1 target;
- TEP-74 Jetton transfers;
- primary + secondary RPC/data providers.

## 4.12 Observability

- OpenTelemetry
- Sentry
- CloudWatch
- structured JSON logs
- trace IDs
- Telegram Control Center alerts

## 4.13 CI/CD

- GitHub Actions
- protected `main`
- PR-based changes
- required checks
- migration validation
- test gates
- security scans

## 4.14 Infrastructure

Recommended production target:

- Mini App -> Vercel
- Admin -> Vercel
- API -> AWS ECS/Fargate
- Bot -> AWS ECS/Fargate
- Workers -> AWS ECS/Fargate
- Signer -> isolated AWS ECS/Fargate service with the only application `kms:Sign` role
- PostgreSQL -> AWS RDS Multi-AZ
- Redis -> AWS ElastiCache
- Temporal -> Temporal Cloud
- Secrets -> AWS Secrets Manager
- Signer key -> AWS KMS target
- Exports/artifacts -> S3
- API edge -> ALB + WAF where appropriate
- Logs -> CloudWatch/OpenTelemetry
- Errors -> Sentry

Use Terraform for Infrastructure as Code.

---

# 5. REPOSITORY ARCHITECTURE

Start as a **modular monolith**, not microservices.

Recommended structure:

```text
alex-rewards/
├── apps/
│   ├── miniapp/
│   ├── admin/
│   ├── api/
│   ├── bot/
│   ├── worker/
│   └── signer/
├── packages/
│   ├── auth/
│   ├── db/
│   ├── ledger/
│   ├── contracts/
│   ├── ads/
│   ├── rewards/
│   ├── wallets/
│   ├── withdrawals/
│   ├── ton/
│   ├── fraud/
│   ├── referrals/
│   ├── tasks/
│   ├── notifications/
│   ├── telegram/
│   ├── support/
│   ├── config/
│   ├── observability/
│   ├── i18n/
│   └── ui/
├── infra/
│   ├── terraform/
│   └── docker/
├── docs/
│   ├── PRODUCT_SPEC.md
│   ├── ARCHITECTURE.md
│   ├── DATABASE.md
│   ├── LEDGER_SPEC.md
│   ├── ADS_SPEC.md
│   ├── WITHDRAWAL_SPEC.md
│   ├── TON_PAYOUT_SPEC.md
│   ├── FRAUD_SPEC.md
│   ├── SECURITY.md
│   ├── FAILURE_MATRIX.md
│   ├── TEST_PLAN.md
│   ├── OPERATIONS_RUNBOOK.md
│   ├── DISASTER_RECOVERY.md
│   └── INCIDENT_RESPONSE.md
├── AGENTS.md
├── pnpm-workspace.yaml
└── package.json
```

Use pnpm workspaces.

## 5.1 V1.2 required domain expansion

The Phase 1 repository already establishes the six deployable boundaries. Do not decompose the application into microservices merely because new domains are added. Extend the modular monolith with clear package/domain boundaries.

Required or architecture-ready V1.2 domains:

```text
packages/
├── memberships/       # membership records, Founder lifetime semantics, grant/claim lifecycle
├── entitlements/      # typed benefit resolution; no scattered isFounder branches
├── policies/          # typed policy/rule orchestration and change controls
├── eligibility/       # provider/mission/feature eligibility decisions and reason codes
├── economics/         # budgets, exposure, margin views, settlement calculations
├── reviews/           # unified review case projections/actions; never money truth
├── missions/          # generic mission definitions/progress/claim orchestration
├── feature-flags/     # environment-aware granular feature flags/kill switches
└── analytics/         # product/business metric contracts; no financial authority
```

Provider-specific code remains under the Ads domain, for example:

```text
packages/ads/
├── provider-sdk/
│   ├── contracts
│   ├── capabilities
│   ├── certification
│   └── test-harness
└── providers/
    ├── adsgram/
    └── <future-provider>/
```

A provider adapter is compile-time registered code reviewed with the repository. Do not implement runtime download/execution of third-party plugin code.

The V1.2 package additions may be introduced only in the phase that needs them. Do not create empty architecture theatre merely to make the tree look complete.


---

# 6. ENVIRONMENTS

Required:

1. `local`
2. `test`
3. `staging`
4. `production`

Rules:

- Production DB is never reused for staging.
- Production Hot Wallet is never used in staging.
- Testnet keys are never reused on mainnet.
- Production KMS key is independent.
- Staging and production Telegram resources should be separate.
- Feature flags are environment-specific.
- Secrets are not shared unless explicitly safe.

---

# 7. TELEGRAM USER AUTHENTICATION

## 7.1 Mini App identity

Use `Telegram.WebApp.initData`.

Never trust `initDataUnsafe` as authenticated server identity.

Flow:

1. Mini App starts.
2. Client sends raw `initData`.
3. API validates Telegram signature using official procedure.
4. Validate `auth_date` freshness.
5. Extract Telegram user after validation.
6. Create/update user.
7. Create server session.
8. Return short-lived application access session.

## 7.2 Telegram ID storage

Use PostgreSQL `BIGINT` and safe TypeScript/API representation.

## 7.3 Sessions

- short-lived access session;
- server-side refresh/session record;
- rotation;
- revocation;
- revoke all on serious security event.

---

# 8. LOCALIZATION

V1:

- Arabic (`ar`) — RTL
- English (`en`) — LTR
- Russian (`ru`) — LTR

Requirements:

- no user-facing hardcoded strings in feature components;
- translation keys;
- pluralization;
- locale-aware dates;
- token amount formatting;
- English fallback.

Financial calculations remain locale-independent.

---

# 9. TIME MODEL

All server/database timestamps use UTC.

Daily ad limits reset by **UTC calendar day**.

Changing phone timezone must not create a second allowance.

Admin reports may display in Owner local timezone while storing UTC.

---

# 10. USER ACCOUNT STATES

Suggested:

```text
ACTIVE
LIMITED
WITHDRAWAL_BLOCKED
SUSPENDED
BANNED
DELETED_ANONYMIZED
```

Keep account access status separate from withdrawal status.

---

# 11. USER MINI APP INFORMATION ARCHITECTURE

Bottom navigation:

1. Home
2. Earn
3. Tasks
4. Friends
5. Wallet

Profile/settings in top header.

Do not clone PaidZ branding, graphics, or copyrighted assets. Feature concepts may inspire organization only.

Visual styling must be isolated with design tokens.

---

# 12. HOME SCREEN

Required blocks:

### Balance Summary
- Available
- Pending
- Reserved in details
- Lifetime Earned

### Today
- Valid rewarded ads completed
- Opportunities remaining
- Provider availability
- Today's earnings

### Streak

### Daily Missions

### Referral Summary

### Latest Withdrawal

### News / Announcement Banner

Future: weekly league, levels, achievements.

---

# 13. EARN SCREEN

V1 contains AdsGram card.

Card shows:

- provider name;
- status;
- estimated/quoted reward;
- successful opportunities remaining;
- `Watch & Earn`;
- explicit text that reward is for valid completed rewarded viewing, never ad click.

---

# 14. ADSGRAM COMPLIANCE

Implementation rules:

- user-triggered ads;
- expected ads;
- basic app usable without ads;
- valid completion required;
- no click reward;
- no forced click;
- no automatic viewing;
- no bot/script traffic;
- no statistics inflation;
- no unrealistic reward promises;
- proof of payouts available publicly.

Adult and Gambling categories disabled by default.

---

# 15. ADSGRAM DAILY LIMIT MODEL

Two counters:

### Successful Reward Count
Maximum: **25 valid rewarded ads/user/UTC day**.

### Provider Request Safety Count
Maximum: **30 AdsGram provider requests/user/UTC day**.

Example:

- 20 completed ads
- 10 actual provider requests that no-fill/error
- provider safety count = 30
- AdsGram stops for that user for the day
- UI does not promise the remaining five.

---

# 16. NO-FILL SEMANTICS

Track separately:

- UI attempt before provider call;
- actual provider request;
- loaded;
- started;
- completed;
- verified reward.

No actual provider request -> do not increment provider request count.

Actual provider request + no inventory -> increment provider request count only; no successful count; no reward.

---

# 17. AD CONCURRENCY CONTROL

Only one active rewarded ad session per user/provider.

This prevents multiple tabs/devices and ambiguous server callback correlation.

Initial configurable cooldown after a session: **30 seconds**.

The active-session constraint remains in force through `PENDING_VERIFICATION`. Cooldown begins only when the session reaches a terminal state.

Because a browser-to-provider SDK call cannot be proven perfectly by the backend, the exact AdsGram provider-request counting point remains blocked pending provider clarification. A provider-side request limit is preferred. No production monetary AdsGram flow may be enabled merely by trusting a client assertion that a provider request occurred.

---

# 18. AD SESSION STATE MACHINE

Ad evidence is not modeled as one strictly ordered callback chain. Client, provider, and system signals are independent, append-only, monotonic records in `ad_session_signals`. The aggregate session state is derived from those records plus domain decisions.

Derived states:

```text
CREATED
QUOTED
AUTHORIZED
REQUESTED
LOADED
STARTED
CLIENT_COMPLETION_RECEIVED
PROVIDER_CONFIRMATION_RECEIVED
PENDING_VERIFICATION
VERIFIED
REWARDED
NO_FILL
FAILED
SKIPPED
REJECTED
EXPIRED
```

Derivation rules:

| Evidence/domain condition | Derived state |
|---|---|
| Session created | `CREATED` |
| Quote and budget reservation committed | `QUOTED` |
| Account, provider, cap and cooldown checks pass | `AUTHORIZED` |
| Approved request-count event recorded | `REQUESTED` |
| Load evidence exists | `LOADED` |
| Start evidence exists | `STARTED` |
| Client completion exists but required provider evidence does not | `CLIENT_COMPLETION_RECEIVED` |
| Provider confirmation exists but required client evidence does not | `PROVIDER_CONFIRMATION_RECEIVED` |
| Provider-required evidence set is present and unambiguously correlated | `PENDING_VERIFICATION` |
| Quote, eligibility, risk, authenticity, correlation, cap and budget checks pass | `VERIFIED` |
| Reward, successful counter and session transition commit atomically | `REWARDED` |
| No-inventory evidence exists | `NO_FILL` |
| User skipped | `SKIPPED` |
| Explicit invalid evidence or policy rejection exists | `REJECTED` |
| Definite technical failure exists | `FAILED` |
| Session/evidence window expires | `EXPIRED` |

Out-of-order signals update evidence, not history. They cannot erase an earlier fact or bypass financial verification. Terminal states remain `REWARDED`, `NO_FILL`, `FAILED`, `SKIPPED`, `REJECTED`, and `EXPIRED`. A terminal session cannot create a second reward.

---

# 19. PROVIDER ABSTRACTION

Conceptual interface:

```ts
interface RewardedAdProvider {
  readonly code: string;
  getCapabilities(): ProviderCapabilities;
  getAvailability(input: AvailabilityInput): Promise<AvailabilityResult>;
  authorizeSession(input: AuthorizeAdInput): Promise<AuthorizeAdResult>;
  normalizeClientEvent(input: unknown): ProviderClientEvent;
  verifyServerSignal(input: unknown): Promise<ProviderVerificationResult>;
  getHealth(): Promise<ProviderHealth>;
}
```

Capabilities can include:

```text
rewarded
interstitial
taskAds
serverRewardCallback
uniqueProviderEventId
serverSignalAuthentication
sessionOrImpressionCorrelation
retryBehaviorDocumented
deliveryWindowDocumented
providerSideRequestLimit
countryReporting
revenueReportingApi
cashRewardPolicyApproved
productionMonetaryStatus = BLOCKED / TEST_ONLY / APPROVED / SUSPENDED
```

V1 adapter: `AdsGramProvider`.

Initial AdsGram `productionMonetaryStatus` is `BLOCKED`. It may not become `APPROVED` until AdsGram clarifies Reward URL authenticity/signature, per-impression/session correlation, retry/delivery behavior, and provider-side request limiting, and the resulting design is reviewed.

Future: `MonetagProvider` only after explicit written approval for the exact rewarded/incentivized model.

---

# 20. ADSGRAM REWARD SIGNAL HANDLING

AdsGram client success is a signal, not direct financial authority.

For a production monetary reward, a protected provider/server signal is mandatory. When Reward URL is configured:

1. store provider server signal;
2. identify user;
3. correlate to one eligible active/recent session;
4. validate time window;
5. ensure not rewarded;
6. record provider confirmation;
7. run server reward policy;
8. post through Reward Engine + Ledger.

Never implement `Reward URL -> UPDATE balance`.

Because the documented AdsGram Reward URL may not include a signature or unique event ID per impression, strict one-active-session correlation alone is not sufficient to approve production money. Until the provider clarification gate passes, signals may be collected in test/staging but cannot produce a withdrawable monetary reward.

A client completion event alone must never reach `VERIFIED`, `REWARDED`, or any ledger-posting command.

---

# 21. REWARD ENGINE

The Reward Engine is the only module that decides monetary reward amount.

Potential sources:

- rewarded ads;
- daily tasks;
- referral bonuses;
- promos;
- competitions;
- support compensation;
- sponsored tasks later.

All money rewards go through Reward Engine -> Ledger.

## 21.1 Dynamic ad reward

Do not pretend aggregate CPM data equals exact real-time revenue of a specific impression.

Use only integer arithmetic. The Version 1.1 calculation is:

```text
numerator =
  estimated_ecpm_atomic
  * user_share_bps
  * safety_factor_bps

denominator =
  1000
  * 10000
  * 10000

raw_reward_atomic = FLOOR(numerator / denominator)
quoted_reward_atomic = clamp(raw_reward_atomic, min_reward_atomic, max_reward_atomic)
```

Never divide intermediate values or use floating-point arithmetic. Apply min/max and budget safety controls only after the full numerator/denominator calculation.

## 21.2 Reward rules

```text
id
provider_code
country_group
asset_id
estimated_ecpm_atomic
user_share_bps
safety_factor_bps
min_reward_atomic
max_reward_atomic
valid_from
valid_to
version
status
created_by
created_at
reason
```

Changing economics creates a new version.

## 21.3 Reward quote

Create a quote before ad starts.

```text
id
user_id
provider
ad_session_id
rule_version
asset
reward_atomic
expires_at
created_at
```

Once a valid ad starts, retain that quote for the session even if Owner changes rules mid-ad.

The session ID and quote ID are pre-generated and inserted in one PostgreSQL transaction. `reward_quotes.ad_session_id` is the sole authoritative FK direction and is unique. The quote transaction also creates a `reward_budget_reservation`.

## 21.4 Margin protection

Controls:

- rolling provider eCPM;
- safety factor;
- min/max reward;
- daily reward budget;
- provider spend/revenue ratio;
- global reward pause;
- country/provider overrides.

Estimated provider revenue is operational analytics only. It does not create `AD_NETWORK_RECEIVABLE` or `AD_REVENUE` ledger postings unless a later explicit accounting policy authorizes recognition.

## 21.5 Reward budget reservations

Reward budgets are enforced in PostgreSQL, not Redis.

Quote creation atomically:

1. locks the applicable `reward_budget_period`;
2. verifies remaining budget;
3. creates the quote and session;
4. creates `reward_budget_reservations` for the quoted atomic amount;
5. commits all records together.

A pre-start expired quote releases its reservation exactly once. A successfully issued reward consumes its reservation exactly once. If the ad validly started before quote expiry, the quoted value remains protected for that session.

---

# 22. REWARD LIFECYCLE

```text
CREATED
PENDING
AVAILABLE
REVERSED
```

Default new/untrusted pending hold: **24 hours**, configurable.

Trusted users later may have shorter/zero hold.

Maturity is Outbox/Temporal-driven and idempotent using a deterministic identity such as `reward-maturity/{reward_event_id}`. Reward issuance, successful daily-counter increment, budget-reservation consumption, ledger posting, and session `REWARDED` transition occur in one PostgreSQL transaction.

---

# 23. USER BALANCE MODEL

Three buckets:

1. Pending
2. Available
3. Reserved

Example:

```text
Pending:   0.300000 USDT
Available: 1.250000 USDT
Reserved:  0.400000 USDT
```

---

# 24. DOUBLE-ENTRY LEDGER

Tables:

```text
ledger_accounts
ledger_transactions
ledger_entries
ledger_account_balances
ledger_balance_snapshots
```

`ledger_entries` and posted transaction headers are the immutable financial source of truth. `ledger_account_balances` is the transactionally maintained current-balance projection used for locking and efficient reads; it is fully rebuildable from entries and is never an independent source of truth. `ledger_balance_snapshots` stores historical/performance snapshots only.

For every transaction, exactly one asset is used and:

`sum(debits) == sum(credits)`

All amounts are positive atomic `BIGINT` values. Debit-normal account balance is debits minus credits. Credit-normal account balance is credits minus debits.

Posted transactions and entries are immutable after posting through both application rules and PostgreSQL permissions/triggers. The application posting role has no update/delete permission on posted rows. Database triggers reject update/delete attempts.

Correction = a new reversal transaction plus, when necessary, a new corrected transaction. The original remains posted and unchanged. The reversal uses `reverses_transaction_id`; no original transaction is changed to a reversed status.

Example accounts:

```text
USER_PENDING_LIABILITY
USER_AVAILABLE_LIABILITY
USER_RESERVED_LIABILITY
PLATFORM_REWARD_EXPENSE
REFERRAL_REWARD_EXPENSE
TASK_REWARD_EXPENSE
WITHDRAWAL_FEE_REVENUE
AD_REVENUE
AD_NETWORK_RECEIVABLE
HOT_WALLET_USDT_ASSET
HOT_WALLET_TON_ASSET
TREASURY_FUNDING_CLEARING
TON_NETWORK_FEE_EXPENSE
SUPPORT_COMPENSATION_EXPENSE
INVALID_TRAFFIC_RECOVERY
EXPLICIT_PLATFORM_LOSS
```

Reward example:

```text
DR Platform Reward Expense      0.000500
CR User Pending Liability       0.000500
```

Maturity:

```text
DR User Pending Liability       0.000500
CR User Available Liability     0.000500
```

Withdrawal reserve:

```text
DR User Available Liability     0.50
CR User Reserved Liability      0.50
```

Pre-broadcast rejection/release:

```text
DR User Reserved Liability      0.50
CR User Available Liability     0.50
```

Confirmed payout example:

```text
Requested: 0.50
Fee:       0.01
Net:       0.49

DR User Reserved Liability      0.50
CR Hot Wallet USDT Asset        0.49
CR Withdrawal Fee Revenue       0.01
```

Withdrawal fee revenue is recognized only on confirmed payout. A rejected pre-broadcast withdrawal returns the entire gross reservation.

TON gas separately:

```text
DR TON Network Fee Expense
CR Hot Wallet TON Asset
```

Owner Hot Wallet funding:

```text
DR Hot Wallet Asset
CR Treasury Funding Clearing
```

The final accounting classification of `TREASURY_FUNDING_CLEARING` requires an explicit accounting decision before production financial reporting.

Posting operation requirements:

1. resolve all accounts and asset;
2. lock `ledger_account_balances` rows in deterministic account-ID order;
3. enforce business-reference and idempotency uniqueness;
4. verify all accounts use the transaction asset;
5. verify debit total equals credit total;
6. ensure protected user Pending/Available/Reserved balances cannot become negative;
7. insert immutable transaction and entries;
8. update current balance projections;
9. insert related domain and Outbox rows;
10. commit atomically.

Reconciliation independently rebuilds current projections from all immutable entries and compares them with `ledger_account_balances`. A mismatch is Critical and pauses relevant financial operations.

---

# 25. FINANCIAL API REPRESENTATION

Example:

```json
{
  "asset": "USDT",
  "amountAtomic": "200000",
  "decimals": 6,
  "display": "0.200000"
}
```

Never expose atomic amount as JS number.

---

# 26. WALLET CONNECTION

Use TON Connect.

ALEx Rewards never receives user private key/seed.

---

# 27. TON_PROOF OWNERSHIP VERIFICATION

Flow:

1. backend generates cryptographically unpredictable nonce;
2. short TTL;
3. single-use;
4. client asks wallet for `ton_proof`;
5. wallet signs;
6. client sends account + proof;
7. backend validates expected domain;
8. timestamp/clock skew validation;
9. nonce binding/expiry validation;
10. wallet public key/state verification;
11. separately validate that the declared TON network is accepted by this environment, because `ton_proof` does not itself bind the network;
12. atomically consume nonce;
13. mark wallet verified for the validated account/network.

Replay fails.

---

# 28. USER WALLET TABLE

```text
user_wallets
```

Fields:

```text
id
user_id
chain
network_id
raw_address
friendly_address
wallet_name
is_primary
verified
verification_method
verified_at
created_at
last_used_at
disabled_at
```

Never store user private keys.

---

# 29. WALLET CHANGE SECURITY

When primary wallet changes:

1. new TON Proof;
2. old wallet stays in history;
3. security event;
4. invalidate pending old challenges;
5. begin withdrawal cooldown.

Default: **24 hours**.

---

# 30. WALLET ROLES

```text
User Wallet
ALEx Rewards Hot Payout Wallet
Owner Treasury Wallet
```

---

# 31. OWNER TREASURY

Treasury:

- Owner-controlled;
- can be Tonkeeper;
- majority of funds;
- no backend signing access;
- no seed/private key on server;
- manually replenishes Hot Wallet.

---

# 32. HOT PAYOUT WALLET

Dedicated only to user payouts.

Holds:

- USDT Jetton;
- TON for gas.

Keep limited operational reserve to reduce compromise blast radius.

---

# 33. HOT WALLET CONTRACT

Target: **TON Wallet V5 R1**.

V1 does not batch multiple user payouts even if wallet technically supports multi-send.

One withdrawal -> one traceable payout workflow.

---

# 34. HOT WALLET SIGNER

## 34.1 Preferred target

Separate `apps/signer` security boundary using an AWS KMS non-exportable Ed25519 key.

Desired:

- private material stays in KMS;
- only the signer service task role has `kms:Sign` for the exact key;
- API, bot, Admin, general Temporal workers and payout dispatcher have no `kms:Sign` permission;
- no seed in repo/frontend/database.

The worker sends only an authenticated internal `withdrawal_attempt_id`. The signer does not trust caller-supplied recipient, amount, asset, wallet, query ID or message bytes. It independently loads a restricted read-only signing view and verifies:

1. approved withdrawal and immutable approval history;
2. current state permits signing and no hold/rejection exists;
3. active Hot Wallet and exact KMS key version;
4. verified recipient wallet snapshot;
5. gross, fee and net atomic amounts;
6. network, asset and allowlisted Jetton master;
7. active attempt, expected seqno, `valid_until` and unique query ID;
8. configured single/hourly/daily safety limits and circuit breakers;
9. canonical message bytes and hash recomputed inside the signer.

The signer has restricted read-only database access, no financial mutation permission, no public ingress, and no TON RPC/broadcast capability. Internal calls use private networking and workload authentication/mTLS. Repeated calls for one attempt may sign only the identical canonical message.

## 34.2 Mandatory KMS compatibility spike

Do not assume compatibility solely because TON and KMS support Ed25519.

Before mainnet:

1. create test KMS Ed25519 key;
2. retrieve public key;
3. derive/create exact Wallet V5 R1 state;
4. build signed external message bytes;
5. call KMS signing correctly;
6. verify signature locally;
7. broadcast Testnet transaction;
8. confirm wallet accepts;
9. repeat;
10. test seqno;
11. crash before persistence;
12. crash after broadcast;
13. reconcile;
14. repeat with Jetton transfer.

## 34.3 Fallback signer

If KMS mode is proven technically unsuitable:

- dedicated signing service;
- dedicated mnemonic;
- envelope encrypted;
- Secrets Manager;
- decrypt only in signer memory;
- no logs;
- restricted network/IAM;
- no DB mutation capability.

The fallback must preserve the same independent policy-validation boundary. It must not return signing permission to the general payout worker.

---

# 35. PAYOUT WORKER SECURITY

Signer permission:

```text
Mini App       NO
Admin Frontend NO
Normal API     NO
Telegram Bot   NO
Payout Worker  NO
General Worker NO
Signer Service YES
```

The signer service can sign only the canonical message for an independently validated active withdrawal attempt. Owner Treasury has no application signing path.

---

# 36. HOT WALLET MONITORING

Admin shows:

```text
USDT Balance
TON Gas Balance
Reserved Withdrawals
Required Liquidity
Coverage Ratio
Last Chain Sync
Status
```

Alert on:

- low USDT;
- low TON;
- low coverage;
- unexpected outgoing transfer;
- mismatch;
- stale sync.

---

# 37. WITHDRAWAL RULES

Minimum initial request: **0.20 USDT before fee**.

Fee paid by user from the gross requested amount.

Fee engine supports:

- fixed fee;
- percentage fee;
- minimum fee;
- maximum fee.

All fee calculations use integer atomic units. V1 fixed-fee arithmetic requires no division. Any future percentage fee must define and version its integer rounding rule before it can be enabled; floating-point fee arithmetic is prohibited.

V1 starts with a fixed **0.01 USDT** fee. The rule is immutable/versioned per quote and remains Admin-configurable.

Before confirm show:

```text
Requested Amount
Withdrawal Fee
Net Amount
Network: TON
Asset: USDT
Destination
Quote Expiry
```

If net <= 0 -> reject.

---

# 38. WITHDRAWAL LIMITS

All limits are measured using the gross requested amount before fee and are immutable/versioned per effective configuration.

| Limit | Initial value |
|---|---:|
| `MIN_WITHDRAWAL` | 0.20 USDT gross |
| `MAX_SINGLE_WITHDRAWAL` | 5 USDT gross |
| `MAX_USER_HOURLY_WITHDRAWAL` | 5 USDT gross |
| `MAX_USER_DAILY_WITHDRAWAL` | 10 USDT gross per UTC day |
| `MAX_HOT_WALLET_HOURLY_VOLUME` | 25 USDT gross |
| `MAX_HOT_WALLET_DAILY_VOLUME` | 100 USDT gross per UTC day |
| `MAX_AUTO_PAYOUT` | Not enabled/approved for initial launch |

Beta values conservative and increased only after production evidence.

---

# 39. WITHDRAWAL STATE MACHINE

Quote lifecycle is separate from the withdrawal row:

```text
DRAFT -> QUOTED
QUOTED -> CANCELLED | EXPIRED | REQUESTED
```

The withdrawal row is created at `REQUESTED`, in the same PostgreSQL transaction that consumes the quote and moves the gross amount Available -> Reserved. Ordinary user cancellation is not supported after this point.

Allowed withdrawal transitions:

```text
REQUESTED -> RISK_CHECK
RISK_CHECK -> MANUAL_REVIEW | HELD | REJECTED
RISK_CHECK -> APPROVED only under a future explicitly enabled auto-payout policy
MANUAL_REVIEW -> APPROVED | HELD | REJECTED
APPROVED -> QUEUED | HELD
HELD -> MANUAL_REVIEW | APPROVED | REJECTED
QUEUED -> SIGNING | HELD
SIGNING -> BROADCASTING | FAILED_PRE_BROADCAST
FAILED_PRE_BROADCAST -> QUEUED | HELD | REJECTED
BROADCASTING -> BROADCASTED | RECONCILE_REQUIRED
BROADCASTED -> CONFIRMING | RECONCILE_REQUIRED
CONFIRMING -> CONFIRMED | RECONCILE_REQUIRED
RECONCILE_REQUIRED -> CONFIRMED | QUEUED | HELD
```

`REJECTED` is permitted only when non-payment is definitively known. The transition to `REJECTED` atomically moves the full gross amount Reserved -> Available. `APPROVED -> HELD -> REJECTED` is permitted before any possible broadcast.

A `HELD` withdrawal that originated from `RECONCILE_REQUIRED` cannot transition to `APPROVED` or `REJECTED` until reconciliation records definitive non-payment. Without that proof it remains held or returns to reconciliation; it cannot enter a fresh signing path.

Once broadcasting may have begun, any timeout, crash, transport error, unknown result, incomplete trace, bounce ambiguity or provider disagreement goes to `RECONCILE_REQUIRED`. Reserved funds remain untouched. A new transfer may not be created unless reconciliation definitively proves non-payment and retry safety.

Terminal withdrawal states are `CONFIRMED` and `REJECTED`. `HELD`, `FAILED_PRE_BROADCAST`, and `RECONCILE_REQUIRED` are visible, auditable, nonterminal operational states.

---

# 40. WITHDRAWAL CREATION ATOMIC TRANSACTION

Inside one PostgreSQL transaction:

1. lock required user financial rows;
2. re-read Available;
3. validate gross requested amount and initial/configured fee;
4. validate minimum;
5. validate maximum;
6. validate primary wallet;
7. verify wallet proof status;
8. enforce wallet-change cooldown;
9. enforce account withdrawal status;
10. enforce gross hourly/daily user and Hot Wallet limits;
11. enforce idempotency;
12. create withdrawal;
13. Available -> Reserved through ledger;
14. audit/domain event;
15. Outbox event;
16. commit.

All or nothing.

The consumed withdrawal quote preserves wallet, gross amount, fee, net amount, network, asset, fee-rule version and expiry. Net must be greater than zero.

## 40.1 `WithdrawalRiskPolicy` V1

Withdrawal creation and workflow code depend on a versioned `WithdrawalRiskPolicy` interface rather than hardcoded score checks.

Inputs include withdrawal/user/wallet identifiers, gross/net amount, account and wallet age, cooldown state, current risk snapshot, relevant flags, prior payout history and policy version. Outputs are immutable decisions with safe reason codes:

```text
MANUAL_REVIEW
HELD
REJECTED_PRE_BROADCAST
WITHDRAWAL_BLOCKED
```

V1 is deterministic and never auto-approves: LOW proceeds to manual review; MEDIUM may extend Pending/manual review; HIGH enters manual review or hold; CRITICAL blocks withdrawal pending Owner review. The later Fraud Engine supplies richer versioned snapshots through the same interface. No single score causes an automated permanent ban.

---

# 41. INITIAL MANUAL APPROVAL

At launch withdrawals require Owner approval according to configured policy.

Owner can approve from:

- Admin Dashboard;
- private Telegram Control Center.

Both call the same backend command.

---

# 42. FUTURE AUTO-PAYOUT

Potential eligibility:

- account age;
- low risk;
- previous confirmed payouts;
- wallet age;
- no wallet cooldown;
- amount <= auto threshold;
- no fraud flags;
- system healthy;
- Hot Wallet liquid.

Auto payout is feature-flagged and can be paused instantly.

---

# 43. PAYOUT DISPATCHER

One logical dispatcher per Hot Wallet controls outgoing sends and seqno ordering.

Exclusivity is enforced by a database-backed `hot_wallet_dispatch_leases` row containing a fencing token and expiry. A stale worker holding an old fencing token cannot create or advance an attempt.

Future multiple Hot Wallets each get independent dispatcher.

---

# 44. BLOCKCHAIN CORRELATION

Every withdrawal has public ID such as `WD-001294`.

Use a non-sensitive unique transfer correlation identifier where supported, such as Jetton `query_id`.

Never put PII on-chain.

---

# 45. MOST IMPORTANT PAYOUT RULE

> If broadcast outcome is uncertain, never blindly send again.

If chain may have accepted a payment but process crashed, move to `RECONCILE_REQUIRED` and investigate chain/seqno.

Seqno advancement alone neither proves the intended Jetton payment nor permits confirmation. Reconciliation must match the full intended transfer semantics.

---

# 46. WITHDRAWAL ATTEMPTS

Use immutable attempts:

```text
withdrawal_attempts
```

Fields include:

```text
id
withdrawal_id
attempt_number
wallet_id
expected_seqno
signing_started_at
broadcast_started_at
provider_response
broadcast_result_state
chain_reference
created_at
```

---

# 47. BLOCKCHAIN CONFIRMATION

`BROADCASTED != CONFIRMED`.

`CONFIRMED` means observers have proven a successful intended TEP-74 Jetton transfer matching the withdrawal's Hot Wallet, recipient, atomic net amount, allowlisted USDT Jetton master, attempt and unique query/correlation ID. Wallet seqno advancement, external-message inclusion, or an RPC broadcast acknowledgment alone is insufficient.

Only after that confirmed observation:

- mark confirmed;
- finalize Reserved liability;
- record actual payout;
- record actual network fee if available;
- trigger payout publications.

Use primary and secondary chain data providers for ambiguous cases.

---

# 48. RECONCILIATION

## Withdrawal reconciliation

Compare:

- withdrawal state;
- attempt;
- expected seqno;
- chain transaction;
- recipient;
- Jetton amount;
- correlation ID;
- confirmation state.

## Hot Wallet reconciliation

Compare ledger expected Hot Wallet assets vs on-chain USDT/TON, known funding, known payouts, actual fees.

## Provider reconciliation

Compare provider reporting vs ad sessions, rewards, estimated/accrued revenue and provider payout statements.

Discrepancy creates `reconciliation_issue`.

Never silently edit ledger to force a match.

After every database restore, payout dispatch starts `PAUSED`. Before it can resume, reconciliation must compare restored withdrawal/workflow/attempt/Outbox state with blockchain transactions, Hot Wallet assets, immutable ledger entries and current projections. Any unresolved ambiguity keeps dispatch paused.

---

# 49. CIRCUIT BREAKERS

Automatically pause payout dispatch on severe conditions:

- ledger invariant failure;
- duplicate payout suspicion;
- signer failure;
- unresolved chain state;
- Hot Wallet mismatch;
- severe withdrawal spike;
- low gas;
- low USDT;
- chain provider disagreement;
- reconciliation backlog.

Reserved balances remain intact.

---

# 50. PUBLIC PAYOUT LOGS

Public channel: **ALEx Rewards | Payout Logs**.

Publish only at `CONFIRMED`.

Message example:

```text
✅ Withdrawal Confirmed

👤 @username OR Anonymous User
💰 0.490000 USDT
🌐 TON
🧾 WD-001294
📅 02 Sep 2026

[View Transaction]
```

User privacy:

```text
SHOW_USERNAME
HIDE_IDENTITY
```

Do not show full wallet address in message.

---

# 51. PAYOUT PUBLICATION IDEMPOTENCY

```text
payout_publications
```

Constraint:

```text
UNIQUE(withdrawal_id, destination_id)
```

Store Telegram message ID, status, errors, retries.

---

# 52. OFFICIAL PUBLIC CHANNEL

**ALEx Rewards Official**

For announcements, promotions, maintenance, competitions, product updates.

Keep Payout Logs focused on proof of payments.

---

# 53. PRIVATE ADMIN CONTROL CENTER

Telegram Supergroup: **ALEx Rewards | Control Center**.

Forum Topics:

1. ✅ Approvals
2. 💸 Payouts
3. ⚠️ Warnings
4. 🚨 Critical
5. 🛡 Fraud
6. 💰 Wallet
7. 📺 Ads
8. 📊 Reports
9. 🎫 Support
10. 🧾 Audit
11. 🖥 System

Persist chat/topic thread IDs in configuration/database.

---

# 54. APPROVALS TOPIC

Example:

```text
🟡 Withdrawal Approval Required

🧾 WD-001294
👤 @username
💰 Requested: 0.500000 USDT
💳 Fee: 0.010000 USDT
✅ Net: 0.490000 USDT
🌐 TON
📮 Wallet: UQBx...81KA

Available before request: ...
Account age: ...
Valid ads: ...
Previous confirmed withdrawals: ...
Risk: LOW
Requested: ...
```

Buttons:

- Approve
- Hold
- Reject
- View User

---

# 55. TELEGRAM ADMIN ACTION SECURITY

Group membership is not authorization.

Validate:

- Telegram actor ID;
- Owner allowlist;
- DB admin role;
- permission;
- one-time action token;
- resource;
- expected current state;
- expiry;
- nonce;
- second confirmation when required.

V1 Owner Telegram ID only.

---

# 56. ADMIN ACTION TOKENS

Store:

```text
token_id
actor_admin_id
action
resource_type
resource_id
expected_state
expires_at
consumed_at
nonce
```

Callback contains opaque identifier, not trusted money fields.

---

# 57. DOUBLE-CLICK / RETRY

First valid approval transitions once.

Later duplicates return `Already processed` and cannot start a second payout.

---

# 58. SECOND CONFIRMATION ACTIONS

Require confirmation for:

- permanent ban;
- large adjustment;
- reject unusually large withdrawal;
- Hot Wallet change;
- pause/resume payouts;
- significant reward rule change;
- auto-payout enablement;
- role/key rotation.

---

# 59. PAYOUTS TOPIC

Internal confirmed message may include:

```text
Withdrawal ID
User
Amount sent
Fee
Network
Attempt
Requested/Approved/Broadcast/Confirmed timestamps
Duration
Network fee
Explorer link
```

---

# 60. WARNINGS TOPIC

Examples:

- low Hot Wallet;
- low TON;
- fill-rate degradation;
- provider errors;
- worker delay;
- reconciliation backlog.

Deduplicate and rate-limit.

---

# 61. CRITICAL TOPIC

Only severe events:

- ledger imbalance;
- duplicate payout suspicion;
- unexpected outgoing Hot Wallet transaction;
- signer compromise/unavailability;
- DB critical failure;
- unresolved chain ambiguity;
- severe financial mismatch.

Critical -> Topic + Owner DM + monitoring alert.

---

# 62. FRAUD TOPIC

Show risk score, key signals, associated withdrawal and safe actions:

- Hold Withdrawal
- Freeze Withdrawals
- Open User
- Mark Safe

Do not expose exact fraud formula publicly.

---

# 63. WALLET TOPIC

Messages:

- low USDT;
- low TON;
- coverage warning;
- unexpected chain activity;
- funding detected;
- reconciliation mismatch.

---

# 64. ADS TOPIC

Provider health:

```text
Requests
Loaded
Completed
No Fill
Fill Rate
Completion Rate
Estimated Revenue
Reward Spend
Estimated Margin
Errors
Routing Status
```

---

# 65. DAILY REPORT

Includes:

### Users
- total
- new
- DAU
- returning

### Ads
- requests
- loads
- completions
- no fill
- fill rate
- provider health

### Finance
- estimated/accrued provider revenue
- user rewards
- referral rewards
- task bonuses
- withdrawal fee revenue
- network fees
- estimated margin

### Withdrawals
- requested
- approved
- confirmed
- held
- rejected
- total value

### Fraud
- flags
- held withdrawals
- critical alerts

### Wallet
- USDT
- TON
- liabilities
- coverage

### System
- API
- DB
- Redis
- Temporal
- Bot
- chain providers

---

# 66. ADMIN AUTHENTICATION

Independent from user Telegram authentication.

Use:

- Passkey/WebAuthn primary;
- password + TOTP fallback;
- recovery codes;
- secure cookie;
- idle timeout;
- absolute session timeout;
- sensitive-action re-authentication.

TOTP alone is never a complete authentication method. High-impact financial settings/actions require recent reauthentication. Passkey RP ID, password policy, session lifetimes, reauthentication window and recovery custody must be finalized before production.

V1 = one Owner.

---

# 67. RBAC

Prepare:

```text
OWNER
FINANCE
SUPPORT
FRAUD_ANALYST
CAMPAIGN_MANAGER
```

V1 only OWNER enabled.

---

# 68. AUDIT LOG

Append-only fields:

```text
id
admin_id
action_type
resource_type
resource_id
before_snapshot
after_snapshot
reason
source
ip
user_agent
trace_id
created_at
```

Redact secrets.

---

# 69. ADMIN DASHBOARD OVERVIEW

Top cards:

- Revenue Today
- User Rewards Today
- Estimated Gross Margin
- Available User Liabilities
- Reserved Withdrawal Liabilities
- Pending Withdrawals
- Hot Wallet USDT
- Hot Wallet TON
- Coverage Ratio
- DAU
- Valid Ads
- Fraud Alerts

Charts:

- revenue vs rewards vs margin;
- DAU;
- fill rate;
- completion rate;
- withdrawals;
- country/provider performance.

---

# 70. USERS ADMIN PAGE

Columns:

```text
Telegram ID
Username
Locale
Country
Pending
Available
Reserved
Lifetime Earned
Valid Ads
Active Referrals
Risk
Withdrawal Status
Account Status
Last Active
```

---

# 71. USER DETAIL PAGE

Tabs:

1. Overview
2. Ledger
3. Rewards
4. Ads
5. Withdrawals
6. Wallets
7. Referrals
8. Risk
9. Security
10. Support
11. Audit

Actions:

- freeze/unfreeze withdrawals;
- suspend;
- mark trusted;
- mark safe;
- ledger-based adjustment;
- reset specific limit with reason.

No direct balance editor.

---

# 72. REWARD ENGINE ADMIN

Controls:

- provider;
- country group;
- user share;
- estimated eCPM;
- safety factor;
- min reward;
- max reward;
- effective time;
- enabled.

Every change = new version.

---

# 73. WITHDRAWAL SETTINGS

Controls:

- minimum withdrawal;
- fee;
- max single;
- user daily max;
- wallet cooldown;
- auto-payout flag;
- auto-payout max;
- risk thresholds;
- manual review thresholds;
- payout pause.

Financial settings require audit + confirmation.

---

# 74. HOT WALLET ADMIN PAGE

Display only:

- address;
- wallet version;
- signer type;
- USDT;
- TON;
- last chain sync;
- reserved payouts;
- coverage;
- status.

Never display private key or seed.

---

# 75. FINANCIAL COVERAGE

Track:

```text
withdrawable_user_liabilities
reserved_withdrawal_liabilities
hot_wallet_usdt
```

Coverage ratio example:

```text
hot_wallet_usdt / (available_user_liabilities + reserved_withdrawal_liabilities)
```

Target configurable. Alert before dangerous shortage.

Initial Hot Wallet USDT operational thresholds:

```text
target_reserve = 50 USDT
warning = 20 USDT
critical = 10 USDT
```

The mainnet micro-launch still begins with only approximately 5-10 USDT plus TON gas. The 50 USDT target is an operating target for later controlled operation, not an instruction to increase micro-launch exposure.

---

# 76. FRAUD ENGINE PRINCIPLES

Risk is multi-signal.

Never implement `VPN = fraud`.

Signals may include:

- account age;
- behavior;
- country changes;
- proxy/VPN reputation;
- wallet relationships;
- withdrawal velocity;
- wallet changes;
- repeated timing patterns;
- ad completion timing;
- referral graph;
- device/client characteristics;
- many accounts using one payout wallet.

Respect data minimization.

---

# 77. RISK SCORE

Normalized `0-100`.

Initial bands:

```text
0-20 LOW
21-50 MEDIUM
51-75 HIGH
76-100 CRITICAL
```

Configurable.

Store score, rule version, reasons/signals, computed timestamp.

Initial actions:

| Tier | V1 action |
|---|---|
| LOW | Normal reward handling; withdrawals still follow mandatory V1 manual approval |
| MEDIUM | Extended Pending and manual review where applicable |
| HIGH | Manual withdrawal review or hold |
| CRITICAL | Block withdrawal pending Owner review |

No single V1 score or weak signal may create an automated permanent ban.

---

# 78. FRAUD ACTIONS

Possible:

- allow;
- extend pending hold;
- manual review;
- withdrawal block;
- suspend earning;
- freeze account;
- future KYC request.

Every adverse automated action must be auditable.

---

# 79. REFERRAL V1

Level 1 only.

Deep link:

```text
t.me/<bot>?start=ref_<code>
```

No self-referral.

Referral attribution is one-time and cannot be swapped later.

By default, Referral V1 applies only to eligible matured ad rewards. Every reward source exposes an immutable/versioned `referral_eligible` value.

---

# 80. REFERRAL ACTIVATION

Default:

```text
account age >= 24h
AND at least 5 valid rewarded ads
AND no critical fraud flags
```

Configurable.

---

# 81. REFERRAL REWARD

Percentage configurable by Owner.

Initial placeholder: **5%**, not hardcoded.

Invitee reward is never reduced.

Referrer bonus is separate platform-funded expense.

Referral reward starts Pending and matures only after originating reward is safe.

Referral arithmetic uses integer-only `FLOOR`. Reversal of the originating reward reverses an unpaid or maturing referral reward through a new linked ledger transaction. It never mutates the original referral transaction or creates a hidden negative balance.

---

# 82. REFERRAL FRAUD

Detect:

- wallet reuse;
- suspicious client clusters;
- mass rapid registrations;
- impossible velocity;
- abnormal earning patterns;
- network relationships.

The same payout wallet appearing across multiple accounts is a fraud signal for review, not an automatic ban.

---

# 83. TASKS V1

Basic platform tasks:

- Daily Login
- Complete 3 valid rewarded ads
- Complete 10 valid rewarded ads
- Streak milestone

Any monetary task reward uses Reward Engine + Ledger.

---

# 84. LEVELS — LATER

Future:

- Bronze
- Silver
- Gold
- Diamond

Benefits may include badge, competition access, shorter pending, small configured perks.

No unsustainable multipliers.

---

# 85. WEEKLY LEAGUE — LATER

Score combines legitimate engagement:

- valid ads;
- tasks;
- streaks;
- achievements.

Daily provider limits still apply.

---

# 86. LUCKY WHEEL — LATER

Free daily spin only.

No paid spins or money wagering.

Potential rewards:

- XP;
- small bonus;
- promo points.

Expected cost must be configured and auditable.

---

# 87. SPONSORED TASKS — PHASE 2

Future:

- join Telegram channel;
- start Telegram bot;
- open Mini App;
- visit approved website;
- custom verified action.

Separate from AdsGram rewarded ads.

Campaign economics:

```text
Advertiser Budget
User Reward
Platform Fee/Margin
Reserved Campaign Budget
```

Never overspend campaign budget.

---

# 88. ADVERTISER PORTAL — LATER

Not V1.

Future:

- advertiser account;
- balance;
- campaign creation;
- targeting;
- budget;
- analytics;
- pause/resume;
- billing history.

V1 sponsored campaigns can be Admin-created only.

---

# 89. SUPPORT SYSTEM

Mini App contains Support.

States:

```text
OPEN
WAITING_USER
WAITING_SUPPORT
RESOLVED
CLOSED
```

Support can view safe context such as withdrawal ID, ad session, recent app version.

High-risk tickets may appear in Control Center Support topic.

---

# 90. NOTIFICATIONS

Channels:

- In-App
- Telegram Bot DM
- Admin Control Center
- Email later

Types:

- withdrawal requested;
- approved;
- confirmed;
- rejected;
- wallet changed;
- security event;
- reward matured;
- new task;
- promo;
- maintenance.

Persist delivery state and retry via Outbox.


# 91. CORE DATABASE TABLES

The final physical schema may normalize some fields, but Codex must preserve the business semantics below.

## 91.0 `networks` and `assets`

`networks` identifies TON Testnet/Mainnet and their accepted global/network identifiers per environment.

`assets` identifies an asset by network, canonical contract identity, decimals and status. The allowlisted mainnet USDT Jetton master is deployment-controlled and cannot be selected by a client. Financial tables reference `asset_id`, not a free-form user-supplied token master.

## 91.1 `users`

Suggested fields:

```text
id UUIDv7 PK
telegram_user_id BIGINT UNIQUE NOT NULL
username TEXT NULL
first_name TEXT NULL
last_name TEXT NULL
telegram_language_code TEXT NULL
preferred_locale TEXT NOT NULL DEFAULT 'en'
country_code TEXT NULL
status USER_STATUS NOT NULL
withdrawal_status WITHDRAWAL_ACCESS_STATUS NOT NULL
risk_tier RISK_TIER NOT NULL DEFAULT 'LOW'
created_at TIMESTAMPTZ NOT NULL
updated_at TIMESTAMPTZ NOT NULL
last_active_at TIMESTAMPTZ NULL
anonymized_at TIMESTAMPTZ NULL
```

Do not use Telegram username as identity. Telegram ID is the provider identity after signature validation.

## 91.2 `user_profiles`

Non-financial profile metadata only.

## 91.3 `user_settings`

Suggested:

```text
user_id PK/FK
locale
public_payout_identity_mode
marketing_notifications_enabled
security_notifications_enabled
updated_at
```

Security-critical notifications may not be disabled where policy requires them.

## 91.4 `user_sessions`

```text
id
user_id
refresh_token_hash/session_secret_hash
created_at
last_seen_at
expires_at
revoked_at
ip_hash_or_safe_network_metadata
user_agent_summary
```

Never store raw long-lived bearer tokens.

---

# 92. AD DATABASE TABLES

## 92.1 `ad_providers`

```text
id
code UNIQUE
name
status
capabilities_json
policy_reviewed_at
policy_reference
created_at
updated_at
```

## 92.2 `ad_units`

```text
id
provider_id
provider_block_id
placement_code
format
status
config_json
created_at
```

Never expose secret provider configuration to client if not required by provider SDK.

## 92.3 `ad_sessions`

Suggested fields:

```text
id
user_id
provider_id
ad_unit_id
state
reward_quote_id
utc_day DATE
provider_request_counted BOOLEAN
successful_reward_counted BOOLEAN
started_at
client_completed_at
provider_confirmed_at
verified_at
rewarded_at
expires_at
failure_code
created_at
updated_at
```

Constraints:

- max one reward event per session;
- partial unique/index logic ensuring one active session per user/provider where feasible;
- state transitions enforced in domain logic and guarded in DB update predicates.

## 92.4 `ad_client_events`

For debugging/forensics, with retention policy.

```text
id
ad_session_id
event_type
safe_payload_json
created_at
```

Do not let these events directly credit money.

## 92.4A `ad_session_signals`

Append-only, monotonic evidence:

```text
id
ad_session_id
source CLIENT/PROVIDER/SYSTEM
signal_type
provider_event_id NULL
occurred_at NULL
received_at
authenticity_status UNVERIFIED/VERIFIED/REJECTED
correlation_status UNCORRELATED/CORRELATED/AMBIGUOUS/REJECTED
safe_payload_hash
safe_payload_redacted
inbox_event_id NULL
created_at
```

Signals never directly post money. Aggregate session state is derived from these records and domain decisions.

## 92.5 `ad_provider_events`

```text
id
provider_id
provider_event_id NULL
telegram_user_id NULL
normalized_event_type
raw_payload_redacted
received_at
processed_at
processing_status
correlated_ad_session_id NULL
```

Where provider has a unique event ID, enforce provider/event uniqueness.

## 92.6 `ad_daily_counters`

Authoritative DB-backed daily counters:

```text
user_id
provider_id
utc_day
provider_requests
successful_rewards
updated_at
PRIMARY KEY(user_id, provider_id, utc_day)
```

Use atomic SQL increments/locking.

---

# 93. REWARD DATABASE TABLES

## 93.1 `reward_rules`

As defined earlier; immutable version semantics.

## 93.2 `reward_quotes`

```text
id
user_id
source_type
source_id
provider_id NULL
asset_id
amount_atomic BIGINT
rule_version
expires_at
consumed_at
created_at
```

## 93.3 `reward_events`

```text
id
user_id
source_type
source_id
asset_id
amount_atomic
state
ledger_transaction_id
rule_version
pending_until
available_at
reversed_at
reversal_ledger_transaction_id NULL
created_at
```

Unique source semantics must prevent duplicate reward from same ad/task/referral event.

## 93.4 `reward_maturities`

May be explicit table or derived scheduling table depending chosen implementation, but maturity must be resumable and idempotent.

## 93.5 `reward_budget_periods`

Authoritative per-rule/provider/country/global atomic budgets and consumed/reserved projections for an explicit UTC period.

## 93.6 `reward_budget_reservations`

One reservation per quote. State is `ACTIVE`, `RELEASED`, or `CONSUMED`. State changes, quote changes and budget-period projections commit atomically and are idempotent.

---

# 94. LEDGER DATABASE TABLES

## 94.1 `ledger_accounts`

```text
id
owner_type         -- USER / PLATFORM / WALLET / PROVIDER
owner_id NULL
account_type
account_class
normal_side
asset_id
status
created_at
UNIQUE NULLS NOT DISTINCT(owner_type, owner_id, account_type, asset_id)
```

## 94.2 `ledger_transactions`

```text
id
transaction_type
business_reference_type
business_reference_id
idempotency_scope
idempotency_key
asset_id
reverses_transaction_id NULL
metadata_json
posted_at
created_by_type
created_by_id NULL
```

Original posted transactions are never assigned a reversed status. Reversals are new posted transactions linked through `reverses_transaction_id`.

## 94.3 `ledger_entries`

```text
id
ledger_transaction_id
ledger_account_id
direction DEBIT/CREDIT
amount_atomic BIGINT CHECK amount_atomic > 0
created_at
```

No update/delete after posting through application role.

## 94.4 `ledger_account_balances`

```text
ledger_account_id PK
balance_atomic BIGINT
version BIGINT
last_ledger_transaction_id
updated_at
```

Updated in the same transaction as entries, lockable for concurrency, and fully rebuildable from immutable entries.

## 94.5 `ledger_balance_snapshots`

Performance projection only.

Must be rebuildable from ledger entries.

Use explicit reconciliation against full ledger periodically.

---

# 95. WITHDRAWAL DATABASE TABLES

## 95.0 `withdrawal_fee_rules`

Immutable/versioned fixed, percentage, minimum and maximum fee rules. V1 initially uses a fixed 0.01 USDT fee.

## 95.1 `withdrawal_quotes`

```text
id
user_id
asset_id
network_id
requested_amount_atomic
fee_amount_atomic
net_amount_atomic
primary_wallet_id
fee_rule_version
status OPEN/CONSUMED/CANCELLED/EXPIRED
expires_at
consumed_at
created_at
```

`DRAFT`, `QUOTED`, `CANCELLED`, and `EXPIRED` are quote-lifecycle concepts. A withdrawal row is created only when a valid quote is consumed and gross funds are atomically reserved.

## 95.2 `withdrawals`

```text
id
public_id UNIQUE
user_id
asset_id
network_id
wallet_id
requested_amount_atomic
fee_amount_atomic
net_amount_atomic
state
risk_snapshot_id NULL
approval_policy_version
idempotency_key
workflow_id NULL
requested_at
approved_at NULL
broadcasted_at NULL
confirmed_at NULL
held_at NULL
rejected_at NULL
created_at
updated_at
```

Enforce unique quote consumption and unique scoped idempotency. After `REQUESTED`, user cancellation is not supported.

## 95.3 `withdrawal_approvals`

Immutable history:

```text
id
withdrawal_id
decision
admin_id
decision_source WEB/TELEGRAM/AUTO_POLICY
reason NULL
policy_version NULL
created_at
```

## 95.4 `withdrawal_attempts`

Immutable attempt fields include:

```text
id
withdrawal_id
attempt_number
hot_wallet_id
expected_seqno
query_id
valid_until
canonical_message_hash
signed_message_hash NULL
signer_key_reference
dispatch_fencing_token
signing_started_at
broadcast_started_at NULL
provider_response_redacted NULL
broadcast_result_state
chain_reference NULL
created_at
```

Enforce uniqueness for `(withdrawal_id, attempt_number)`, active attempt, and `(hot_wallet_id, query_id)`. Once broadcast may have started, an error cannot be classified as `FAILED_PRE_BROADCAST`.

## 95.5 `blockchain_transactions`

```text
id
network_id
wallet_id
withdrawal_attempt_id
chain_tx_hash_or_reference
seqno_expected
seqno_observed
recipient_address
asset_id
amount_atomic
jetton_master_address
query_id_or_correlation
state
first_seen_at
confirmed_at
raw_chain_summary_json
created_at
```

## 95.6 `hot_wallets`

```text
id
network_id
address
wallet_version
signer_type
signer_reference
status
created_at
retired_at NULL
```

No seed/private-key fields.

## 95.7 `hot_wallet_snapshots`

```text
id
hot_wallet_id
usdt_atomic
ton_atomic
chain_height_or_marker
observed_at
source_provider
```

## 95.8 `chain_observations`

Append-only observations from primary/secondary TON providers including provider, block/trace reference, message hash, seqno, query ID, recipient, Jetton master, amount, execution result and observation time.

## 95.9 `hot_wallet_dispatch_leases`

One lease per Hot Wallet with owner identity, fencing token, acquired/renewed/expiry timestamps. Attempt creation and advancement require the current fencing token.

---

# 96. FRAUD DATABASE TABLES

## 96.0 `risk_rule_versions`

Immutable rule/threshold/action versions with effective time, creator, reason and audit reference.

## 96.1 `risk_profiles`

```text
id
user_id
score
risk_tier
rule_version
calculated_at
```

## 96.1A `risk_snapshots`

Immutable risk decision input/output captured for reward or withdrawal decisions, including rule version, score, tier, safe reason codes and calculation timestamp.

## 96.2 `risk_events`

```text
id
user_id
signal_code
severity
score_delta
safe_details_json
created_at
expires_at NULL
```

## 96.3 `fraud_flags`

```text
id
user_id
flag_type
severity
status OPEN/REVIEWED/DISMISSED/CONFIRMED
created_at
reviewed_at NULL
reviewed_by NULL
```

## 96.4 `wallet_relationships`

Used to identify repeated payout wallets across users without making wallet reuse an automatic ban.

## 96.5 `network_signals`

Use privacy-conscious network metadata, not precise GPS.

---

# 97. REFERRAL TABLES

## 97.1 `referral_codes`

```text
id
user_id UNIQUE
code UNIQUE
created_at
status
```

## 97.2 `referral_edges`

```text
id
referrer_user_id
referred_user_id UNIQUE
code_id
state PENDING/ACTIVE/REJECTED
attributed_at
activated_at NULL
rejected_at NULL
activation_rule_version
```

## 97.3 `referral_reward_events`

Links referrer bonus to originating eligible reward without changing invitee reward.

---

# 98. TASK TABLES

```text
task_definitions
user_task_progress
task_reward_events
```

`task_definitions` must be versioned when reward/evaluation rules change.

---

# 99. ADMIN TABLES

```text
admin_users
roles
permissions
admin_role_bindings
admin_sessions
admin_action_tokens
admin_credentials
admin_recovery_codes
audit_logs
```

`admin_credentials` stores password-verifier and Passkey/WebAuthn credential metadata; secrets are protected appropriately. `admin_recovery_codes` stores only one-way code verifiers and immutable consumption history. TOTP alone is not a full authentication method.

V1 contains one Owner but architecture remains general.

---

# 100. TELEGRAM / SYSTEM TABLES

```text
telegram_destinations
telegram_publications
notifications
notification_deliveries
outbox_events
inbox_events
idempotency_keys
feature_flags
system_config_versions
```

`telegram_destinations` stores:

- environment;
- purpose;
- chat/channel ID;
- topic thread ID where relevant;
- enabled status.

---

# 101. SUPPORT TABLES

```text
support_tickets
support_messages
support_events
```

Support financial compensation never mutates balance directly; it creates a reward/adjustment command -> Ledger.

---

# 102. RECONCILIATION TABLES

```text
reconciliation_runs
reconciliation_items
reconciliation_issues
```

Issue severity:

```text
INFO
WARNING
CRITICAL
```

Critical unresolved financial issue can trigger payout circuit breaker.

---

# 103. IDENTIFIER STRATEGY

Internal primary IDs: UUIDv7 or approved sortable globally unique ID.

Public references:

```text
WD-000001
SUP-000001
CMP-000001
```

Public sequence must not be used as a security boundary.

---

# 104. IDEMPOTENCY STRATEGY

Important mutation commands require an idempotency key or server-generated unique business identity.

Examples:

- withdrawal creation;
- withdrawal confirmation from quote;
- admin approve/hold/reject;
- reward posting;
- wallet-change request;
- provider webhook processing;
- payout publication;
- support adjustment.

Financial idempotency is database-backed.

Idempotency response should return the original business result where safe.

Minimum uniqueness includes scoped command keys and immutable business identities such as reward source, consumed withdrawal quote, approval action, withdrawal attempt/query ID, ledger business reference and payout publication destination. A client timeout followed by retry must return or recover the original committed result rather than repeat the mutation.

---

# 105. TRANSACTIONAL OUTBOX / INBOX

## Outbox

Any DB state transition that must emit an external message writes an Outbox row in the same transaction.

Example payout confirmation transaction:

1. finalize withdrawal;
2. post ledger;
3. create Outbox event `WITHDRAWAL_CONFIRMED`;
4. commit.

Workers then deliver:

- public payout log;
- user notification;
- Admin internal payout log;
- analytics event.

Critical asynchronous side effects are Outbox-driven. A request handler must not depend on a non-transactional direct call to Temporal, Telegram, TON, AdsGram processing, notification delivery or analytics after committing domain state.

Withdrawal approval writes its Outbox row in the approval transaction. The relay starts Temporal using deterministic workflow ID:

```text
withdrawal/{withdrawalId}
```

An already-started workflow with that ID is treated as the original workflow, not a reason to start another payout.

## Inbox

Provider/Telegram callbacks can be stored/normalized in an Inbox-style table before idempotent handling.

---

# 106. USER API CONTRACT OUTLINE

## Auth

```text
POST /v1/auth/telegram
POST /v1/auth/refresh
POST /v1/auth/logout
GET  /v1/auth/sessions
DELETE /v1/auth/sessions/:id
```

## User

```text
GET   /v1/me
GET   /v1/me/balances
GET   /v1/me/transactions
GET   /v1/me/rewards
GET   /v1/me/security
PATCH /v1/me/settings
```

## TON wallet

```text
POST /v1/wallets/ton/proof-challenge
POST /v1/wallets/ton/verify
GET  /v1/wallets
POST /v1/wallets/:id/make-primary
POST /v1/wallets/:id/disable
```

## Ads

```text
GET  /v1/ads/availability
POST /v1/ads/sessions
POST /v1/ads/sessions/:id/client-events
GET  /v1/ads/sessions/:id
```

## Withdrawals

```text
POST /v1/withdrawals/quote
POST /v1/withdrawal-quotes/:id/cancel  -- quote only; no funds reserved
POST /v1/withdrawals
GET  /v1/withdrawals
GET  /v1/withdrawals/:id
```

No user withdrawal-cancel endpoint exists after quote consumption and reservation.

## Referral

```text
GET /v1/referrals/code
GET /v1/referrals/stats
GET /v1/referrals
```

## Tasks

```text
GET  /v1/tasks
POST /v1/tasks/:id/claim
```

## Support

```text
POST /v1/support/tickets
GET  /v1/support/tickets
GET  /v1/support/tickets/:id
POST /v1/support/tickets/:id/messages
```

---

# 106A. V1.2 API CONTRACT EXTENSIONS

User membership endpoints, exact naming may be adjusted without changing semantics:

```text
GET  /v1/membership
GET  /v1/membership/entitlements
POST /v1/membership/founder/claim
```

The claim endpoint requires authenticated Telegram user, rate limiting, atomic single-use claim consumption and audit. It cannot accept trusted benefit values from the client.

Mission endpoints may evolve from the existing Tasks contract while preserving compatibility:

```text
GET  /v1/missions
GET  /v1/missions/:id
POST /v1/missions/:id/claim
```

Admin V1.2 examples:

```text
GET  /admin/v1/memberships
GET  /admin/v1/memberships/:id
POST /admin/v1/founders/grants
POST /admin/v1/founders/claim-codes
POST /admin/v1/memberships/:id/review-reassignment

GET  /admin/v1/providers
GET  /admin/v1/providers/:id
GET  /admin/v1/providers/:id/contracts
POST /admin/v1/providers/:id/contracts
GET  /admin/v1/providers/:id/limits
POST /admin/v1/providers/:id/limit-versions
GET  /admin/v1/providers/:id/certification-runs
GET  /admin/v1/providers/:id/settlements

GET  /admin/v1/economics
GET  /admin/v1/reviews
GET  /admin/v1/policies
GET  /admin/v1/missions
POST /admin/v1/missions
GET  /admin/v1/notification-campaigns
POST /admin/v1/notification-campaigns
```

Every high-impact write uses the same backend authorization/audit/reauthentication model. No Admin API exposes arbitrary SQL/eval, signer material, raw secrets or direct mutable balances.

---

# 107. PROVIDER WEBHOOK CONTRACT

Provider webhooks live in a separate namespace.

Example AdsGram:

```text
GET /webhooks/adsgram/reward
```

Requirements:

- HTTPS;
- strict parameter parsing;
- rate limiting;
- provider-specific validation where available;
- raw payload redaction/minimization;
- Inbox/idempotent processing;
- server-session correlation;
- no direct balance update.

---

# 108. ADMIN API CONTRACT OUTLINE

Namespace:

```text
/admin/v1/*
```

Examples:

```text
GET  /admin/v1/overview
GET  /admin/v1/users
GET  /admin/v1/users/:id
POST /admin/v1/users/:id/freeze-withdrawals
POST /admin/v1/users/:id/unfreeze-withdrawals
POST /admin/v1/users/:id/adjustments

GET  /admin/v1/withdrawals
GET  /admin/v1/withdrawals/:id
POST /admin/v1/withdrawals/:id/approve
POST /admin/v1/withdrawals/:id/hold
POST /admin/v1/withdrawals/:id/reject

GET  /admin/v1/hot-wallet
POST /admin/v1/payouts/pause
POST /admin/v1/payouts/resume

GET  /admin/v1/reward-rules
POST /admin/v1/reward-rules

GET  /admin/v1/fraud
GET  /admin/v1/reconciliation
GET  /admin/v1/audit
GET  /admin/v1/support
```

---

# 109. OPENAPI / CONTRACT GENERATION

NestJS must expose OpenAPI for documented APIs.

Generate typed clients or shared contract types for Mini App/Admin.

Do not maintain duplicate handwritten request/response interfaces that can drift.

Money fields are strings/structured money objects.

---

# 110. FEATURE FLAGS

Minimum:

```text
ADSGRAM_ENABLED
WITHDRAWALS_ENABLED
PAYOUT_DISPATCH_ENABLED
AUTO_PAYOUT_ENABLED
REFERRALS_ENABLED
TASKS_ENABLED
PUBLIC_PAYOUT_LOGS_ENABLED
PROMOS_ENABLED
COMPETITIONS_ENABLED
LEVELS_ENABLED
KYC_ENABLED
SPONSORED_TASKS_ENABLED
```

Flags are environment-specific.

Privileged changes audited.

---

# 111. CONFIGURATION SYSTEM

Do not hardcode product economics.

Examples:

```text
reward_success_daily_limit = 25
adsgram_provider_request_daily_limit = 30
ad_cooldown_seconds = 30 initially
minimum_withdrawal_atomic = 200000 for USDT
initial fixed withdrawal_fee_atomic = 10000 for USDT
max_single_withdrawal_atomic = 5000000 gross
max_user_hourly_withdrawal_atomic = 5000000 gross
max_user_daily_withdrawal_atomic = 10000000 gross
max_hot_wallet_hourly_volume_atomic = 25000000 gross
max_hot_wallet_daily_volume_atomic = 100000000 gross
wallet_change_cooldown_seconds = 86400 initially
new_user_pending_hold_seconds = 86400 initially
referral_percent_bps = 500 placeholder
referral_activation_ads = 5
referral_activation_age_seconds = 86400
risk thresholds
auto payout limits
hot wallet minimums
coverage targets
hot_wallet_target_usdt_atomic = 50000000
hot_wallet_warning_usdt_atomic = 20000000
hot_wallet_critical_usdt_atomic = 10000000
```

Critical configs have safety bounds.

All reward and fee calculations use integer atomic values. Reward and referral division uses `FLOOR` after the complete integer numerator is formed.

---

# 112. CONFIG VERSIONING

Store immutable change versions:

```text
key
old_value
new_value
effective_at
changed_by
reason
version
```

Reward and withdrawal quotes preserve rule version so later config changes do not alter existing valid quotes.

---

# 113. SECURITY — APPLICATION

Use:

- HTTPS only;
- HSTS;
- strict CORS;
- CSP restricted to required Telegram/AdsGram/TON resources;
- secure cookies;
- CSRF protection where applicable;
- schema validation;
- parameterized SQL;
- authorization on every resource;
- rate limits;
- security headers;
- dependency vulnerability scanning.

CSP/frame behavior must be tested in actual Telegram Mini App environment so security settings do not accidentally block legitimate embedding.

---

# 114. SECURITY — SECRETS

Never store secrets in:

- Git;
- frontend bundle;
- Docker image layer;
- logs;
- DB plaintext unnecessarily;
- Telegram messages.

Use:

- Secrets Manager;
- KMS;
- separate IAM roles;
- least privilege.

---

# 115. SECURITY — ADMIN

Owner security:

- Passkey/WebAuthn;
- password + TOTP fallback;
- recovery codes;
- session timeout;
- re-authentication for sensitive actions;
- brute-force/rate limits;
- audit;
- Telegram owner allowlist.

---

# 116. SECURITY — TELEGRAM BOT

Use Telegram webhook secret token where supported.

Reject malformed updates.

Do not expose admin commands in public chats.

Admin command execution must check exact chat/topic and exact actor permission.

---

# 117. DATA MINIMIZATION / PRIVACY

Collect only data needed for product/security.

Fraud signals:

- prefer country-level network information;
- hash stable identifiers where possible;
- define retention windows;
- avoid precise location/GPS;
- restrict employee/admin access.

Public payout identity can be anonymous.

---

# 118. TERMS / POLICY SURFACES

Required documents/pages before production:

- Terms of Service;
- Privacy Policy;
- Reward Rules;
- Withdrawal Rules;
- Advertising Disclosure;
- Fraud/abuse prohibition;
- account restriction/reversal rules.

V1 supports an 18+ self-attestation policy and configurable restricted-country controls.

No KYC in V1; do not falsely describe self-attestation as identity verification.

---

# 119. KYC READINESS

V1:

```text
KYC_ENABLED = false
```

Future statuses:

```text
NOT_REQUIRED
PENDING
VERIFIED
REJECTED
EXPIRED
```

No KYC vendor now.

Future implementation must isolate identity data and audit access.

---

# 120. PROVIDER POLICY REGISTRY

For every provider record:

- rewarded use allowed?;
- incentivized cash/crypto reward allowed?;
- clicks incentivized?;
- server verification?;
- caps/frequency rules?;
- restricted categories?;
- geo limitations?;
- last policy review date?;
- source/reference?;
- written support confirmation? where applicable.

Never enable Monetag or another provider merely because adapter code exists.

---

# 121. LOGGING

Structured JSON logs.

Fields:

```text
timestamp
service
environment
level
request_id
trace_id
user_id where safe
admin_id where relevant
operation
duration_ms
status
error_code
```

Never log:

- seed phrase;
- private key;
- raw auth tokens;
- TOTP secret;
- KMS private data;
- unredacted sensitive proofs unnecessarily.

---

# 122. METRICS

## API

- RPS
- p50/p95/p99
- errors

## DB

- pool
- long queries
- lock wait
- deadlocks
- storage

## Redis

- memory
- evictions
- availability

## Temporal

- task queue lag
- failed workflows
- activity retries

## Ads

- requests
- loads
- no-fill
- completed
- verified
- fill rate
- reward issuance
- estimated revenue

## Finance

- pending liabilities
- available liabilities
- reserved liabilities
- rewards/day
- withdrawals/day
- fees
- estimated margin

## TON

- USDT
- TON gas
- seqno
- broadcast error rate
- confirmation latency
- reconciliation differences

---

# 123. ALERTING RULES

Warning examples:

- fill-rate decline;
- Hot Wallet near minimum;
- gas near minimum;
- provider errors;
- worker lag;
- reconciliation backlog.

Critical examples:

- ledger imbalance;
- duplicate payout suspicion;
- unexpected outgoing transaction;
- unresolved payout ambiguity;
- DB unavailable;
- signer failure;
- financial mismatch.

Alerts need deduplication, cooldown and resolution messages.

---

# 124. BACKUP STRATEGY

RDS:

- encrypted automated backups;
- Point-in-Time Recovery;
- appropriate retention;
- manual snapshot before dangerous migrations.

Optional later: cross-region backup.

A backup is not trusted until restored successfully.

---

# 125. RESTORE DRILL

At least monthly:

1. restore latest backup to isolated environment;
2. run schema checks;
3. run ledger invariants;
4. compare representative counts;
5. verify selected user histories;
6. verify withdrawal records;
7. record RTO/RPO observation.
8. verify payout dispatch begins paused;
9. reconcile chain observations, withdrawals, attempts, workflows, Outbox, immutable ledger and current balance projections;
10. prove that dispatch cannot resume while a financial ambiguity remains.

---

# 126. DISASTER RECOVERY SCENARIOS

Runbooks required for:

- PostgreSQL corruption;
- AWS region issue;
- Hot Wallet compromise;
- signer compromise;
- Telegram Bot token leak;
- Owner admin compromise;
- AdsGram outage;
- Temporal outage;
- Redis loss;
- Vercel outage;
- TON RPC/data-provider outage.

---

# 127. HOT WALLET COMPROMISE RUNBOOK

1. Pause payouts.
2. Disable signer/KMS permission.
3. Alert Owner.
4. Reconcile recent outgoing transfers.
5. Create new production wallet/key.
6. Manually fund minimal reserve.
7. Update Hot Wallet through controlled audited configuration.
8. Retire old wallet.
9. Investigate all pending/ambiguous withdrawals.
10. Resume only after reconciliation passes.

---

# 128. FINANCIAL INVARIANTS

Continuously verify:

```text
For every ledger transaction:
debits == credits per asset
```

```text
Available >= 0
Pending >= 0
Reserved >= 0
```

```text
One ad session <= one monetary reward
```

```text
One confirmed withdrawal = one valid external payout
```

```text
One withdrawal/destination <= one payout-log publication
```

```text
No withdrawal reserves more than Available
```

```text
ledger_account_balances == independently rebuilt balances from immutable entries
```

```text
No Reserved withdrawal amount is released while broadcast outcome may be ambiguous
```

```text
CONFIRMED withdrawal matches one successful intended TEP-74 transfer by recipient, amount, allowlisted Jetton master, attempt and query ID
```

```text
No client-only ad evidence creates a monetary reward
```

```text
Only apps/signer may invoke KMS signing
```

```text
No auto payout exceeds configured limit
```

---

# 129. TEST STRATEGY

Mandatory layers:

1. Unit
2. Integration
3. E2E
4. Concurrency
5. Property/invariant
6. Failure injection
7. Load
8. Security

---

# 130. UNIT TESTS

Critical areas:

- atomic money conversion;
- fee calculation;
- reward calculation;
- reward rule versioning;
- ledger posting;
- reversal;
- state transitions;
- risk rules;
- referral activation/maturity;
- wallet cooldown;
- daily limits.

---

# 131. INTEGRATION TESTS

Use Testcontainers for PostgreSQL and Redis where practical.

Use deterministic fakes for TON/AdsGram/Telegram before real integration testing.

Tests must exercise actual SQL constraints and row locks.

---

# 132. CONCURRENCY TEST — WITHDRAWAL

Given:

`Available = 1.000000 USDT`

Send 100 concurrent withdrawal requests.

Expected:

- total Reserved <= 1.000000;
- Available never negative;
- ledger balanced;
- idempotent retries return same operation.

---

# 133. DUPLICATE REWARD TEST

Deliver same valid/invalid completion path 100 times.

Expected:

Exactly one valid reward transaction at most.

---

# 134. DUPLICATE APPROVAL TEST

Deliver same Owner approval 100 times.

Expected:

- one state transition;
- one payout workflow;
- no duplicate payout.

---

# 135. CRASH AFTER BROADCAST TEST

Simulate successful chain acceptance then kill process before response persistence.

Expected:

- no blind resend;
- Temporal resumes;
- reconciliation identifies payment;
- one economic payout.

---

# 136. CRASH BEFORE BROADCAST TEST

If failure proves no possible broadcast occurred, controlled retry is safe.

---

# 137. REDIS LOSS TEST

Expected:

- financial correctness preserved;
- no balance loss;
- sensitive operations fail safely or use DB-backed fallback.

---

# 138. PROVIDER OUTAGE TEST

Expected:

- no fabricated reward;
- appropriate session failure/no-fill;
- provider health degraded;
- future failover only when another approved provider exists.

---

# 139. DB FAILURE TEST

No financial write may report success without DB commit.

---

# 140. TON OUTAGE TEST

Withdrawals remain queued/confirming/reconcile-required as appropriate.

No uncontrolled duplicate transfers.

---

# 141. TELEGRAM OUTAGE TEST

Financial backend remains correct.

Outbox delivery retries messages later.

---

# 142. SECURITY TESTS

Before mainnet:

- SAST;
- dependency scan;
- secret scan;
- auth spoof;
- IDOR;
- privilege escalation;
- Telegram callback forgery;
- TON proof replay;
- stale proof;
- wrong-domain proof;
- amount tampering;
- fee tampering;
- integer boundary/overflow;
- withdrawal replay;
- provider webhook replay;
- admin CSRF/session attacks;
- rate-limit bypass;
- signer IAM denial tests.

---

# 143. LOAD TESTS

Use k6 or equivalent.

Stages:

- 1k concurrent users;
- 10k;
- scale according to launch forecast.

Focus:

- auth;
- Home reads;
- ad session creation;
- daily counter contention;
- wallet verification;
- withdrawal creation;
- admin reads.

Payout dispatcher remains intentionally serialized per wallet.

---

# 143A. CONSOLIDATED TEST MATRIX

| Layer/domain | Mandatory coverage | Passing condition |
|---|---|---|
| Money unit | Parse/format, bounds, fee and reward arithmetic | No floating-point path; exact atomic strings |
| Ledger unit/property | Random postings, reversals, maturities, reservations and releases | Debits equal credits per asset; protected balances never negative |
| Ledger integration | Actual SQL constraints, deterministic row locks, triggers and projection rebuild | Posted history immutable; rebuilt balances match projections |
| Idempotency | Lost responses and 100 repeated commands/callbacks | Original result returned; one business mutation |
| Reward Engine | Rule versions, FLOOR rounding, min/max and budget reservation concurrency | Exact quote; budget cannot over-reserve |
| Ad evidence | Duplicate, late, reordered, forged and missing client/provider signals | Client-only evidence never reaches ledger posting |
| AdsGram gate | Provider capabilities incomplete or blocked | Production monetary reward remains disabled |
| Telegram auth | Invalid signature, modified user, stale/malformed data and replay | Forged identity rejected |
| `ton_proof` | Nonce replay, stale/future time, wrong domain, invalid state-init/public key/address and wrong network | Only valid account/network proof accepted once |
| Withdrawal state | Every allowed and forbidden transition | Expected-state update predicates enforce matrix |
| Withdrawal concurrency | 100 requests against limited Available and volume limits | No negative Available or excess Reserved |
| Withdrawal rejection | Approved/held/pre-broadcast rejection | Full gross reservation returned once |
| Temporal workflow | Outbox retry, duplicate start, replay and worker deployment | One deterministic withdrawal workflow |
| Signer boundary | Wrong role, state, wallet, recipient, amount, asset, master, attempt, query ID, seqno, limits or hash | No signature; only signer role reaches KMS |
| TON Testnet | KMS signing, Wallet V5, TEP-74 success, seqno, bounce/failure and query ID | Intended successful Jetton transfer is proven |
| Failure injection | Crash before/after signing, during/after send, RPC timeout and provider disagreement | At most one economic payout; ambiguity reconciles |
| Hot Wallet | Low USDT/TON, threshold crossing, unexpected outgoing transaction and stale lease | Dispatch pauses/holds and alerts correctly |
| Invalid traffic | Pending, Available, Reserved and paid cases | Approved linked recovery; no history rewrite/hidden negative balance |
| Referral | Eligibility flag, matured ad source, FLOOR arithmetic and origin reversal | No duplicate/unfunded referral reward |
| Risk | LOW/MEDIUM/HIGH/CRITICAL behavior and shared-wallet signal | No single-score permanent ban |
| Admin auth | Passkey, password+TOTP, recovery, CSRF, IDOR and reauthentication | TOTP alone never authenticates; privileged action audited |
| Telegram admin | Wrong actor/chat/topic/resource/state, expired/replayed token | One authorized action only |
| Outbox/Inbox | Publish failure, duplicate consumption and recovery | Domain commit independent of external availability |
| Reconciliation | Ledger projection, chain payout, Hot Wallet, funding and provider discrepancies | No silent correction; Critical issues pause operations |
| Restore/DR | Isolated restore and pre-resume reconciliation | Dispatch starts paused and cannot resume with ambiguity |
| Privacy | Logs, Sentry, public payout preference and anonymization | Secrets/prohibited identity never disclosed |
| Localization/accessibility | AR/EN/RU, RTL, amount/date formatting and degraded states | All V1 user flows usable |
| Migration/deployment | Clean migration, seeded upgrade and expand/migrate/contract | Compatible rollout/rollback path verified |
| Load | Auth, Home, ads, counters, withdrawals, Admin and serialized dispatcher | Approved production SLO/load targets met |

---

# 144. CI PIPELINE

Every PR:

1. locked dependency install;
2. lint;
3. format check;
4. typecheck;
5. unit tests;
6. integration tests;
7. migration validation;
8. build all apps;
9. security/secret scan;
10. financial invariant suite if relevant.

Required checks must block merge.

---

# 145. DATABASE MIGRATION POLICY

- migrations in Git;
- staging-tested;
- no destructive change without plan;
- backup before high-risk migration;
- expand/migrate/contract for zero-downtime schema evolution;
- no manual production schema edits by Codex.

---

# 146. DEPLOYMENT POLICY

Order when relevant:

1. compatible DB migration;
2. API;
3. workers;
4. bot;
5. Admin;
6. Mini App;
7. health checks;
8. feature flag enablement.

Use rolling deployment.

---

# 147. ANALYTICS

Operational analytics may initially use PostgreSQL aggregations + metrics.

Events:

- signup;
- Mini App open;
- ad request;
- no-fill;
- completion;
- reward maturity;
- wallet verified;
- withdrawal request;
- withdrawal confirmation;
- referral activation.

Analytics never replaces ledger.

At scale add warehouse/ClickHouse/BigQuery without moving financial truth.

---

# 148. USER TRANSACTION HISTORY

Examples:

```text
Rewarded Ad          +0.000540
Referral Reward      +0.000030
Task Bonus           +0.001000
Withdrawal           -0.500000
Support Adjustment   +0.050000
```

Each item has reference, timestamp, state and explanation.

---

# 149. PUBLIC TRUST / TRANSPARENCY

Because users receive real rewards:

- Public Payout Logs;
- user withdrawal history;
- explorer links;
- clear minimum;
- clear fee;
- clear Reward Rules;
- no guaranteed-income marketing;
- no exaggerated reward claims.

---

# 150. ADSGRAM ECONOMICS

AdsGram economics depend on provider CPM/geography and are not a permanent fixed value per individual view.

Therefore:

- rewards are dynamic;
- new rule versions can adjust future quotes;
- already valid quotes remain stable;
- maintain safety margin;
- recalibrate from provider reporting;
- monitor negative-margin risk.

---

# 151. DAILY ECONOMIC CLOSE

Daily process computes:

- estimated provider revenue;
- realized provider report data where available;
- ad reward cost;
- referral cost;
- task cost;
- withdrawal fee revenue;
- TON gas cost;
- gross operating margin estimate;
- outstanding liabilities;
- Hot Wallet coverage.

Unexpected deviations alert Owner.

---

# 152. ADULT / GAMBLING POLICY

Initial:

```text
ADULT_ADS = OFF
GAMBLING_ADS = OFF
```

Changing requires explicit Owner confirmation and policy/legal review.

---

# 153. ACCOUNT DELETION

When deletion requested:

- stop new earning as policy requires;
- resolve eligible financial obligations;
- anonymize deletable profile data;
- preserve ledger/audit/reconciliation records;
- mark `DELETED_ANONYMIZED`.

Do not orphan ledger references.

---

# 154. FUTURE KYC IMPLEMENTATION RULES

When later added:

- prefer vendor-hosted documents;
- store vendor references/status;
- separate permissions;
- audit access;
- define retention/deletion.

Out of scope for V1.

---

# 155. CODEX WORKING RULES

Codex MUST:

- read this master spec before critical work;
- keep docs synchronized;
- work in reviewable phases;
- list files changed;
- run tests and report them;
- never hide failures;
- avoid unrelated refactors in financial PRs;
- create migrations for schema changes;
- create regression tests for financial bugs;
- preserve deployment compatibility;
- avoid unnecessary `any`;
- never disable tests to pass CI;
- never swallow payout errors;
- never print secrets;
- never use client state as money truth.

---

# 156. CODEX DEFINITION OF DONE

A phase is complete only when:

- required feature exists;
- docs updated;
- unit tests pass;
- integration tests pass;
- acceptance tests pass;
- relevant failure tests pass;
- security requirements pass;
- no critical TODO;
- migrations tested;
- observability added;
- rollback/recovery defined.

---


# 156A. V1.2 MEMBERSHIP AND FOUNDER LIFETIME SYSTEM

## 156A.1 Product meaning

`FOUNDER_LIFETIME` is a lifetime membership/benefit product for early supporters who paid 50 USD one time.

It is NOT:

- equity;
- a share of ALEx Rewards ownership;
- a debt instrument;
- a guaranteed investment return;
- a promise to recover the 50 USD;
- a fixed monthly income product;
- a right to bypass fraud, payout, provider, legal or security rules.

User-facing wording must describe benefits, not guaranteed earnings.

## 156A.2 Membership types

Initial types:

```text
STANDARD
FOUNDER_LIFETIME
```

Architecture-ready later types:

```text
PREMIUM_MONTHLY
PREMIUM_YEARLY
PARTNER
INFLUENCER
```

Later types are not Initial V1 requirements and MUST NOT delay launch.

## 156A.3 Founder identity

Every Founder receives:

```text
membership = FOUNDER_LIFETIME
founder_number = unique permanent sequential number
badge = Founder
status_history = retained
```

Example display:

```text
⭐ ALEx Rewards Founder
Founder #0001
Lifetime Member
```

Founder numbering must be generated server-side under a unique database constraint. Never generate the number solely in the frontend.

## 156A.4 Founder benefits

The entitlement system must support:

```text
FOUNDER_BADGE
FOUNDER_NUMBER
ELIGIBLE_REWARD_BONUS
REFERRAL_RATE_BOOST
WITHDRAWAL_PLATFORM_FEE_DISCOUNT
PRIORITY_WITHDRAWAL_REVIEW
PRIORITY_SUPPORT
EXCLUSIVE_MISSION_ACCESS
FOUNDER_COMPETITION_ACCESS
EARLY_FEATURE_ACCESS
```

The initial proposed reward bonus is `500 bps` (+5%) on explicitly eligible rewards. It must be configurable, versioned, budget-capped and separately auditable.

The initial proposed Founder referral profile is `700 bps` effective referral rate where the ordinary V1 rule is `500 bps`, subject to the same configurable/versioned economics. The invitee's reward must never be reduced to fund it.

The exact Founder withdrawal platform-fee discount/waiver rule is configurable and requires explicit Owner approval before launch/public promise. TON network fees and external costs must not be hidden by incorrect accounting.

## 156A.5 Entitlement resolution

Forbidden pattern:

```ts
if (user.isFounder) {
  // scattered special financial behavior
}
```

Required conceptual flow:

```text
User
 -> active membership snapshot
 -> entitlement resolver
 -> typed entitlement value/version
 -> eligibility/economic checks
 -> domain command
```

Entitlements do not directly mutate money. Financial benefits call the normal Reward Engine, fee engine, withdrawal engine and Ledger.

## 156A.6 Founder bonus accounting

A Founder reward bonus is platform-funded and must be distinguishable from the base ad reward.

Recommended account classification:

```text
MEMBERSHIP_BONUS_EXPENSE
```

Example Founder bonus pending posting:

```text
DR Membership Bonus Expense
CR User Pending Liability
```

The bonus must carry:

```text
originating_reward_id
membership_id
entitlement_version
bonus_rule_version
amount_atomic
budget_period_id
```

The base reward remains governed by the original provider/reward rule. The membership bonus must not be falsely recorded as provider revenue or provider-funded reward.

## 156A.7 Bonus budgets

Membership bonus issuance must support:

```text
daily budget
monthly budget
per-user cap
per-membership-plan cap
global cap
reserved
consumed
released
```

A valid base reward must not be corrupted if a Founder bonus budget is unavailable. The policy must explicitly choose either `base reward only` or `block quote before ad starts`; never silently promise a bonus and then remove it after a valid ad starts.

## 156A.8 Existing pre-launch/manual purchasers

People who paid before public launch must be supported without requiring a public payment integration.

Allowed V1 flows:

1. audited Owner direct grant after payment verification; or
2. one-time Founder claim code issued by Owner and claimed after Telegram authentication.

Required claim-code properties:

```text
cryptographically unpredictable
single-use
server-validated
optional expiry
bound to one membership grant
cannot contain trusted financial fields
consumed atomically
claim audited
```

After claim, the membership is bound to the validated Telegram user.

## 156A.9 Transfer and resale

No self-service Founder transfer.

Any exceptional reassignment requires:

- Owner authentication/reauthentication;
- reason;
- review;
- before/after audit;
- invalidation of old claim/grant access;
- no duplication of Founder number or lifetime entitlement.

## 156A.10 Grandfathering and benefit history

Lifetime membership status itself must not disappear because benefit rules change later.

Every benefit evaluation must be reconstructable from rule/entitlement versions. If a public sale promise guarantees a specific permanent benefit, that promise must be represented as a grandfathered entitlement/version rather than silently changed later. If a benefit was advertised as variable/configurable, rule changes remain allowed through versioned Owner controls.

---

# 156B. MEMBERSHIP DATABASE MODEL

Add or normalize equivalent tables while preserving existing schema semantics:

```text
membership_plans
entitlements
membership_plan_entitlements
user_memberships
membership_claim_codes
membership_grant_events
membership_benefit_rule_versions
membership_bonus_budget_periods
membership_bonus_budget_reservations
```

Suggested critical fields:

## `membership_plans`

```text
id
code UNIQUE                    -- STANDARD / FOUNDER_LIFETIME / future
name
billing_model                  -- FREE / ONE_TIME / SUBSCRIPTION_FUTURE
price_currency NULL
price_atomic_or_decimal_string NULL
is_lifetime
status
created_at
updated_at
```

## `entitlements`

```text
id
code UNIQUE
value_type                     -- BOOLEAN / BPS / INTEGER / ATOMIC_AMOUNT / ENUM
security_classification
created_at
```

## `membership_plan_entitlements`

```text
id
membership_plan_id
entitlement_id
rule_version_id
valid_from
valid_to NULL
status
```

## `user_memberships`

```text
id
user_id
membership_plan_id
founder_number NULL UNIQUE
status
source                         -- OWNER_GRANT / CLAIM_CODE / FUTURE_PURCHASE
purchase_amount NULL
purchase_currency NULL
payment_reference_redacted NULL
granted_at
claimed_at NULL
expires_at NULL                -- null for lifetime
revoked_at NULL
revocation_reason NULL
created_by_admin_id NULL
created_at
```

Revocation must not be used to erase payment/history. If fraud/legal reasons restrict use, retain the historical record and use an explicit status/access restriction.

## `membership_claim_codes`

Store only a secure hash of the claim secret where feasible.

```text
id
code_hash UNIQUE
membership_plan_id
founder_number_reserved NULL
issued_for_reference NULL
expires_at NULL
consumed_at NULL
consumed_by_user_id NULL
created_by_admin_id
created_at
```

## `membership_grant_events`

Append-only history of grant/claim/reassignment/status events.

---

# 156C. POLICY / RULES CENTER

The Owner needs one coherent control surface, but the implementation MUST NOT build a generic scripting engine that can execute arbitrary database-stored code.

The Policy Center coordinates typed, versioned domain rules such as:

```text
Provider Limits
Provider Routing
Country Eligibility
Reward Rules
Membership Benefits
Referral Rules
Withdrawal Fees/Limits
Pending Hold Rules
Risk/Trust Thresholds
Mission Rules
Feature Flags
Economic Exposure Limits
```

Each rule family keeps its domain-specific schema, validation and invariants.

High-impact rule changes require:

1. Owner authentication;
2. reauthentication when configured;
3. old/new diff;
4. reason;
5. source/reference when provider/legal driven;
6. impact preview where calculable;
7. second confirmation for financial/high-risk changes;
8. effective time;
9. immutable version history;
10. audit event.

No policy rule may:

- post ledger entries directly;
- sign payouts;
- bypass mandatory validation;
- execute arbitrary JavaScript/SQL/eval;
- override provider hard limits;
- make a client callback financial truth.

---

# 156D. PROVIDER PLUGIN / ADAPTER FRAMEWORK

## 156D.1 Goal

Adding a new approved advertising company must be a bounded adapter/configuration project, not a rewrite of rewards, users, withdrawals or the ledger.

Conceptual separation:

```text
Provider Adapter -> normalized evidence/availability/reporting
Reward Engine    -> decides reward amount
Ledger           -> records financial truth
Fraud/Risk       -> assesses risk
Router           -> selects eligible provider
```

## 156D.2 Required adapter contract

Each provider adapter must expose typed equivalents of:

```ts
interface RewardedAdProvider {
  readonly code: ProviderCode;
  getManifest(): ProviderManifest;
  getCapabilities(): ProviderCapabilities;
  getAvailability(input: AvailabilityInput): Promise<AvailabilityResult>;
  authorizeSession(input: AuthorizeAdInput): Promise<AuthorizeAdResult>;
  normalizeClientEvent(input: unknown): ProviderClientSignal;
  verifyServerSignal(input: unknown, context: VerificationContext): Promise<ProviderVerificationResult>;
  getHealth(): Promise<ProviderHealth>;
  fetchReporting?(input: ReportingInput): Promise<ProviderReportingResult>;
  reconcile?(input: ReconciliationInput): Promise<ProviderReconciliationResult>;
}
```

Exact code shape may differ, but semantics must remain.

## 156D.3 Provider manifest

Versioned provider manifest/configuration supports:

```text
provider_code
name
status
environment
supported_formats
rewarded_supported
server_reward_signal_supported
server_signal_authentication
unique_event_id_supported
session_or_impression_correlation_supported
custom_nonce_supported
retry_delivery_documented
provider_side_limit_supported
reporting_api_supported
revenue_reporting_supported
country_reporting_supported
credentials_reference
policy_status
production_monetary_status
```

`production_monetary_status` remains one of the approved states such as:

```text
BLOCKED
TEST_ONLY
APPROVED
SUSPENDED
```

## 156D.4 No provider-specific leakage

Do not make core modules depend on literal AdsGram-only behavior.

Provider-specific code belongs in the adapter. Core rewards/ledger/withdrawal modules consume normalized contracts and capability decisions.

---

# 156E. PROVIDER CONTRACT REGISTRY

For every commercial provider relationship, store structured contract metadata and secure document references.

Suggested:

```text
provider_contracts
```

Fields:

```text
id
provider_id
contract_status
contract_start
contract_end NULL
payment_terms
settlement_currency
revenue_share_terms_reference
allowed_traffic_model
rewarded_cash_crypto_allowed_status
allowed_countries_reference
restricted_categories_reference
provider_request_limit_reference
reporting_method
invoice_or_settlement_cycle
minimum_provider_payout NULL
contact_reference
contract_document_secure_reference
reviewed_at
reviewed_by
notes
created_at
updated_at
```

Do not store provider secrets or sensitive raw contract documents in public/client-accessible storage.

Alerts should exist for contract/policy review dates and expiry.

---

# 156F. PROVIDER ONBOARDING LIFECYCLE

A new provider uses an explicit lifecycle:

```text
CONTRACTED
-> TECH_REVIEW
-> SANDBOX
-> SECURITY_VERIFIED
-> ECONOMICS_VERIFIED
-> LIMITED_TEST
-> APPROVED
-> PRODUCTION
```

Exceptional states:

```text
BLOCKED
SUSPENDED
REJECTED
```

Production monetary traffic requires:

- exact business model allowed in writing/contract/policy;
- server-signal trust/correlation model reviewed;
- limits recorded;
- moderation/compliance passed where applicable;
- certification tests passed;
- reward economics configured;
- country eligibility configured;
- settlement/reporting approach configured;
- monitoring/kill switch available.

---

# 156G. PROVIDER CERTIFICATION TEST HARNESS

Every provider adapter must be testable with deterministic fixtures/fakes before production.

Mandatory cases where capability-relevant:

```text
availability success
no fill
load failure
start failure
valid completion
duplicate client callback
duplicate server callback
server callback before client callback
late callback
invalid/missing signature
replay
wrong user
wrong session
ambiguous correlation
provider timeout
provider outage
request cap reached
successful cap reached
country not eligible
provider suspended
reporting import
settlement mismatch
invalid-traffic reversal input
```

Pass criteria include:

- zero duplicate reward;
- no client-only monetary credit;
- no reward on failed/no-fill session;
- deterministic idempotency;
- recorded evidence/audit;
- no provider hard-limit bypass.

Certification runs should record adapter version, manifest version, test result and approval state.

---

# 156H. PROVIDER ROUTING AND FAILOVER

## 156H.1 Routing inputs

The routing foundation may consider only approved, documented inputs such as:

```text
provider production status
country eligibility
provider health
inventory/fill availability
provider hard limits
platform soft limits
user/tier limits
cooldown
estimated eCPM/revenue
expected contribution margin
risk/eligibility
contract status
```

## 156H.2 Routing safety

The router selects a provider. It does not decide money.

Only providers with `productionMonetaryStatus = APPROVED` may receive production monetary traffic.

Do not fail over an already-started rewarded ad into another provider under the same financial session. If failover is allowed after a pre-start no-fill/failure, create a distinct provider session/evidence chain with idempotent routing correlation.

## 156H.3 Routing strategy versioning

Routing policy must be versioned and auditable.

Future optimization may use weighted scoring over fill, eCPM, health and margin, but no opaque optimizer may bypass explicit caps, legal/country rules, or production-approval state.

---

# 156I. COUNTRY / REGION RULES

Support versioned provider/country rules without hardcoding country behavior.

Potential rule dimensions:

```text
provider eligibility
provider priority
reward-rule group
campaign eligibility
membership campaign eligibility
withdrawal/legal availability
```

The exact authoritative country source and fallback remain production decisions from Version 1.1. Do not silently treat IP geolocation, Telegram metadata or provider reporting as authoritative until the source/fallback policy is approved.

---

# 156J. USER ELIGIBILITY ENGINE

Eligibility determines whether an action/offer is available. It is not money truth and not fraud scoring.

Inputs may include:

```text
validated user/account state
country group
account age
membership/entitlements
risk tier
trust state
provider status/capabilities
provider/platform limits
mission targeting
feature flags
legal/policy eligibility
```

Outputs must be typed and reason-coded, e.g.:

```text
ELIGIBLE
INELIGIBLE_PROVIDER_LIMIT
INELIGIBLE_COUNTRY
INELIGIBLE_ACCOUNT_STATE
INELIGIBLE_RISK_POLICY
INELIGIBLE_MEMBERSHIP
INELIGIBLE_FEATURE_DISABLED
```

Do not expose sensitive fraud rules to the user.

---

# 156K. TRUST SCORE / TRUST STATE

Trust is separate from Fraud/Risk.

Conceptually:

```text
Fraud/Risk: how suspicious or dangerous is this behavior?
Trust: how much positive verified history does this account have?
Membership: what benefits did this user legitimately purchase/receive?
```

Founder membership MUST NOT automatically create trusted status.

Potential positive trust signals:

- account age;
- long valid ad history;
- stable verified wallet history;
- confirmed legitimate payouts;
- low reversal/invalid-traffic history;
- no unresolved disputes/reconciliation issues.

Store versioned trust snapshots/reasons. Do not let Trust override CRITICAL fraud or hard security blocks.

Future trusted-user benefits may include shorter Pending hold, conservative auto-payout eligibility, or higher platform soft limits only where provider/legal hard limits still allow them.

---

# 156L. ECONOMIC GUARDRAILS AND EXPOSURE LIMITS

In addition to Version 1.1 reward budgets, support configurable/versioned exposure controls:

```text
MAX_GLOBAL_HOURLY_REWARD_EXPENSE
MAX_GLOBAL_DAILY_REWARD_EXPENSE
MAX_PROVIDER_DAILY_REWARD_EXPENSE
MAX_COUNTRY_DAILY_REWARD_EXPENSE
MAX_MEMBERSHIP_BONUS_DAILY
MAX_MEMBERSHIP_BONUS_MONTHLY
MAX_REFERRAL_BONUS_DAILY
MAX_MISSION_BONUS_DAILY
MIN_EXPECTED_MARGIN_BPS
MAX_UNSETTLED_PROVIDER_RECEIVABLE_EXPOSURE
```

Exact production values are `OWNER_DECISION_REQUIRED` unless already locked elsewhere.

If an exposure/circuit-breaker limit is reached, stop authorizing new affected monetary quotes/actions safely. Do not retroactively reduce a valid quote after the ad has validly started unless the existing quote rules explicitly permit it.

---

# 156M. ECONOMICS DASHBOARD

Owner Admin must distinguish estimated, accrued/settled and actual cash/token economics.

Required views include:

```text
Provider Estimated Revenue
Provider Settled/Confirmed Revenue
Provider Receivables
Base User Reward Expense
Membership/Founder Bonus Expense
Referral Bonus Expense
Mission/Task Reward Expense
Withdrawal Fee Revenue
TON Network Fee Expense
Invalid-Traffic Adjustments/Loss
Net Contribution Margin estimate
Hot Wallet Coverage
Outstanding User Liabilities
```

Breakdowns should support where data exists:

```text
provider
country/group
day/week/month
membership type
standard vs founder cohort
campaign/mission
```

Do not label estimates as realized profit.

---

# 156N. PROVIDER SETTLEMENT / RECONCILIATION

Add structured provider settlement periods so estimated runtime economics can be reconciled to provider statements/reporting.

Suggested tables:

```text
provider_settlement_periods
provider_settlement_items
provider_reporting_imports
```

Track:

```text
period
provider
estimated revenue
reported revenue
settled revenue
invalid-traffic deductions
other adjustments
currency
statement/reference
variance
status
```

A discrepancy creates/updates a reconciliation issue. Never rewrite user ledger history merely to force a provider statement to match.

---

# 156O. UNIFIED REVIEW QUEUE

The Review Center is an operational projection/control surface, not a new source of domain truth.

Case types may include:

```text
WITHDRAWAL_REVIEW
FRAUD_REVIEW
PROVIDER_ANOMALY
INVALID_TRAFFIC
REFERRAL_ABUSE
FOUNDER_CLAIM_ISSUE
MEMBERSHIP_REASSIGNMENT
SUPPORT_ESCALATION
RECONCILIATION_ISSUE
```

Each review case records:

```text
id
type
resource_type
resource_id
priority
reason_codes
state
assigned_admin NULL
created_at
updated_at
resolved_at NULL
```

Actions call the authoritative domain command and must pass its state/permission/invariant checks.

---

# 156P. GENERIC MISSION ENGINE

The V1 basic tasks remain required, but implementation should avoid hardcoding one-off task logic.

Mission definition supports typed/allowlisted conditions such as:

```text
DAILY_LOGIN
VALID_AD_COUNT
REFERRAL_ACTIVATION_COUNT
STREAK_MILESTONE
MEMBERSHIP_REQUIRED
TIME_WINDOW
COUNTRY_GROUP
```

Suggested model:

```text
mission_definitions
mission_versions
mission_progress
mission_claims
```

A mission version defines:

```text
name_key
description_key
condition_type
target
reset_policy
start_at
end_at
eligibility_policy
reward_source_type
reward_rule_reference
status
```

Monetary rewards always use Reward Engine -> Ledger. Client progress events alone cannot award money.

Founder-exclusive missions use membership eligibility, not duplicated task engines.

---

# 156Q. NOTIFICATION CAMPAIGNS

Expand notifications with an Owner campaign tool using privacy-safe server-side segments.

Possible segments:

```text
ALL_ELIGIBLE
FOUNDERS
COUNTRY_GROUP
INACTIVE_N_DAYS
WALLET_NOT_VERIFIED
AVAILABLE_BALANCE_THRESHOLD
MISSION_ELIGIBLE
```

Campaign delivery must respect marketing preferences and rate limits. Mandatory security notifications remain separate and cannot be disabled where policy requires.

Do not put sensitive balance, wallet, fraud, or security details into broad campaign messages.

---

# 156R. FEATURE FLAGS AND KILL SWITCHES

Granular flags/kill switches include at minimum:

```text
GLOBAL_REWARDS_PAUSE
PROVIDER_<CODE>_ENABLED
PROVIDER_<CODE>_MONETARY_ENABLED
MEMBERSHIP_BONUS_PAUSE
REFERRAL_REWARD_PAUSE
MISSION_REWARD_PAUSE
WITHDRAWAL_REQUESTS_PAUSE
PAYOUT_DISPATCH_PAUSE
AUTO_PAYOUT_PAUSE
WALLET_VERIFICATION_PAUSE
```

Flags are environment-specific and auditable.

A feature flag must never bypass immutable ledger rules, payout reconciliation, signer validation, authentication, provider hard limits or mandatory legal blocks.

---

# 156S. DOMAIN EVENTS AND ANALYTICS CONTRACT

Important domain events should have stable schemas and correlation IDs, for example:

```text
USER_CREATED
MEMBERSHIP_GRANTED
FOUNDER_CLAIMED
MEMBERSHIP_BENEFIT_APPLIED
AD_SESSION_VERIFIED
AD_REWARDED
REWARD_MATURED
WITHDRAWAL_REQUESTED
WITHDRAWAL_CONFIRMED
WALLET_CHANGED
PROVIDER_SUSPENDED
RISK_CHANGED
TRUST_CHANGED
MISSION_COMPLETED
```

Financial domain events are emitted through the Transactional Outbox where required. Analytics consumers never become financial authority.

Business/product metrics should include, where privacy and data quality permit:

```text
DAU
new users
D1/D7/D30 retention
ads per active user
provider fill/completion
revenue per active user
reward cost per user
referral activation/conversion
withdrawal request/confirmation rate
payout latency
fraud/invalid-traffic loss
net contribution margin estimate
Founder cohort cost/value
```

---

# 156T. SAFE EXPERIMENTATION

An experimentation framework is architecture-ready but not required to delay Initial V1.

Experiments may test presentation, onboarding, mission copy, non-critical engagement flows and approved economic offers only after explicit review.

Never A/B test or randomly weaken:

- ledger invariants;
- authentication;
- signer validation;
- provider hard limits;
- legal/jurisdiction blocks;
- payout confirmation semantics;
- fraud critical blocks;
- reconciliation requirements.

Financial experiments require explicit Owner approval, versioned budgets and full auditability.

---

# 156U. PHASE ARCHIVE / ZIP REQUIREMENT — MANDATORY

After **every phase** reaches its acceptance gate, Cursor/Codex MUST create the dual-archive package below before asking permission to start the next phase.

Repository folder:

```text
phase-archives/
```

This folder must be in `.gitignore` by default so ZIP binaries do not bloat source history.

Per-phase folder format:

```text
phase-archives/
└── PHASE_<NN>_<SLUG>/
    ├── ALEx_Rewards_PHASE_<NN>_<SLUG>_<YYYYMMDD-HHMMSS>_<SHORT_SHA>.zip
    ├── PHASE_<NN>_ACCEPTANCE_REPORT.md
    ├── MANIFEST.md
    ├── SHA256SUMS.txt
    ├── PHASE_<NN>_<SLUG>_PACKAGE_<YYYYMMDD-HHMMSS>_<SHORT_SHA>.zip
    └── PACKAGE_SHA256.txt
```

## 156U.1 Canonical source ZIP (A)

Filename: `ALEx_Rewards_PHASE_<NN>_<SLUG>_<TIMESTAMP>_<SHORT_SHA>.zip`

- Built from the exact accepted Git commit.
- Prefer deterministic `git archive`.
- This is the canonical sealed source snapshot.
- It must never include `phase-archives` itself.
- It must never contain secrets/generated/runtime files.

## 156U.2 Final review-package ZIP (B)

Filename: `PHASE_<NN>_<SLUG>_PACKAGE_<TIMESTAMP>_<SHORT_SHA>.zip`

This is the single ZIP the Owner sends for review. It MUST contain exactly:

```text
PHASE_<NN>_<SLUG>/
├── ALEx_Rewards_PHASE_<NN>_<SLUG>_<TIMESTAMP>_<SHORT_SHA>.zip
├── PHASE_<NN>_ACCEPTANCE_REPORT.md
├── MANIFEST.md
└── SHA256SUMS.txt
```

The review package MUST NOT contain itself. Outer review-package ZIP entry names MUST use
forward-slash path separators (`/`) on every platform; backslash entry names are prohibited.
`PACKAGE_SHA256.txt` stays beside the final package ZIP and records only the SHA-256 of the outer review-package ZIP:

```text
<sha256>  PHASE_<NN>_<SLUG>_PACKAGE_<TIMESTAMP>_<SHORT_SHA>.zip
```

`SHA256SUMS.txt` inside the review package must contain SHA-256 values for the canonical source ZIP, acceptance report, and `MANIFEST.md` only. Do not include the outer package hash inside itself.

## 156U.3 Before archive creation

1. all phase tests/gates must have passed;
2. documentation must be updated;
3. no secrets may be staged or committed;
4. `git status` must be understood and the accepted source state must be committed;
5. record full commit SHA and branch;
6. do not silently overwrite an older phase archive;
7. where applicable, final CI for the accepted commit must be green before treating that commit as archival source.

## 156U.4 Prohibited content — both archive levels

Both the source ZIP and the final review-package ZIP must be scanned. Reject:

```text
.env
.env.* except approved .env.example
node_modules
dist
.next
.turbo
.git
local databases
Docker volumes
wallet seed phrases
private keys
KMS private/signing material
provider API secrets
Telegram bot secrets
production credentials
runtime logs containing secrets
phase-archives recursively
temporary extraction folders
the outer package ZIP inside itself
```

Never weaken this list.

## 156U.5 Acceptance report requirements

The acceptance report must contain:

```text
A. Phase objective
B. Exact scope delivered
C. Files/modules changed
D. Database migrations
E. Commands executed
F. Unit/integration/E2E/failure/security test evidence
G. Build/health results
H. CI run IDs/links when applicable
I. Known deviations
J. Open blockers/technical debt
K. Security/financial invariant checks
L. Rollback/recovery notes
M. Exact commit SHA
N. Final PASS/FAIL for every gate
O. Archive verification
```

Section O must record:

```text
- canonical source ZIP filename/path
- canonical source ZIP SHA256
- final review-package filename
- source extraction result
- outer package extraction result
- prohibited-path scan result
- nested source validation result
- statement: "Final review-package SHA256 is recorded externally in PACKAGE_SHA256.txt beside the package."
```

Section O MUST NOT embed the final outer review-package SHA256 value. Embedding that hash inside a file contained by the ZIP would change the ZIP hash and create an impossible self-reference. The ONLY authoritative final outer package hash is `PACKAGE_SHA256.txt`, which remains outside the review-package ZIP.

## 156U.6 Manifest requirements

`MANIFEST.md` must include at minimum: project name ALEx Rewards; phase number/slug; roadmap/spec version; acceptance status; full accepted commit SHA and short SHA; branch; source ZIP filename; acceptance-report filename; final review-package filename; archive creation timestamp UTC; historical CI evidence if relevant; final CI run URL; quality and docker-smoke job IDs/results when applicable; toolchain versions (including an actual pnpm version, never `unknown` when `packageManager` is pinned); archive helper version; and an explicit next-phase status note.

The next-phase status note MUST NOT invent historical state. For normal future phases the default is:

```text
No Phase <N+1> work has started at packaging time.
```

Exceptional/backfill packaging MUST pass an explicit truthful next-phase status note. Example: Phase 00 packaging after Phase 1 foundation already exists must not claim that Phase 1 had not started.

## 156U.7 Helper and stop rule

The repository helper `scripts/create-phase-archive.mjs` MUST implement the dual-ZIP workflow as its default behavior for every phase. After successful packaging and verification of both levels, Cursor/Codex MUST present the final review-package ZIP to the Owner, then stop and wait for explicit Owner approval before beginning the next phase.

For an already-implemented phase that predates Version 1.2, create the archive when that phase's remaining acceptance gate actually passes; do not falsely mark it accepted merely because implementation exists. Changing the outer review-package format does not invalidate or reopen already-sealed canonical source ZIPs.

---

# 156V. CURSOR / CODEX EXECUTION CONTRACT

Every AI coding session performing phase work must:

1. read this Version 1.2 master specification and relevant repo docs;
2. inspect existing code before editing;
3. state the exact phase and scope it is about to work on;
4. refuse to silently start later phases;
5. preserve Version 1.1 safety properties;
6. use exact pinned dependencies and existing architecture unless this specification explicitly requires a reviewed change;
7. never invent production financial values marked configurable/undecided;
8. make reviewable changes;
9. run the phase's required tests and report failures truthfully;
10. update docs and acceptance report;
11. create the mandatory phase ZIP/archive only after the phase gate passes;
12. stop for Owner approval.

If code and this document conflict on financial/security behavior, stop the affected work and report the conflict before choosing a behavior.

---

# 157. IMPLEMENTATION PHASE 0 — SPECIFICATION FREEZE

Deliver and preserve:

- architecture diagrams;
- ERD;
- ledger account model;
- ad state/evidence model;
- withdrawal state machine;
- fraud/risk model;
- API contract draft;
- failure matrix;
- security model;
- Terraform plan;
- consolidated Version 1.2 specification;
- independent ad evidence model and provider monetary-eligibility capabilities;
- signer trust boundary;
- split Phase 1 versus production/mainnet blockers;
- Membership/Founder model;
- Entitlements model;
- dynamic provider-limit model;
- Provider Plugin/Adapter model;
- Policy Center boundaries;
- eligibility/trust/economics/review/mission foundations;
- mandatory phase-archive procedure.

No new production-code phase may begin until the current phase gate is approved.

Gate: Version 1.2 is explicitly approved as the active source of truth and all changed money/benefit/provider-limit paths are defined without weakening Version 1.1 safety rules.

Archive gate: create `phase-archives/PHASE_00_SPECIFICATION_FREEZE/...zip` only after acceptance, then stop for Owner approval.

---

# 157A. BLOCKER CLASSIFICATION

## Phase 1 / current-development blocker

Version 1.2 may be adopted without rebuilding already-correct Phase 1 foundation work. If Phase 1 implementation already exists, first close its outstanding acceptance gates; do not begin Phase 2 merely because implementation exists.

Phase 1 is accepted only when its original gate is genuinely passed, including required runtime/CI verification.

## Production/mainnet blockers

Before the affected production feature or mainnet launch is enabled, resolve and record all Version 1.1 blockers plus V1.2 additions:

1. AdsGram callback authenticity, per-impression/session correlation, retry/delivery behavior and provider-side request limiting;
2. AdsGram moderation approval and verified Adult/Gambling disablement;
3. final ad country source/fallback and initial eCPM, user-share, safety-factor, min/max reward, budget and liability-coverage settings;
4. final Referral V1 percentage/budget and mission reward/reset/streak rules;
5. official mainnet USDT Jetton master/metadata source, controlled Testnet Jetton, primary and independent secondary TON providers, and public explorer;
6. selected AWS region, successful KMS/Wallet V5 Testnet spike, and formally approved fallback signer if needed;
7. final Hot Wallet funding/accounting classification and escalation policy for long-running `HELD`/`RECONCILE_REQUIRED` cases;
8. operating entity/jurisdiction, allowed/restricted/sanctions-country policy, legal approval for 18+ self-attestation and KYC-disabled V1, and final policy/consent documents;
9. production domains, WebAuthn RP ID, cookie topology, password/session/reauthentication/action-token settings, recovery custody and high-impact-action thresholds;
10. retention periods, account deletion/re-registration behavior and single-Owner continuity procedure;
11. production Telegram destinations, infrastructure/provider account identifiers, SLO/RTO/RPO/load targets, backup retention, alert thresholds and incident ownership;
12. all security, restore, Testnet, reconciliation, moderation and mainnet checklist gates;
13. final Founder public-benefit wording and explicit approval of launch values for reward bonus, referral profile, fee benefit, membership bonus budgets/caps and grandfathering promises;
14. verified/audited grant or claim records for any pre-launch Founder who already paid;
15. provider hard/contract limit source references and country/policy eligibility for every monetary provider;
16. provider contract/reconciliation/reporting configuration before a new provider is production-enabled.

---

# 158. PHASE 1 — FOUNDATION

Build/maintain:

- monorepo;
- pnpm;
- strict TS config;
- lint/format;
- Docker local stack;
- PostgreSQL;
- Redis;
- Temporal dev;
- CI;
- OpenTelemetry;
- error tracking;
- config/environment validation;
- deployable Mini App/Admin/API/Bot/Worker/Signer boundaries;
- boundary/secret/migration validation scaffolding.

V1.2 additions at this phase only if not already present and needed for the archive process:

- `.gitignore` entry for `phase-archives/`;
- cross-platform phase archive/checksum helper or documented `git archive` procedure.

Do NOT implement financial/product business logic merely to satisfy V1.2 during Phase 1.

Gate:

- all applications/packages build;
- relevant processes boot;
- health/readiness gates pass against the full dependency stack;
- Postgres/Redis/Temporal/Worker verified;
- CI quality + Docker smoke green;
- clean-clone/frozen-install validation passes;
- no Phase 2 financial schema/business implementation;
- no production secrets;
- Signer remains isolated with signing disabled.

Archive gate: create `phase-archives/PHASE_01_FOUNDATION/` ZIP/report/checksum from the exact accepted commit, verify extraction, then stop.

---

# 159. PHASE 2 — DATABASE BASELINE

Build migrations and persistence baseline for the approved V1.1 schema plus V1.2 domain foundations.

Include:

- migrations framework;
- networks/assets;
- users/profile/settings/session foundations;
- audit;
- idempotency;
- Transactional Outbox/Inbox;
- existing V1.1 provider/ad/reward/ledger/withdrawal/risk/referral/task/support schema foundations required by the master spec;
- fixtures;
- constraints/indexes/nullable uniqueness strategy;
- `ledger_account_balances` projection schema where this phase owns the physical table, without implementing Phase 4 posting behavior yet;
- membership tables from 156B;
- entitlement tables;
- membership claim/grant history;
- provider contract metadata;
- provider limit-rule version schema;
- provider capability/manifest persistence needed by later adapters;
- country/provider rule schema;
- provider certification result schema;
- provider settlement/reporting import schema;
- trust snapshot schema;
- eligibility-decision schema if persisted;
- review case/event schema;
- mission definition/version/progress/claim schema;
- notification campaign/delivery schema;
- feature-flag/version schema;
- economics/budget tables needed by later phases.

Rules:

- no mutable `users.balance`;
- all money amounts atomic integer/string-safe;
- no generic executable-rule/eval schema;
- no real reward/withdrawal/payout behavior yet;
- forward migrations tested;
- seeded-upgrade migration tested;
- constraints tested against duplicate Founder numbers, duplicate claim consumption, duplicate provider rule versions/overlaps where disallowed, and financial uniqueness rules.

Gate:

- clean migration from zero passes;
- migration on seeded DB passes;
- rollback/recovery strategy documented;
- schema lint/constraints tests pass;
- no secrets or production identifiers embedded;
- all new V1.2 tables have documented ownership/authority semantics.

Archive gate: create `PHASE_02_DATABASE_BASELINE` archive and stop.

---

# 160. PHASE 3 — TELEGRAM AUTH + MEMBERSHIP IDENTITY BINDING

Build validated Telegram `initData`, users, sessions, locale and throttles.

Tests:

- invalid signature;
- modified user;
- stale auth date;
- malformed initData;
- session rotation/revocation;
- Telegram ID representation safety.

Add only identity-safe Founder flows:

- authenticated user can view membership status/benefits metadata;
- one-time Founder claim code can be submitted after Telegram authentication;
- claim code secret/hash validation;
- atomic single-use consumption;
- unique Founder number binding;
- duplicate/replay claim rejected;
- Owner-grant path remains admin-only/audited;
- membership claim cannot award money directly.

Gate:

- spoofed Telegram identity rejected;
- claim-code replay/race cannot duplicate membership;
- no membership status can bypass account/security state.

Archive gate: create `PHASE_03_TELEGRAM_AUTH_MEMBERSHIP_BINDING` archive and stop.

---

# 161. PHASE 4 — LEDGER CORE

Build Ledger before Ads and payouts.

Features:

- accounts;
- transactions;
- entries;
- atomic posting;
- linked reversal transactions;
- transactionally maintained/rebuildable balance projection;
- database-enforced immutability;
- invariant checker;
- deterministic account locking;
- business-reference/idempotency uniqueness;
- membership bonus expense account classification support without issuing bonuses yet.

Gate:

- invariant suite;
- concurrency suite;
- protected Pending/Available/Reserved non-negative;
- rollback correctness;
- rebuild projection equals immutable entries;
- UPDATE/DELETE of posted ledger records rejected for application role;
- reversal never mutates original transaction.

Archive gate: create `PHASE_04_LEDGER_CORE` archive and stop.

---

# 162. PHASE 5 — REWARD ENGINE + BONUS BUDGETS

Build:

- rules/versions;
- exact integer-only FLOOR arithmetic;
- quotes;
- atomic quote budget reservations;
- Pending/Available lifecycle;
- maturity;
- simulated reward source;
- Owner reward configuration;
- V1.2 membership/Founder bonus rule resolution;
- separate membership bonus reward events/accounting;
- membership/referral/mission/global exposure budget primitives;
- economic guardrails and minimum-margin decision surface;
- version snapshot/audit for every applied economic rule.

Required Founder behavior:

- initial proposed eligible bonus profile supports +5%/500 bps but remains versioned/configurable;
- bonus is platform-funded and separate from provider revenue;
- bonus cannot exceed configured budget/cap;
- Founder status cannot bypass provider limits or fraud;
- valid base reward accounting remains correct if bonus is unavailable according to the approved pre-start quote policy.

Gate:

- client cannot create arbitrary reward;
- all arithmetic uses integer-safe exact formula;
- duplicate source creates at most one reward;
- budget reservation/release is idempotent;
- Founder bonus has separate source/accounting and cannot double-credit;
- margin/exposure circuit breaker blocks new quotes safely.

Archive gate: create `PHASE_05_REWARD_ENGINE` archive and stop.

---

# 163. PHASE 6 — TON CONNECT WALLET OWNERSHIP

Build TON Connect + `ton_proof`, nonce, replay prevention, accepted-network validation, primary wallet and 24h change cooldown.

Gate:

- valid proof accepted;
- replay rejected;
- wrong domain rejected;
- expired proof rejected;
- invalid wallet rejected;
- unacceptable network rejected;
- wallet change emits security event and starts cooldown;
- membership does not bypass wallet proof/cooldown.

Archive gate: create `PHASE_06_TON_WALLET_OWNERSHIP` archive and stop.

---

# 164. PHASE 7 — WITHDRAWAL ENGINE WITH FAKE CHAIN + ENTITLEMENT FEE/Priority

Build full corrected withdrawal state machine against deterministic fake blockchain.

Includes:

- withdrawal quote lifecycle;
- fixed configurable fee and versioned fee rules;
- 0.20 minimum;
- max/hour/day/Hot Wallet volume limits;
- Available -> Reserved atomic transaction;
- manual approval;
- Temporal workflow started from Outbox with deterministic workflow ID;
- attempts;
- ambiguous result simulation;
- `RECONCILE_REQUIRED`;
- reconciliation;
- `WithdrawalRiskPolicy` deterministic V1/manual-review behavior;
- Founder/member fee entitlement resolution;
- priority review flag/queue projection.

Rules:

- Founder fee benefit modifies only approved platform-fee calculation; it does not erase network accounting;
- Founder priority does not skip risk/manual approval/security;
- no ordinary user cancellation after reservation unless the corrected state machine explicitly permits it;
- unknown possible broadcast never returns Reserved to Available and never blindly retries.

Gate:

- all concurrency/failure tests green;
- duplicate request cannot double reserve;
- fee entitlement version reconstructable;
- priority cannot bypass review state;
- ambiguous payout preserves Reserved.

Archive gate: create `PHASE_07_WITHDRAWAL_ENGINE_FAKE_CHAIN` archive and stop.

---

# 165. PHASE 8 — TELEGRAM ADMIN CONTROL CENTER + UNIFIED REVIEW QUEUE

Build all approved Topics and secure Owner action tokens.

Add review operations for:

- withdrawal approval/hold/reject;
- fraud review;
- reconciliation issues;
- provider anomalies;
- invalid traffic;
- Founder claim/reassignment issues;
- referral abuse;
- support escalation.

Membership admin controls:

- search Founder/member;
- audited direct Founder grant for verified pre-launch payment;
- generate one-time claim code;
- view Founder number/history;
- no direct reward/balance mutation.

Gate:

- unauthorized Telegram account cannot execute action;
- wrong chat/topic/token/resource/state rejected;
- duplicate approval cannot duplicate workflow;
- duplicate grant/claim cannot duplicate Founder membership;
- review queue action calls authoritative domain command rather than directly mutating money.

Archive gate: create `PHASE_08_CONTROL_CENTER_REVIEW_QUEUE` archive and stop.

---

# 166. PHASE 9 — TON TESTNET SIGNER SPIKE

Build/validate the separate `apps/signer` boundary and KMS compatibility test.

General API/Bot/Admin/Worker processes must not have `kms:Sign`.

Test:

- KMS Ed25519 signing compatibility;
- Wallet V5 R1 address/state;
- canonical message reconstruction;
- identical attempt -> identical signable message;
- signer independently validates withdrawal snapshot/attempt/network/asset/master/recipient/net amount/query ID/limits;
- signer has no public ingress, no DB write, no TON broadcast egress.

If technically approved, continue with KMS.

If not, use only the formally reviewed fallback signer.

No mainnet.

Archive gate: create `PHASE_09_TON_TESTNET_SIGNER_SPIKE` archive and stop.

---

# 167. PHASE 10 — TON TESTNET PAYOUT SYSTEM

Integrate actual Testnet.

Run:

- 100+ automated controlled payouts;
- crash before broadcast;
- crash after broadcast;
- RPC timeout;
- confirmation delay;
- primary/secondary-provider reconciliation;
- Hot Wallet monitoring;
- full TEP-74 recipient/amount/master/query-ID confirmation rather than seqno-only confirmation;
- dispatcher lease/fencing tests;
- post-restore payout-paused reconciliation procedure.

Gate: one economic payout per withdrawal under failure/concurrency tests, no blind resend path.

Archive gate: create `PHASE_10_TON_TESTNET_PAYOUT` archive and stop.

---

# 168. PHASE 11 — ADSGRAM + PROVIDER FRAMEWORK FOUNDATION

Build AdsGram without coupling the core platform to AdsGram-only constants.

Build:

- Provider Adapter/SDK contracts;
- provider manifest/capability registry;
- AdsGram adapter;
- block config;
- official React/SDK integration;
- sessions;
- one active session;
- dynamic provider request/success limit evaluation;
- default current AdsGram values from versioned config (`25` successful platform opportunity default and `30` provider request safety value while approved basis remains current);
- no-fill;
- dynamic quote;
- client event;
- Reward URL correlation;
- health;
- reward posting;
- independent client/provider signal records and derived aggregate state;
- explicit provider monetary eligibility capability gate;
- provider contract/policy metadata integration;
- provider certification harness cases relevant to AdsGram;
- admin-readable provider limit source/version.

Hard requirement:

**Do not hardcode `30` or `25` into provider-independent business logic.** Default/approved rules are data/config versions. If AdsGram later approves 100 requests/day, updating the approved provider rule must not require rewriting the reward/ledger system.

Gate:

- no click reward;
- no failed-ad/no-fill reward;
- no duplicate reward;
- no client-only credit;
- production debug disabled;
- moderation requirements met where testable;
- provider hard limit cannot be bypassed by Founder/tier;
- changing a test provider limit `30 -> 100` through a new rule version changes effective authorization correctly without code change;
- old sessions/quotes remain reconstructable under old rule versions.

Production monetary reward enablement remains BLOCKED until the existing AdsGram clarification gate passes.

Archive gate: create `PHASE_11_ADSGRAM_PROVIDER_FRAMEWORK` archive and stop.

---

# 169. PHASE 12 — USER MINI APP UI + FOUNDER EXPERIENCE

Build:

- Home;
- Earn;
- Tasks/Missions;
- Friends;
- Wallet;
- Profile/Settings;
- AR/EN/RU;
- RTL;
- accessibility;
- loading/error/degraded states;
- membership/Founder badge and Founder number;
- Founder benefit summary;
- one-time Founder claim flow for eligible pre-launch purchasers;
- clear variable-reward/no-guaranteed-earnings wording;
- provider availability/remaining limits without overpromising inventory.

User-facing Founder benefits must reflect server-resolved entitlements and current documented rules, not frontend constants.

Gate: E2E standard-user + Founder-user flows pass; frontend cannot fabricate membership/benefit/reward state.

Archive gate: create `PHASE_12_MINIAPP_UI_FOUNDER` archive and stop.

---

# 170. PHASE 13 — ADMIN WEB DASHBOARD + POLICY/ECONOMICS/PROVIDER OPERATIONS

Build existing Admin areas:

- Overview;
- Users;
- User detail;
- Withdrawals;
- Hot Wallet;
- Ledger;
- Ads;
- Reward Engine;
- Fraud;
- Referral;
- Support;
- Notifications;
- Audit;
- System;
- Settings.

Add V1.2 areas:

- Memberships / Founders;
- Founder claims/grants/history;
- Entitlements/benefit rule versions;
- Policy Center;
- Providers;
- Provider contracts;
- Provider capabilities;
- Provider limits with old/new diff, source reference, effective time and impact preview;
- Provider certification results;
- Country/provider rules;
- Provider settlement/reconciliation;
- Economics dashboard;
- exposure/budget controls;
- unified Review Queue;
- granular feature flags/kill switches;
- Mission administration foundation;
- notification campaign foundation.

Security:

- Passkey/WebAuthn primary;
- password + TOTP fallback;
- recovery codes;
- reauthentication for high-impact changes;
- financial/provider-limit/membership-benefit changes audited and second-confirmed where configured.

Gate:

- Owner auth/RBAC tests pass;
- no direct balance editor;
- no Admin control can exceed provider hard limit;
- Founder grant/benefit changes are audited/versioned;
- economics separates estimates from realized/settled amounts.

Archive gate: create `PHASE_13_ADMIN_POLICY_ECONOMICS` archive and stop.

---

# 171. PHASE 14 — FRAUD ENGINE V1 + TRUST / ELIGIBILITY

Build multi-signal Fraud/Risk score, withdrawal decisions, referral/ad/wallet risk and Admin review.

Add:

- separate Trust snapshots/state;
- Eligibility Engine reason codes;
- membership is a benefit input, never a trust/fraud bypass;
- provider/country/mission eligibility;
- risk/trust rule version snapshots;
- adverse action auditability.

Gate:

- no single weak signal automatically bans user;
- Founder cannot bypass CRITICAL/hard security blocks;
- Trust cannot override required Fraud/Risk hold;
- eligibility decisions are deterministic/reason-coded for same versioned inputs.

Archive gate: create `PHASE_14_FRAUD_TRUST_ELIGIBILITY` archive and stop.

---

# 172. PHASE 15 — REFERRAL V1 + MEMBERSHIP ENTITLEMENT

Build:

- link/code;
- one-time attribution;
- pending;
- 24h + 5 valid-ad activation defaults;
- Level 1 configurable rate;
- maturity;
- originating reward reversal behavior;
- Founder/membership referral-rate entitlement;
- separate platform-funded referral expense/budget.

Gate:

- no self referral;
- no duplicate attribution;
- invitee reward unchanged;
- Founder profile cannot duplicate bonus on retries;
- referral bonus respects budget and source eligibility.

Archive gate: create `PHASE_15_REFERRAL_MEMBERSHIP` archive and stop.

---

# 173. PHASE 16 — MISSION ENGINE / BASIC TASKS

Implement the generic Mission Engine while delivering required V1 tasks:

- Daily Login;
- Complete 3 valid rewarded ads;
- Complete 10 valid rewarded ads;
- Streak milestone.

Add:

- versioned mission definitions;
- progress/idempotency;
- reset policies;
- start/end windows;
- eligibility by country/membership where approved;
- Founder-exclusive mission capability;
- mission reward budgets;
- Admin creation for allowlisted mission types.

Monetary mission reward always Reward Engine -> Ledger.

Gate:

- client cannot self-claim unmet monetary mission;
- progress replay cannot duplicate reward;
- Founder-only mission cannot be claimed by ineligible account;
- rule changes create versions.

Archive gate: create `PHASE_16_MISSION_ENGINE` archive and stop.

---

# 174. PHASE 17 — PUBLIC PAYOUT LOGS

Build confirmed-only publication, privacy setting, explorer link, unique publication and retries.

Founder display must still respect the user's payout-public identity preference; Founder status is not permission to expose identity/wallet.

Gate: no duplicate logs; no publication before confirmed payout; privacy respected.

Archive gate: create `PHASE_17_PUBLIC_PAYOUT_LOGS` archive and stop.

---

# 175. PHASE 18 — OBSERVABILITY / DR / BUSINESS HEALTH

Complete:

- alerts;
- dashboards;
- backups/PITR;
- isolated restore drill;
- incident runbooks;
- payout pause;
- signer rotation docs;
- provider health/limit alarms;
- provider settlement/reconciliation alerts;
- reward/budget exposure alerts;
- Founder bonus budget alerts;
- Review Queue backlog alerts;
- archive/restore documentation.

Gate: successful restore drill with payout dispatch paused and blockchain/ledger/withdrawal/attempt/outbox/workflow reconciliation required before resume.

Archive gate: create `PHASE_18_OBSERVABILITY_DR` archive and stop.

---

# 176. PHASE 19 — SECURITY REVIEW

Full pre-mainnet security review covering Version 1.1 critical paths plus V1.2:

- membership claim code security/replay;
- entitlement escalation;
- Founder admin grant/reassignment;
- provider adapter/webhook trust;
- provider hard-limit override attempts;
- Policy Center authorization;
- mission claim abuse;
- notification targeting leakage;
- feature-flag misuse;
- Review Queue authorization.

Mainnet blocked until Critical/High findings are resolved or explicitly accepted with documented mitigation where policy permits.

Archive gate: create `PHASE_19_SECURITY_REVIEW` archive and stop.

---

# 177. PHASE 20 — CLOSED BETA / MINIMAL FUNDS

Use internal/approved testers and minimal financial exposure.

Validate:

- provider moderation/compliance status;
- reward economics;
- no-fill;
- UI;
- fraud/trust/eligibility;
- support;
- Founder claim/benefit behavior with controlled accounts;
- budget/exposure controls;
- provider-limit version changes in staging;
- notification/mission behavior.

No unsupported provider may be production-money enabled.

Archive gate: create `PHASE_20_CLOSED_BETA` archive and stop.

---

# 178. PHASE 21 — MAINNET MICRO-LAUNCH

Create fresh production signer/Hot Wallet.

Fund initially only a very small amount, approximately 5-10 USDT plus required TON gas.

Manual approval only.

Observe every payout and reconcile.

Founder/member withdrawals remain subject to the same security and reconciliation gates.

Gate: at least 50 confirmed real withdrawals with zero duplicate payout, unexplained reconciliation difference, or ledger invariant violation before expansion.

Archive gate: create `PHASE_21_MAINNET_MICRO_LAUNCH` archive and stop.

---

# 179. PHASE 22 — CONTROLLED BETA

Gradual cohorts:

- 50 users;
- 250;
- 1,000;
- then larger only after approved evidence.

Measure:

- revenue;
- base reward cost;
- Founder/membership bonus cost;
- referral/mission cost;
- fraud/invalid traffic;
- payout latency;
- support volume;
- coverage;
- provider fill/completion;
- country/provider margin;
- Founder cohort economics;
- retention.

Do not auto-increase provider/platform limits merely because user count grows.

Archive gate: create `PHASE_22_CONTROLLED_BETA` archive and stop.

---

# 180. PHASE 23 — TRUSTED AUTO-PAYOUT

Only after real production evidence.

Enable conservative trusted-user auto payout using:

- Trust state;
- Fraud/Risk state;
- wallet age/cooldown;
- confirmed payout history;
- amount/volume limits;
- system health;
- Hot Wallet liquidity;
- kill switch.

Founder status alone never qualifies a user for auto payout.

Never auto-increase limits based solely on growth.

Archive gate: create `PHASE_23_TRUSTED_AUTO_PAYOUT` archive and stop.

---

# 181. PHASE 24 — SECOND / MULTI-PROVIDER PRODUCTION ONBOARDING

After a second provider gives written approval for the exact rewarded/incentivized cash/crypto model:

1. create Provider Contract Registry record;
2. implement adapter under Provider SDK;
3. define capability manifest;
4. define signed/server evidence model;
5. record provider hard limits as versioned rules;
6. configure country eligibility;
7. configure economics/reward rule groups;
8. pass provider certification harness;
9. run sandbox/test traffic;
10. configure reporting/settlement reconciliation;
11. obtain limited-production approval;
12. enable kill switch/health monitoring;
13. launch controlled percentage/cohort.

Never apply AdsGram policy to another provider automatically.

Gate:

- provider adapter certification green;
- no duplicate/client-only reward path;
- provider hard limits enforced;
- settlement/reconciliation test passes;
- production monetary status explicitly APPROVED.

Archive gate: create `PHASE_24_MULTI_PROVIDER_ONBOARDING` archive and stop.

---

# 182. PHASE 25 — SMART ROUTING / FAILOVER OPTIMIZATION

After at least two production-approved providers and real metrics exist, enable controlled routing optimization.

Potential routing factors:

- country eligibility;
- provider health;
- fill rate;
- completion rate;
- eCPM/revenue estimate;
- expected contribution margin;
- provider/user limits;
- contract status;
- risk/eligibility.

Rules:

- routing strategy versioned;
- no started-session unsafe provider switch;
- no hard-limit override;
- no routing to BLOCKED/TEST_ONLY/SUSPENDED provider;
- routing telemetry/reason codes retained;
- manual global/provider override available.

Gate: deterministic routing tests, failover/no-fill tests and economics guardrail tests pass.

Archive gate: create `PHASE_25_SMART_ROUTING` archive and stop.

---

# 183. PHASE 26 — ADVANCED GAMIFICATION

Add later, budget-controlled:

- Levels;
- XP;
- Achievements;
- Weekly League;
- Promo Codes;
- Lucky Wheel free daily spin only;
- Founder competitions where configured.

All monetary rewards use Reward Engine -> Ledger and explicit budgets.

No paid gambling/wagering mechanic.

Archive gate: create `PHASE_26_ADVANCED_GAMIFICATION` archive and stop.

---

# 183A. PHASE 27 — SPONSORED TASKS

Admin-created campaigns first.

Build:

- advertiser/campaign metadata;
- campaign budgets/reservations;
- allowlisted verified action types;
- user reward;
- platform margin;
- targeting/eligibility;
- fraud/abuse protections;
- settlement/reporting;
- mission integration where appropriate.

Never overspend campaign budget.

Archive gate: create `PHASE_27_SPONSORED_TASKS` archive and stop.

---

# 183B. PHASE 28 — MEMBERSHIP EXPANSION (FUTURE)

Only after Founder economics/support data exists and the Owner approves a commercial model.

Possible:

- Premium Monthly;
- Premium Yearly;
- Partner;
- Influencer.

Use the same membership/entitlement architecture. Do not create duplicate reward or withdrawal systems per tier.

Subscription billing/payment integration is a separate reviewed scope and must comply with platform/legal/payment-provider requirements.

Archive gate: create `PHASE_28_MEMBERSHIP_EXPANSION` archive and stop.

---

# 183C. PHASE 29 — ADVERTISER SELF-SERVICE PORTAL (FUTURE)

Only after Admin-created sponsored campaigns are stable.

Potential:

- advertiser auth;
- funded balance/billing;
- campaign creation;
- targeting;
- budget;
- analytics;
- pause/resume;
- billing/settlement history;
- review/moderation.

Do not let advertiser-facing systems directly mutate user balances or bypass campaign budget reservation.

Archive gate: create `PHASE_29_ADVERTISER_PORTAL` archive and stop.

---

# 183D. PHASE 30 — SCALE / ADDITIONAL NETWORKS (FUTURE)

Only when justified by measured load/business need.

Potential:

- PostgreSQL read replicas;
- event-table partitioning;
- data warehouse;
- multiple Hot Wallets with independent dispatchers;
- additional approved providers;
- additional payout assets/networks;
- provider-ingestion separation;
- advanced fraud analytics.

Do not prematurely split the core immutable financial ledger into distributed microservices.

Every new payout network/asset requires its own custody, confirmation, idempotency, reconciliation and security specification before production.

Archive gate: create `PHASE_30_SCALE_NETWORKS` archive and stop.

---

# 184. FAILURE MATRIX

| Failure | Required behavior |
|---|---|
| AdsGram client completion duplicated | One reward max |
| AdsGram Reward URL duplicated | Idempotent signal; one reward max |
| Client claims completion without provider evidence | Record untrusted evidence only; never issue money |
| AdsGram provider authenticity/correlation remains unclear | Production monetary status stays `BLOCKED` |
| Provider signal arrives before client signal | Preserve provider evidence; wait for complete required set |
| Provider signal is late or correlates ambiguously | Quarantine/reconciliation issue; no reward |
| Browser authorization occurs but provider request cannot be proven | Apply only the provider-approved counting policy; never trust it for reward issuance |
| No Fill | No reward; provider request count only if actual request made |
| Redis disappears | No financial loss/corruption |
| Reward quote expires before valid ad start | Release budget reservation once; no reward |
| Reward rule changes during active ad | Existing started quote and budget reservation remain |
| Concurrent reward-budget quotes | Atomic budget lock prevents over-reservation |
| Reward maturity workflow repeats | One maturity transaction only |
| DB transaction fails during withdrawal creation | Full rollback |
| Withdrawal client times out after commit | Same idempotency key returns original withdrawal |
| Concurrent withdrawals exceed Available | Account-balance lock permits only funded reservations |
| Owner rejects definitively pre-broadcast withdrawal | Full gross Reserved amount returns to Available atomically |
| Owner presses Approve twice | One approval/workflow |
| Telegram callback replay | Already processed / reject |
| Worker crashes before definite broadcast | Controlled safe retry |
| Worker crashes after possible broadcast | Reconcile, never blind resend |
| TON RPC times out after send | Reconcile |
| TON confirmation delayed | Stay confirming |
| Seqno advances without matching Jetton transfer | Do not confirm; reconcile |
| External message is included but Jetton transfer fails/bounces | Do not confirm; prove non-payment before retry or rejection |
| Recipient/amount/master/query ID mismatch | Critical reconciliation issue; never confirm intended withdrawal |
| Primary chain provider down | Secondary or safe pause |
| Chain data providers disagree | Manual/reconciliation state |
| Hot Wallet USDT low | Queue/hold + alert |
| Hot Wallet TON low | Stop dispatch + alert |
| Unknown outgoing Hot Wallet transfer | Critical + pause |
| Ledger imbalance | Critical + pause relevant financial operations |
| Current ledger projection differs from rebuilt entries | Critical + pause; immutable entries remain authoritative |
| Public Telegram payout publication fails | Finance unchanged; retry publication |
| Telegram outage | Financial backend remains correct |
| Temporal start fails after DB approval commit | Outbox retries deterministic `withdrawal/{withdrawalId}` start |
| Duplicate Temporal start | Existing deterministic workflow is reused; no second payout workflow |
| AdsGram outage | No fabricated rewards |
| User changes wallet | 24h withdrawal cooldown |
| Fee changes after withdrawal quote | Existing quote remains until expiry |
| Hot Wallet compromised | Pause, rotate, reconcile |
| General worker attempts KMS signing | IAM denial; Critical security alert |
| Signer receives mismatched attempt/message data | Fail closed; no signature |
| Admin compromise suspected | revoke sessions, pause payouts, rotate credentials |
| Provider policy changes | Disable provider if necessary until reviewed |
| Provider invalidates Pending reward | New linked reversal |
| Provider invalidates Available reward | Explicit recovery posting, never below zero |
| Provider invalidates Reserved reward | Hold; reject only if definitively pre-broadcast, then recover |
| Provider invalidates externally paid reward | Explicit loss/recovery case; no hidden negative balance |
| Database restored from backup | Dispatch starts paused; reconcile chain/ledger/workflows/Outbox before resume |
| User deletion request | Anonymize eligible data, retain required finance/audit |

---

# 185. MAINNET RELEASE CHECKLIST

- [ ] Ledger invariant suite green
- [ ] Withdrawal concurrency suite green
- [ ] Duplicate reward suite green
- [ ] Duplicate approval suite green
- [ ] Crash-after-broadcast suite green
- [ ] TON Testnet suite green
- [ ] KMS or fallback signer formally approved
- [ ] only `apps/signer` can invoke KMS signing
- [ ] `ton_proof` suite green
- [ ] initial 0.01 USDT fixed-fee and gross-limit suites green
- [ ] 0.20 minimum green
- [ ] 25/30 AdsGram limits green
- [ ] AdsGram moderation approved
- [ ] Adult/Gambling configuration verified
- [ ] Owner Passkey/TOTP ready
- [ ] Owner Telegram allowlist ready
- [ ] Control Center ready
- [ ] payout pause tested
- [ ] backup configured
- [ ] restore drill passed
- [ ] post-restore payout pause/reconciliation gate passed
- [ ] reconciliation passed
- [ ] Hot Wallet monitoring passed
- [ ] alerts tested
- [ ] Terms/Privacy/Reward/Withdrawal rules published
- [ ] production secrets isolated
- [ ] no Testnet keys reused
- [ ] AdsGram debug disabled in production
- [ ] no placeholder financial/security code
- [ ] no unresolved Critical/High security issue without formal acceptance
- [ ] at least 50 real confirmed micro-launch withdrawals before expansion, with zero duplicate payout, unexplained reconciliation difference or ledger invariant violation

---

# 186. COMPLETE V1 USER FLOW

1. User opens Telegram Bot.
2. `/start` parses optional referral safely.
3. User opens ALEx Rewards Mini App.
4. Backend validates Telegram initData.
5. User sees Home.
6. Basic app functionality is available without ads.
7. User opens Earn.
8. API checks account status, cooldown, daily caps, active session and provider health.
9. API generates reward quote.
10. API creates ad session.
11. User intentionally taps Watch & Earn.
12. AdsGram displays rewarded ad.
13. Client reports lifecycle signal.
14. Required authenticated/corroborated provider evidence is correlated unambiguously; client-only completion cannot authorize money.
15. Backend verifies provider monetary status, session eligibility, quote, budget, risk and daily cap.
16. Reward Engine creates Pending reward through Ledger.
17. Reward matures according to hold/risk policy.
18. User connects TON wallet.
19. Backend verifies `ton_proof`.
20. User reaches at least 0.20 Available USDT.
21. User requests withdrawal quote.
22. UI shows fee and exact net amount.
23. User confirms.
24. DB atomically reserves amount.
25. Fraud Engine evaluates.
26. Withdrawal enters Manual Review.
27. Approval message appears in private Telegram topic and Admin Dashboard.
28. Owner presses Approve.
29. Backend verifies Owner and one-time token.
30. Withdrawal becomes Approved.
31. Transactional Outbox relay starts/reuses deterministic Temporal workflow `withdrawal/{withdrawalId}` and queues payout.
32. Dispatcher obtains a fenced Hot Wallet lease and wallet state/seqno.
33. Separate signer boundary independently validates the canonical attempt and signs through KMS.
34. Worker broadcasts.
35. Worker proves the intended successful TEP-74 recipient/amount/master/query-ID transfer.
36. Ambiguity -> reconciliation, never blind resend.
37. On confirmation, ledger finalizes.
38. User gets notification.
39. Internal Payouts topic gets detailed record.
40. Public Payout Logs channel publishes privacy-respecting proof.
41. Reconciliation validates the complete financial path.

---

# 187. COMPLETE V1 OWNER FLOW

Owner uses:

## Admin Web Dashboard

For deep management, analytics, user investigation, fraud, ledger, rules, support, audit and system health.

## Telegram Control Center

For immediate approvals, alerts, payout status, fraud response, wallet alerts and daily reports.

Neither UI owns financial truth.

---

# 188. EXPLICITLY OUT OF INITIAL V1

Do not delay secure launch for:

- KYC vendor;
- Level 2 referrals;
- advanced levels;
- Lucky Wheel;
- full advertiser portal;
- multiple payout networks;
- TRC20;
- native TON rewards;
- payout batching;
- microservice decomposition;
- ML fraud model;
- native iOS/Android application.

Architecture should support later additions.

---

# 189. SCALE PLAN

When justified by real load:

- PostgreSQL read replicas;
- partition high-volume event tables;
- dedicated warehouse;
- multiple Hot Wallets;
- more approved ad providers;
- provider ingestion separation;
- advanced fraud analytics;
- advertiser self-service;
- additional payout networks.

Do not prematurely distribute the core financial ledger.

---

# 190. CODING STANDARDS FOR CRITICAL MODULES

Use explicit domain types:

```text
AtomicAmount
AssetCode
WithdrawalId
LedgerTransactionId
AdSessionId
RewardQuoteId
ProviderCode
```

Requirements:

- no naked money numbers;
- no untyped provider payloads;
- exhaustive state handling;
- transactional command functions;
- typed error codes;
- comments for non-obvious safety behavior;
- regression tests adjacent to critical modules.

---

# 191. ERROR MODEL

Stable internal/user-safe errors:

```text
AD_DAILY_SUCCESS_LIMIT
AD_PROVIDER_REQUEST_LIMIT
AD_SESSION_ALREADY_ACTIVE
AD_COOLDOWN_ACTIVE
AD_NO_FILL
AD_PROVIDER_UNAVAILABLE
WALLET_NOT_VERIFIED
WALLET_COOLDOWN
INSUFFICIENT_AVAILABLE_BALANCE
WITHDRAWAL_BELOW_MINIMUM
WITHDRAWAL_LIMIT_EXCEEDED
WITHDRAWAL_QUOTE_EXPIRED
PAYOUTS_PAUSED
WITHDRAWAL_REVIEW_REQUIRED
ACCOUNT_WITHDRAWAL_BLOCKED
```

No internal stack traces to users.

---

# 192. MANUAL BALANCE ADJUSTMENTS

Owner cannot set `balance = X`.

Owner creates adjustment command:

```text
Adjustment Type
Amount
Asset
Reason
Support Ticket optional/required by policy
```

Backend posts Ledger entries.

Audit records Owner/reason.

---

# 193. ECONOMIC SAFETY RESERVE

Do not distribute 100% of estimated provider revenue.

Reserve accounts for:

- reporting lag;
- invalid-traffic adjustments;
- referral bonuses;
- task bonuses;
- network fees;
- fraud;
- operations;
- liquidity.

Exact ratios remain configurable.

---

# 194. PROVIDER INVALID-TRAFFIC POLICY

Terms and system must support provider later invalidating traffic.

Technical responses:

- hold new rewards Pending;
- Pending: create a new linked reversal transaction;
- Available: use an explicit recovery transaction and never make Available negative;
- Reserved: do not silently reverse; hold the withdrawal and, only if definitively pre-broadcast, reject/release it before the approved recovery transaction;
- risk flag user;
- investigate.

If reward was already paid externally, record an explicit platform loss/recovery case rather than rewriting history or creating a hidden negative mutation. Unpaid/maturing referral rewards linked to the invalid origin reverse through their own linked transactions.

---

# 195. PUBLIC PRIVACY

Public payout identity modes:

```text
SHOW_USERNAME
HIDE_IDENTITY
```

Never publish anti-fraud details.

---

# 196. RATE LIMITING

Apply to:

- Telegram auth;
- TON proof challenge;
- ad session creation;
- withdrawal quote;
- withdrawal request;
- support creation/messages;
- Admin login;
- Telegram admin action;
- provider webhook.

Money-sensitive operations must fail safely if Redis is unavailable.

---

# 197. USER-FACING REWARD/WITHDRAWAL RULES

Settings/help must clearly state:

- 25 successful rewarded opportunities/day;
- ad availability is not guaranteed;
- no-fill can occur;
- current minimum withdrawal;
- current withdrawal fee;
- payout network;
- wallet-change cooldown;
- Pending reward behavior;
- prohibited fraud/automation.

---

# 198. FINANCIAL REPORTING CONCEPTS

Admin must separately display:

- pending user liabilities;
- available user liabilities;
- reserved withdrawal liabilities;
- Hot Wallet actual assets;
- provider receivables;
- withdrawal fee revenue;
- estimated platform margin.

Do not call all funds "profit".

---

# 199. MAINTENANCE MODE

Feature-specific maintenance controls:

- Ads paused globally;
- individual provider paused / monetary-disabled;
- Membership/Founder bonus issuance paused;
- Referral rewards paused;
- Mission rewards paused;
- Withdrawal requests paused;
- Payout dispatch paused;
- Auto-payout paused;
- Wallet verification paused.

Avoid global outage mode unless necessary.

---

# 200. SYSTEM HEALTH PAGE

Show status for:

- API
- PostgreSQL
- Redis
- Temporal
- Telegram Bot
- AdsGram
- TON RPC primary
- TON RPC secondary
- Signer
- Hot Wallet chain sync
- Outbox lag
- Reconciliation

---

# 201. OPERATIONS RUNBOOK

Document exact Owner procedures:

1. fund Hot Wallet;
2. verify coverage;
3. approve withdrawal;
4. hold suspicious withdrawal;
5. review fraud flag;
6. pause/resume payouts;
7. change reward rule;
8. respond to AdsGram outage;
9. restore backup;
10. rotate Bot token;
11. rotate signer;
12. retire Hot Wallet;
13. handle reconciliation issue.

---

# 202. GIT / CODEX SAFETY

Protected `main`.

Critical paths deserve explicit review:

```text
packages/ledger/**
packages/withdrawals/**
packages/ton/**
packages/fraud/**
packages/auth/**
infra/**
migrations/**
```

Every financial bug fix must add a regression test that would have failed before the fix.

---

# 203. VERIFIED TECHNICAL BASIS — SEPTEMBER 2026

The architecture was chosen after checking current official documentation.

## Telegram Mini Apps

Official documentation requires validating `Telegram.WebApp.initData` on the backend and explicitly warns against trusting `initDataUnsafe` as authenticated data.

Reference:
https://core.telegram.org/bots/webapps

## AdsGram

Official Rewarded integration supports Telegram Mini Apps and a rewarded `show()` flow where reward behavior is associated with completed rewarded viewing.

Moderation documentation prohibits statistic/ad inflation behavior, requires real application functionality, disallows forced click patterns, warns against unrealistic rewards, and requires proof of reward payouts.

References:
https://docs.adsgram.ai/publisher/reward-interstitial-integration
https://docs.adsgram.ai/publisher/moderation
https://docs.adsgram.ai/publisher/get-block-id
https://docs.adsgram.ai/publisher/

Direct AdsGram support additionally confirmed that this ALEx Rewards business model can be used if compliant, that the reward must not be tied to clicking the ad, and recommended limiting ad requests to 30 per user/day.

## TON

TON Connect is the official wallet connection standard for TON dApps.

`ton_proof` provides backend wallet ownership verification using a server-issued payload/nonce.

Wallet V5 R1 uses Ed25519 signatures and seqno/wallet state.

USDT transfers on TON are Jetton transfers and token decimals must be correctly applied.

References:
https://docs.ton.org/applications/ton-connect/how-to/connect
https://docs.ton.org/applications/ton-connect/how-to/ton-proof
https://docs.ton.org/contracts/standard/wallets/v5
https://docs.ton.org/contracts/standard/tokens/jettons/transfer

## AWS KMS

AWS KMS supports Ed25519 signing with `ECC_NIST_EDWARDS25519` and keeps private key material inside KMS.

Reference:
https://docs.aws.amazon.com/kms/latest/developerguide/symm-asymm-choose-key-spec.html

This does not remove the mandatory TON Testnet compatibility spike.

## Next.js

Use latest security-patched stable Next.js 16.x available at implementation time.

Reference:
https://nextjs.org/blog/next-16

## NestJS

NestJS 12 is the selected backend framework line. Use a current Node 24 LTS patched version satisfying its tooling requirements.

Reference:
https://docs.nestjs.com/migration-guide

## Temporal

Use official Temporal TypeScript SDK/Temporal Cloud for durable critical workflows.

Reference:
https://docs.temporal.io/

---

# 204. FINAL ENGINEERING COMMANDMENT

The system must be designed so that:

- duplicated callback does not duplicate money;
- repeated approval does not duplicate money;
- crashed worker does not duplicate money;
- Redis failure does not lose money;
- Telegram outage does not corrupt money;
- blockchain timeout does not trigger blind double payment;
- provider outage does not fabricate rewards;
- Admin cannot silently rewrite balance;
- financial history remains auditable;
- every external payout is traceable from request -> reservation -> approval -> workflow -> signer -> chain -> confirmation -> ledger -> payout log.

Software can never be honestly guaranteed to contain zero bugs. The required engineering property is:

> **No ordinary single-component failure may silently create, destroy, or pay the same user money twice. Every financial ambiguity must become a visible, auditable, recoverable state.**

---

# 205. REQUIRED FIRST CODEX RESPONSE BEFORE WRITING CODE

When Codex first receives this specification, it MUST NOT immediately implement the application.

Its first work product must:

1. Restate the architecture.
2. Produce the final monorepo tree.
3. Produce ERD/schema plan.
4. Produce exact ledger account model.
5. Produce exact withdrawal transition matrix.
6. Produce exact ad-session transition matrix.
7. Produce Reward Engine rule model.
8. Produce TON KMS signer spike plan.
9. Produce Telegram Control Center event/topic map.
10. Produce Failure Matrix.
11. Produce Test Matrix.
12. List any conflict, unclear requirement, or security concern.
13. Wait for approval before Phase 1.

Codex must explicitly confirm:

> "I will not implement a directly mutable user balance as the financial source of truth. I will use the immutable PostgreSQL double-entry ledger, server-side idempotency, durable payout workflows, and reconciliation defined in the ALEx Rewards specification."

---

# 206. PROJECT COMPLETION DEFINITION

ALEx Rewards V1 is production-ready only when:

- AR/EN/RU Mini App works;
- Telegram auth is server-validated;
- AdsGram flow is moderated/compliant;
- 25/30 limits work;
- dynamic Reward Engine works;
- Pending/Available/Reserved works;
- Referral Level 1 works;
- TON wallet proof works;
- 0.20 minimum works;
- user-paid fee works;
- manual Owner approval works;
- TON mainnet micro-launch gates pass;
- Hot Wallet is isolated from Treasury;
- no private key appears in frontend/API/Admin;
- payout reconciliation works;
- public confirmed payout logs work;
- private Control Center works;
- Admin Dashboard works;
- Fraud V1 works;
- Support works;
- Audit works;
- backups and restore work;
- monitoring/alerts work;
- payout pause works;
- ledger invariants remain green;
- failure-injection suite demonstrates no known duplicate payout path;
- Founder Lifetime membership, claim/grant history and entitlement resolution work for pre-launch/manual purchasers;
- Founder benefits are server-resolved, versioned, budgeted and do not bypass fraud/provider/payout security;
- provider request/success limits are versioned configuration rather than hardcoded core business logic;
- a tested limit change such as `30 -> 100` can be applied through approved provider-rule versioning without rewriting reward/ledger logic;
- Provider Adapter/Capability/Certification architecture is active for AdsGram and ready for a second approved provider;
- Policy Center, economic exposure controls and granular kill switches are auditable;
- Trust and Eligibility remain separate from Fraud/Risk and membership;
- Mission Engine safely delivers the required V1 tasks;
- phase archive exists and validates for every completed/accepted phase.

---

# APPENDIX A — STATE TRANSITION RULES

## A.1 Ad Session Allowed Transitions

The aggregate state is derived from independent append-only client/provider/system evidence. The normal progression is:

```text
CREATED -> QUOTED -> AUTHORIZED -> REQUESTED
REQUESTED -> LOADED | NO_FILL | FAILED | EXPIRED
LOADED -> STARTED | FAILED | EXPIRED
STARTED -> CLIENT_COMPLETION_RECEIVED | PROVIDER_CONFIRMATION_RECEIVED | SKIPPED | FAILED | EXPIRED
CLIENT_COMPLETION_RECEIVED -> PENDING_VERIFICATION only when the required provider evidence is also present
PROVIDER_CONFIRMATION_RECEIVED -> PENDING_VERIFICATION only when the provider-required evidence set is complete
PENDING_VERIFICATION -> VERIFIED | REJECTED | EXPIRED
VERIFIED -> REWARDED
```

Provider signals may arrive before or after client signals. The corresponding evidence record is preserved regardless of current aggregate state. No ordering variation may skip authenticity, correlation, quote, budget, cap, risk or idempotency checks. Client-only evidence cannot issue money.

Terminal states:

```text
REWARDED
NO_FILL
FAILED
SKIPPED
REJECTED
EXPIRED
```

A terminal session cannot create a second reward.

## A.2 Withdrawal Allowed Transitions

```text
DRAFT -> QUOTED
QUOTED -> REQUESTED | CANCELLED | EXPIRED
REQUESTED -> RISK_CHECK
RISK_CHECK -> MANUAL_REVIEW | HELD | REJECTED
RISK_CHECK -> APPROVED only under a future explicitly enabled automatic policy
MANUAL_REVIEW -> APPROVED | HELD | REJECTED
APPROVED -> QUEUED | HELD
HELD -> MANUAL_REVIEW | APPROVED | REJECTED
QUEUED -> SIGNING | HELD
SIGNING -> BROADCASTING | FAILED_PRE_BROADCAST
FAILED_PRE_BROADCAST -> QUEUED | HELD | REJECTED
BROADCASTING -> BROADCASTED | RECONCILE_REQUIRED
BROADCASTED -> CONFIRMING | RECONCILE_REQUIRED
CONFIRMING -> CONFIRMED | RECONCILE_REQUIRED
RECONCILE_REQUIRED -> CONFIRMED | QUEUED | HELD
```

`DRAFT`, `QUOTED`, `CANCELLED`, and `EXPIRED` are physically quote lifecycle states; the withdrawal row begins at `REQUESTED`. After reservation, ordinary user cancellation is unavailable.

Any transition to `REJECTED` requires definitive proof that no payment occurred and atomically returns the full gross Reserved amount to Available. Never transition an ambiguous possible broadcast directly to a fresh signing attempt. `RECONCILE_REQUIRED -> QUEUED` requires recorded proof that non-payment occurred and retry is safe.

If `HELD` was reached from `RECONCILE_REQUIRED`, `HELD -> APPROVED` and `HELD -> REJECTED` require the same recorded non-payment proof. Otherwise the withdrawal remains held/reconciling.

---

# APPENDIX B — TELEGRAM CONTROL CENTER EVENT MAP

| Event | Topic | Severity | Buttons |
|---|---|---|---|
| Withdrawal needs Owner | Approvals | Action | Approve / Hold / Reject / View |
| Withdrawal confirmed | Payouts | Info | Explorer / View |
| Low Hot Wallet | Wallet + Warnings | Warning | Open Dashboard |
| Very low TON gas | Wallet + Critical if blocking | Warning/Critical | Pause / Open |
| High-risk withdrawal | Fraud | High | Hold / Freeze / View |
| Ledger mismatch | Critical | Critical | Pause already/acknowledge |
| AdsGram fill drop | Ads | Warning | View provider |
| Provider recovered | Ads | Resolved | View |
| Daily summary | Reports | Info | Open dashboard |
| Support escalation | Support | Action | Open ticket |
| Owner setting change | Audit | Info | View audit |
| Worker/DB incident | System/Critical | Based on severity | Open status |

---

# APPENDIX C — USER SCREEN ACCEPTANCE CRITERIA

## Home

- Correct balance buckets from server.
- No client balance calculation from transaction history as authoritative.
- Daily counters reflect server UTC day.
- Graceful provider outage message.

## Earn

- Button disabled during active session/cooldown.
- Shows no-fill without reward.
- Prevents starting after 25 successful rewards or 30 AdsGram provider requests.
- Does not display permanent guaranteed reward value if reward is dynamic.

## Tasks

- Server validates completion.
- Monetary claim is idempotent.

## Friends

- Shows pending vs active referrals.
- Shows referral rule percentage from current config.
- Explains invitee does not lose reward.

## Wallet

- TON Connect.
- Verified status.
- Wallet-change cooldown warning.
- Pending/Available/Reserved.
- Withdrawal quote with exact fee/net.
- Withdrawal history.

## Profile

- language selection AR/EN/RU;
- payout privacy preference;
- Terms/Privacy links;
- Support;
- account deletion request.

---

# APPENDIX D — ADMIN DASHBOARD ROUTES

Recommended:

```text
/admin
/admin/users
/admin/users/:id
/admin/withdrawals
/admin/withdrawals/:id
/admin/ledger
/admin/ads
/admin/rewards
/admin/referrals
/admin/tasks
/admin/fraud
/admin/wallet
/admin/reconciliation
/admin/support
/admin/notifications
/admin/audit
/admin/system
/admin/settings
```

Every route performs server-side authorization.

---

# APPENDIX E — CODING REVIEW CHECKLIST FOR FINANCIAL PRS

Reviewer/Codex must answer:

1. What money can this PR move?
2. What DB transaction protects it?
3. What unique/idempotency constraint protects retries?
4. What happens if process dies before commit?
5. What happens if process dies after external side effect?
6. Can the client forge the amount/state?
7. Can Admin action be replayed?
8. Can provider callback be duplicated?
9. Does Ledger remain balanced?
10. Is reversal behavior defined?
11. Is reconciliation updated?
12. Are metrics/alerts updated?
13. Is there a regression test?
14. Is migration backwards-compatible?
15. Are secrets/logs safe?

If these cannot be answered, the PR is not ready.

---

# APPENDIX F — V1 FEATURE FLAGS INITIAL PRODUCTION VALUES

Conceptual initial state:

```text
ADSGRAM_ENABLED=true after moderation
WITHDRAWALS_ENABLED=true after mainnet gate
PAYOUT_DISPATCH_ENABLED=true after Owner approval
AUTO_PAYOUT_ENABLED=false
REFERRALS_ENABLED=true after referral gate
TASKS_ENABLED=true after task gate
PUBLIC_PAYOUT_LOGS_ENABLED=true
PROMOS_ENABLED=false
COMPETITIONS_ENABLED=false
LEVELS_ENABLED=false
KYC_ENABLED=false
SPONSORED_TASKS_ENABLED=false
```

Do not copy values blindly into production before release checklist approval.

---

# APPENDIX G — HOT WALLET FUNDING PROCEDURE

Owner flow:

1. Admin Dashboard shows Hot Wallet address and low-balance warning.
2. Owner opens personal Treasury wallet/Tonkeeper.
3. Owner manually sends USDT to Hot Wallet.
4. Owner ensures Hot Wallet also has sufficient TON gas.
5. Chain watcher detects incoming funds.
6. Hot Wallet snapshot updates.
7. Reconciliation matches external funding as `TREASURY_FUNDING_CLEARING`/approved funding event.
8. Dashboard updates coverage.
9. No backend private key for Treasury is ever required.

---

# APPENDIX H — MANUAL APPROVAL TO AUTOMATIC PAYOUT EVOLUTION

Stage 1:

All withdrawals manual.

Stage 2:

Low-risk small withdrawals auto-approved, but hard daily volume limit.

Stage 3:

Trusted users with history receive broader auto limits.

At every stage:

- high-risk stays manual;
- new wallet stays cooldown/manual;
- system circuit breaker overrides auto policy;
- Owner can disable auto payout instantly.

---

# APPENDIX I — MULTI-PROVIDER ROUTING FUTURE MODEL

When another approved provider exists, router considers:

```text
provider enabled
user/provider daily caps
country eligibility
provider health
fill rate
eCPM estimate
reward economics
provider policy restrictions
```

Do not route solely to highest eCPM if reliability/policy is worse.

Every provider has independent counters and reconciliation.

---

# APPENDIX J — IMPORTANT THINGS CODEX MUST NEVER DO

Codex must never:

- create a mutable `users.balance` as authoritative money;
- credit a user directly from browser `then()` callback;
- retry an uncertain TON transfer blindly;
- put Treasury seed in `.env`;
- put Hot Wallet seed in frontend;
- expose KMS permissions to normal API;
- trust Telegram `initDataUnsafe` server-side;
- trust wallet address without proof for withdrawal ownership;
- rely only on Redis for daily hard financial limits;
- delete ledger entries;
- silently fix reconciliation mismatch;
- reward ad clicks;
- promise unlimited ads;
- exceed AdsGram 30 request safety limit without updated written approval;
- implement Monetag incentivized traffic before explicit approval;
- copy PaidZ visual assets/brand;
- enable KYC in V1;
- enable auto payout in initial launch;
- enable Adult/Gambling by default;
- call an estimated margin "guaranteed profit".

---


# APPENDIX K — V1.2 CRITICAL INVARIANTS

In addition to all Version 1.1 invariants:

```text
One Founder number <= one active historical Founder identity record
One claim code <= one successful consumption
Membership status != trust status
Membership status != fraud bypass
Membership benefit != direct balance mutation
Provider hard limit >= effective platform allowance is forbidden
Provider limit change requires version + audit + approved source/reference
Provider BLOCKED/TEST_ONLY/SUSPENDED != production monetary traffic
One provider session <= one economic reward outcome
Failover before start uses a distinct session/evidence chain
Founder bonus <= approved membership bonus budget/cap
Mission claim <= one monetary reward event per eligible completion
Review Queue != financial/domain source of truth
Analytics != financial source of truth
```

---

# APPENDIX L — PROVIDER LIMIT EXAMPLE

Current approved example:

```text
Provider: ADSGRAM
Provider request hard/safety basis: 30/user/UTC day
ALEx Rewards visible successful opportunity default: 25/user/UTC day
```

Future written provider change example:

```text
New provider basis: 100 requests/user/UTC day
```

Required sequence:

1. create new provider-limit rule version;
2. attach/reference written provider basis;
3. validate no contract/legal/country rule is stricter;
4. show old/new/impact preview;
5. Owner confirms;
6. effective time activates;
7. new sessions use new rule version;
8. historical sessions retain historical rule/version;
9. no code constant replacement required.

This example does not authorize 100 until the provider actually approves it.

---

# APPENDIX M — FOUNDER USER PROMISE BOUNDARY

Safe product meaning:

```text
50 USD one-time Founder Lifetime membership
=> permanent Founder status + documented platform benefits
```

Never state or implement:

```text
50 USD investment => guaranteed return
50 USD => guaranteed monthly income
50 USD => guaranteed payback
Founder => guaranteed ad inventory
Founder => unlimited ads
Founder => bypass fraud/security
```

The system may provide a higher eligible reward profile or other benefit only under the published/configured entitlement and budget rules.

---

# APPENDIX N — PHASE HANDOFF TEMPLATE FOR CURSOR/CODEX

At the end of every phase, return:

```text
PHASE <N> COMPLETION REPORT

1. Scope completed
2. Exact changed files/modules
3. Migrations
4. Commands executed
5. Test results
6. CI results
7. Health/runtime evidence
8. Security/financial invariant evidence
9. Deviations
10. Remaining blockers
11. Git commit SHA
12. Phase archive path
13. ZIP SHA-256
14. Final gate: PASS/FAIL
```

Then stop.

Do not write:

> Starting the next phase now.

until the Owner explicitly approves.

---

# APPENDIX O — V1.2 IMPORTANT THINGS CURSOR/CODEX MUST NEVER DO

In addition to every Version 1.1 prohibition:

1. Do not describe Founder buyers as equity/profit-share investors in product logic unless a separate legally approved investment product is explicitly created later.
2. Do not promise guaranteed Founder earnings/payback.
3. Do not implement Founder benefits as scattered unaudited `isFounder` financial branches.
4. Do not let Founder/Premium status bypass Fraud/Risk, provider caps, wallet proof, cooldown, withdrawal state, signer, reconciliation or legal rules.
5. Do not hardcode AdsGram `30`, platform `25`, or future provider limits in provider-independent business logic.
6. Do not accept a provider limit from client input.
7. Do not raise a provider hard limit without recorded approved provider/contract basis.
8. Do not load arbitrary third-party provider plugin code at runtime.
9. Do not allow a provider adapter to post ledger entries directly.
10. Do not let router/failover turn one started ad into two rewardable provider sessions.
11. Do not use generic database-stored executable code/eval for policies.
12. Do not let Trust override critical Fraud/Risk blocks.
13. Do not let the Review Queue directly mutate authoritative financial state.
14. Do not let notification/analytics systems become financial truth.
15. Do not issue mission money from client progress alone.
16. Do not retroactively erase lifetime membership history.
17. Do not overwrite an older accepted phase ZIP.
18. Do not place `.env`, keys, secrets, wallet material, local DBs, Docker volumes or generated dependency/build folders inside a phase archive.
19. Do not begin a later phase until the current phase archive/gate has passed and Owner approval is explicit.

---

# END OF ALEx REWARDS MASTER SPECIFICATION
