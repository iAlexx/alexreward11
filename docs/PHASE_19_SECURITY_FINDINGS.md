# Phase 19 — Security Findings (Step 2A Remediation)

**PHASE19_STATUS:** IN_PROGRESS
**PHASE19_GATE:** HOLD
**Step 1 discovery HEAD:** `616fe53dbc30494bac0f9d9ee538a2e84b6d8307`
**Starting source HEAD:** `6c195dd826fcaa3eb720be2d6bcbb0c00e75c7af`
**Canonical Phase 18 source (unchanged):** `654a7097456d7d18ad6e6a7072793ee6d353ca33`

Step 2A applies independent-review severity/status corrections, remediates confirmed product
Mainnet blockers, runs disposable-DB security gates, and triages Critical/High dependency clusters
into findings. Cursor does **not** Owner-accept findings.

---

## Summary (recalculated after Step 2A)

| Severity | Open count | Notes |
| --- | --- | --- |
| CRITICAL | 1 | P19-SEC-019 |
| HIGH | 3 | P19-SEC-020, P19-SEC-021, P19-SEC-022 |
| MEDIUM | 2 | P19-SEC-007, P19-SEC-010 |
| LOW | 4 | P19-SEC-004, P19-SEC-005, P19-SEC-011, P19-SEC-012 |
| INFO | 2 | P19-SEC-006, P19-SEC-008 |
| **TOTAL OPEN** | **12** | |
| FALSE_POSITIVE | 2 | P19-SEC-013, P19-SEC-015 |
| RESOLVED | 8 | P19-SEC-001, 002, 003, 009, 014, 016, 017, 018 |

**Mainnet-blocking open IDs:** P19-SEC-019, P19-SEC-020, P19-SEC-021, P19-SEC-022

Product blockers 001/009/014/016/017/018 are RESOLVED in source. HOLD continues due to remaining
production-reachable Critical/High dependency findings.

---

## Category matrix (Step 2A)

| Category | REVIEWED | TEST_COVERAGE | OPEN_CRITICAL | OPEN_HIGH | OPEN_MEDIUM | OPEN_LOW | STATUS |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CATEGORY_1_MEMBERSHIP_CLAIM | YES | EXISTING + ADDED | 0 | 0 | 0 | 1 | REMEDIATED + residual LOW |
| CATEGORY_2_ENTITLEMENT_ESCALATION | YES | EXISTING + ADDED | 0 | 0 | 0 | 1 | FINDINGS |
| CATEGORY_3_FOUNDER_ADMIN | YES | EXISTING + ADDED | 0 | 0 | 1 | 0 | FINDINGS |
| CATEGORY_4_PROVIDER_TRUST | YES | EXISTING + ADDED | 0 | 0 | 1 | 1 | FINDINGS |
| CATEGORY_5_PROVIDER_LIMITS | YES | EXISTING + ADDED | 0 | 0 | 0 | 1 | FINDINGS + FP |
| CATEGORY_6_POLICY_CENTER | YES | EXISTING + ADDED | 0 | 0 | 0 | 0 | REMEDIATED |
| CATEGORY_7_MISSION_CLAIM | YES | EXISTING + ADDED | 0 | 0 | 0 | 0 | REMEDIATED |
| CATEGORY_8_NOTIFICATION_LEAKAGE | YES | EXISTING | 0 | 0 | 0 | 0 | PASS |
| CATEGORY_9_FEATURE_FLAGS | YES | EXISTING + ADDED | 0 | 0 | 0 | 0 | REMEDIATED + FP |
| CATEGORY_10_REVIEW_QUEUE | YES | EXISTING + ADDED | 0 | 0 | 0 | 0 | REMEDIATED |
| DEPENDENCY_SUPPLY_CHAIN | YES | AUDIT | 1 | 3 | 0 | 0 | FINDINGS |

---

## Explicit verification answers (Step 2A)

### MEMBERSHIP_CLAIM_CODE_ISSUE_SECOND_CONFIRMATION_PRESENT = **true**

`issueClaimCode` requires `requireConsumedConfirmation` with action `memberships.founder_claim_code_issue`,
resource `membership_plan` / `FOUNDER_LIFETIME`, payload binding `reason`, normalized `expiresAt`,
`issuedForReference`, `reserveFounderNumber`.

### POLICY_CENTER_FEATURE_FLAG_EQUIVALENT_SECURITY = **N/A (mutation disabled)**

Policy Center `FEATURE_FLAGS` returns `applied=false` / note to use dedicated typed Admin endpoint.
Only `POST /v1/admin/feature-flags` mutates flags.

### REVIEW_QUEUE_RESOLVE_DOMAIN_EVIDENCE_SERVER_VERIFIED = **N/A (HTTP action removed)**

`RESOLVE_AFTER_DOMAIN` removed from Admin public action union / HTTP switch. Lower-level helper retained
for future trusted domain callers only.

### P19_SEC_015_CONCURRENCY_FALSE_POSITIVE_CONFIRMED = **true**

Disposable-DB proof: concurrent mutations from same version → at most one commit; exactly one N+1
`feature_flag_versions` row; loser rolls back with the same transaction (UNIQUE constraint).

### P19_SEC_013_FALSE_POSITIVE_CONFIRMED = **true**

Provider limit path still requires CSRF, recent reauth, consumed confirmation, sourceType,
sourceReference, reason, expectedVersion, oldMaxCount, versioned append-only mutation, audit.
Non-hard scopes cannot exceed active hard ceiling (`wouldExceedProviderHardLimit`).

---

## Findings

### P19-SEC-001 — Admin claim-code issue missing second confirmation

- **title:** Founder claim-code issuance omits `requireConsumedConfirmation`
- **category:** CATEGORY_1_MEMBERSHIP_CLAIM
- **affected:** `apps/api/src/admin/memberships-admin.controller.ts` (`issueClaimCode`)
- **preconditions:** ACTIVE OWNER Admin session; recent reauth; CSRF; reason + expectedVersion
- **attacker capability:** Compromised/coerced Owner session that has reauth but not a second-confirmation ceremony can mint one-time Founder claim secrets
- **security impact:** Weaker ceremony than sibling high-impact Founder grant for a secret that confers Founder entitlement
- **financial impact:** Indirect — claim itself issues zero ledger money; Founder entitlement can affect fees/missions/bonuses later
- **privacy impact:** Low
- **reproduction:** Source contract — `issueClaimCode` lacks `confirmationId` / `requireConsumedConfirmation` (see discovery test)
- **mitigations:** AdminSessionGuard OWNER; CSRF; `gateHighImpactMutation`; hash-at-rest; one-time plaintext
- **severity:** HIGH
- **confidence:** HIGH
- **remediation:** Require consumed confirmation binding action/resource/payload (mirroring `grantFounder`) before `issueFounderClaimCode`
- **Mainnet blocker:** YES (was)
- **Owner acceptance permitted:** OWNER_POLICY_REQUIRED
- **status:** RESOLVED
- **resolution (Step 2A):** `requireConsumedConfirmation` enforced with action `memberships.founder_claim_code_issue`; payload binds reason / normalized expiresAt / issuedForReference / reserveFounderNumber. Missing/invalid/expired/replay/changed-intent confirmations refuse. Raw claim code returned once only; never logged/audited/persisted; zero ledger.

### P19-SEC-002 — Phase 13 matrix does not assert claim-code issue confirmation

- **title:** P13-01 file-level confirmation check misses issue-route gap
- **category:** CATEGORY_1_MEMBERSHIP_CLAIM
- **affected:** `apps/api/test/phase13-admin-security-matrix.test.ts`
- **preconditions:** N/A (test-process)
- **attacker capability:** N/A
- **security impact:** Regression detector false confidence
- **financial impact:** None directly
- **privacy impact:** None
- **reproduction:** Matrix asserts controller file contains `requireConsumedConfirmation` somewhere (satisfied by grant)
- **mitigations:** Phase 19 discovery tests add route-scoped proof
- **severity:** MEDIUM
- **confidence:** HIGH
- **remediation:** Route-scoped assertions for each high-impact mutation
- **Mainnet blocker:** NO
- **Owner acceptance permitted:** YES
- **status:** RESOLVED
- **resolution (Step 2A):** Phase 13 / Phase 19 assertions made route-scoped for claim-code issue confirmation.

### P19-SEC-003 — Claim-code issue reason not bound into domain audit

- **title:** `gated.reason` unused by `issueFounderClaimCode` from Admin issue route
- **category:** CATEGORY_1_MEMBERSHIP_CLAIM
- **affected:** `memberships-admin.controller.ts`, `packages/auth/src/membership.ts`
- **preconditions:** Successful issue
- **attacker capability:** Operator accountability gap
- **security impact:** Weak reason accountability
- **financial impact:** None
- **privacy impact:** None
- **reproduction:** Issue route computes `gated` then calls domain without reason
- **mitigations:** Hardcoded audit string still recorded
- **severity:** LOW
- **confidence:** HIGH
- **remediation:** Pass Owner reason into domain audit payload
- **Mainnet blocker:** NO
- **Owner acceptance permitted:** YES
- **status:** RESOLVED
- **resolution (Step 2A):** Domain `issueFounderClaimCode` retains Owner reason in audit evidence; raw claim code excluded; hash-only storage; zero ledger / zero reward issuance.

### P19-SEC-004 — Blocked-user status oracle on Founder claim

- **title:** Blocked users return FORBIDDEN vs CLAIM_REJECTED for bad codes
- **category:** CATEGORY_1_MEMBERSHIP_CLAIM
- **affected:** `packages/auth/src/membership.ts` claim path; API error mapping
- **preconditions:** Authenticated blocked/suspended user
- **attacker capability:** Infer account-state class from error code
- **security impact:** Minor oracle
- **financial impact:** None
- **privacy impact:** Low
- **reproduction:** Compare responses for BANNED user vs unknown code for ACTIVE user
- **mitigations:** Public messages remain generic
- **severity:** LOW
- **confidence:** MEDIUM
- **remediation:** Uniform public rejection code for claim failures where product allows (defer; not Mainnet-blocking)
- **Mainnet blocker:** NO
- **Owner acceptance permitted:** YES
- **status:** OPEN
- **Step 2A note:** Remains OPEN; not Mainnet-blocking under current evidence.

- **title:** Public membership view ACTIVE filter may diverge from financial engine expiry checks
- **category:** CATEGORY_2_ENTITLEMENT_ESCALATION
- **affected:** `packages/auth/src/membership.ts` (`getMembershipView`)
- **preconditions:** ACTIVE membership row with `expires_at` in the past (if product allows)
- **attacker capability:** Display/UX inconsistency; not proven money path
- **security impact:** Display oracle / confusion
- **financial impact:** None if engines remain authoritative (they check `expires_at`)
- **privacy impact:** Low
- **reproduction:** Source review of SELECT filters vs rewards/withdrawals/mission entitlement checks
- **mitigations:** Financial/mission engines enforce expiry / revoked independently
- **severity:** LOW
- **confidence:** MEDIUM
- **remediation:** Align view filters with engine eligibility predicates (defer; engines remain authoritative)
- **Mainnet blocker:** NO
- **Owner acceptance permitted:** YES
- **status:** OPEN
- **Step 2A note:** Remains OPEN; not Mainnet-blocking under current evidence.

- **title:** Non-FINANCIAL entitlements visible to authenticated member
- **category:** CATEGORY_2_ENTITLEMENT_ESCALATION
- **affected:** `getMembershipView` / `getEntitlements`
- **preconditions:** Authenticated session
- **attacker capability:** Read display entitlements
- **security impact:** None if FINANCIAL excluded (verified)
- **financial impact:** None
- **privacy impact:** Low
- **reproduction:** Source filter `security_classification IN ('PUBLIC','INTERNAL')`
- **mitigations:** FINANCIAL excluded; `securityBypass: false` hard-coded
- **severity:** INFO
- **confidence:** HIGH
- **remediation:** None required unless product intent changes
- **Mainnet blocker:** NO
- **Owner acceptance permitted:** YES
- **status:** OPEN

### P19-SEC-007 — Founder grant idempotency key not scoped to targetUserId

- **title:** Idempotency recovery may not bind target user
- **category:** CATEGORY_3_FOUNDER_ADMIN
- **affected:** `packages/auth/src/membership.ts` grant idempotency composition
- **preconditions:** Same admin idempotency key + reason reused with different confirmed targets
- **attacker capability:** Ops integrity confusion after dual ceremonies
- **security impact:** Integrity / operator confusion (confirmation still required per attempt)
- **financial impact:** None (zero-ledger grant)
- **privacy impact:** Low
- **reproduction:** Domain idempotency key construction review
- **mitigations:** Confirmation binds `targetUserId`; grant is zero-ledger
- **severity:** MEDIUM
- **confidence:** MEDIUM
- **remediation:** Include `targetUserId` in idempotency scope (defer; confirmation still binds target)
- **Mainnet blocker:** NO
- **Owner acceptance permitted:** YES
- **status:** OPEN
- **Step 2A note:** Remains OPEN; not Mainnet-blocking under current evidence.

- **title:** CC Owner grant/issue uses Telegram Owner authz model, not Admin web confirmationId
- **category:** CATEGORY_3_FOUNDER_ADMIN
- **affected:** `packages/control-center/src/founder-admin.ts`, `authorize.ts`
- **preconditions:** Allowlisted Owner + ACTIVE admin + permission + destination
- **attacker capability:** N/A if Telegram Owner authz accepted as distinct boundary
- **security impact:** Design difference across channels
- **financial impact:** None (zero-ledger)
- **privacy impact:** None
- **reproduction:** Source review — authorizeOwnerAction without web confirmationId
- **mitigations:** Allowlist + role + permission + one-time action tokens; reassignment unavailable
- **severity:** INFO
- **confidence:** HIGH
- **remediation:** Document channel equivalence policy; optional align ceremonies later
- **Mainnet blocker:** NO
- **Owner acceptance permitted:** YES
- **status:** OPEN
- **Step 2A note:** Remains OPEN INFO; distinct Telegram Owner authz model, not Mainnet-blocking.

- **title:** Generic policy FEATURE_FLAGS mutates flags without version history / silent-flip refuse / mutate audit
- **category:** CATEGORY_6_POLICY_CENTER (cross-cut CATEGORY_9_FEATURE_FLAGS)
- **affected:** `apps/api/src/admin/policy-center.controller.ts`, `feature-flags.controller.ts`
- **preconditions:** OWNER Admin; CSRF; reauth; confirmation for `policy.FEATURE_FLAGS`
- **attacker capability:** Clear/set high-impact flags (including `PAYOUT_DISPATCH_PAUSE`) via alternate path with weaker invariant stack
- **security impact:** High-impact flag misuse / ceremony bypass relative to dedicated route
- **financial impact:** Potential unauthorized payout-dispatch unpause (still needs Owner session)
- **privacy impact:** None
- **reproduction:** Compare policy FEATURE_FLAGS branch vs FeatureFlagsController mutate path (discovery test)
- **mitigations:** Still requires Admin OWNER + CSRF + reauth + confirmation (family-level binding)
- **severity:** HIGH
- **confidence:** HIGH
- **remediation:** Return `applied=false` for FEATURE_FLAGS (like REWARD_RULES) **or** fully delegate dedicated invariant stack
- **Mainnet blocker:** YES (was)
- **Owner acceptance permitted:** OWNER_POLICY_REQUIRED
- **status:** RESOLVED
- **resolution (Step 2A):** Policy Center FEATURE_FLAGS returns `applied=false` with note to use dedicated typed Admin endpoint; `setFeatureFlagEnabled` import removed from PolicyCenterController. Dedicated Feature Flags route remains sole web mutation authority.

### P19-SEC-010 — AdsGram webhook duplicate weak when provider_event_id is NULL

- **title:** UNIQUE (provider_id, provider_event_id) allows multiple NULL event ids
- **category:** CATEGORY_4_PROVIDER_TRUST
- **affected:** `migrations/0003_ads_and_rewards.sql`, `packages/ads` AdsGram reward ingest
- **preconditions:** Callbacks without provider event id
- **attacker capability:** Duplicate forensic event rows (not money; path credits false)
- **security impact:** Evidence integrity / noise
- **financial impact:** None while AdsGram monetary BLOCKED / `rewardCredited:false`
- **privacy impact:** Low
- **reproduction:** Insert two events with NULL provider_event_id for same provider
- **mitigations:** Uniform webhook response; monetary gate; no ledger from webhook
- **severity:** MEDIUM
- **confidence:** HIGH
- **remediation:** NULLS NOT DISTINCT unique constraint and/or synthetic event key before APPROVED money
- **Mainnet blocker:** NO
- **Owner acceptance permitted:** YES
- **status:** OPEN
- **Step 2A note:** Remains OPEN; not Mainnet-blocking while AdsGram monetary BLOCKED.

- **title:** Correlation does not enforce placement/blockId match
- **category:** CATEGORY_4_PROVIDER_TRUST
- **affected:** `packages/ads` AdsGram reward correlation
- **preconditions:** Unsigned provider callback evidence
- **attacker capability:** Mismatched placement forensic association
- **security impact:** Forensic integrity
- **financial impact:** None while unsigned + BLOCKED
- **privacy impact:** Low
- **reproduction:** Source review of `findCorrelationCandidates`
- **mitigations:** Monetary authenticity UNVERIFIED; gate refuse
- **severity:** LOW
- **confidence:** MEDIUM
- **remediation:** Bind placement when provider authenticity exists (defer until signed authenticity)
- **Mainnet blocker:** NO
- **Owner acceptance permitted:** YES
- **status:** OPEN
- **Step 2A note:** Remains OPEN; not Mainnet-blocking while unsigned + BLOCKED.

- **title:** Issue-path REQUEST hard check vs authorize never incrementing provider_requests
- **category:** CATEGORY_5_PROVIDER_LIMITS
- **affected:** `packages/ads` authorize + lifecycle issue path
- **preconditions:** AdsGram (or provider) without provider-side request proof
- **attacker capability:** REQUEST hard ceiling ineffective on issue path
- **security impact:** Defense-in-depth gap for REQUEST dimension
- **financial impact:** Limited while soft/session caps + SUCCESS hard still apply; BLOCKED today
- **privacy impact:** None
- **reproduction:** P11-01 semantics + lifecycle REQUEST hard check
- **mitigations:** Conservative session authorize caps; SUCCESS hard on rewards; clarifications OPEN
- **severity:** LOW
- **confidence:** HIGH
- **remediation:** Align counters / clarifications before APPROVED monetary
- **Mainnet blocker:** NO
- **Owner acceptance permitted:** YES
- **status:** OPEN
- **Step 2A note:** Remains OPEN; not Mainnet-blocking while AdsGram monetary BLOCKED.

- **title:** Hard/contract ceiling may be raised with source/reason ceremony
- **category:** CATEGORY_5_PROVIDER_LIMITS
- **affected:** `packages/ads` admin-limits; `apps/api/src/admin/providers-admin.controller.ts`
- **preconditions:** OWNER Admin high-impact ceremony
- **attacker capability:** Authorized Owner raises absolute ceiling (not soft>hard bypass)
- **security impact:** Absolute ceiling change (by design if Owner-approved)
- **financial impact:** Increases allowed provider traffic after raise
- **privacy impact:** None
- **reproduction:** `wouldExceedProviderHardLimit` returns false for HARD scopes
- **mitigations:** Ceremony + audit on dedicated limit route; Policy Center cannot apply PROVIDER_LIMITS
- **severity:** INFO
- **confidence:** HIGH
- **remediation:** None — raising/replacing PROVIDER_HARD / CONTRACT with full ceremony is approved Owner configuration, not a hard-limit bypass. Soft scopes still cannot exceed hard ceiling.
- **Mainnet blocker:** NO
- **Owner acceptance permitted:** YES
- **status:** FALSE_POSITIVE
- **verification (Step 2A):** Path still requires Owner Admin, CSRF, recent reauth, consumed confirmation, expectedVersion, oldMaxCount, sourceType, sourceReference, reason, versioned append-only mutation, audit log. Non-hard limits cannot exceed active hard ceiling.

### P19-SEC-014 — Mission claim / issuance after REVOKED or DRAFT mission version

- **title:** Claim and issuance paths must refuse DRAFT/REVOKED mission_versions
- **category:** CATEGORY_7_MISSION_CLAIM
- **affected:** `packages/tasks/src/prepare-claim.ts`, `packages/rewards/src/issue-mission.ts`
- **preconditions:** Progress COMPLETED under earlier ACTIVE version; version later REVOKED; or PENDING claim then version REVOKED before worker issuance
- **attacker capability:** Unauthorized mission reward authorization after revoke/draft intent
- **security impact:** Potential unauthorized mission reward
- **financial impact:** Potential unauthorized mission reward issuance
- **privacy impact:** None
- **subpaths:**
  1. completed progress can claim after version REVOKED (prepareMissionClaim)
  2. PENDING monetary claim created while ACTIVE can still issue after later REVOKED (issueMissionRewardOnClient)
- **reproduction:** Source asymmetry contribute vs prepare; missing status load at issuance
- **mitigations:** Unique claim constraint; issuance pause/budget; locks
- **severity:** HIGH
- **confidence:** HIGH
- **remediation:** Refuse NEW claims for DRAFT/REVOKED; load mission_versions.status at issuance and refuse DRAFT/REVOKED before ledger/reward
- **Mainnet blocker:** YES (was)
- **Owner acceptance permitted:** OWNER_POLICY_REQUIRED
- **status:** RESOLVED
- **resolution (Step 2A):** prepareMissionClaim refuses DRAFT/REVOKED for NEW claims (`MISSION_VERSION_DRAFT` / `MISSION_VERSION_REVOKED`). issueMissionRewardOnClient loads version status and refuses DRAFT/REVOKED before ledger/reward/budget/exposure. SUPERSEDED historical path preserved. Disposable-DB tests cover both stages.

### P19-SEC-015 — Dedicated feature-flag version check outside write transaction

- **title:** expectedVersion TOCTOU window on FeatureFlagsController
- **category:** CATEGORY_9_FEATURE_FLAGS
- **affected:** `apps/api/src/admin/feature-flags.controller.ts`
- **preconditions:** Two parallel Owner ceremonies with same version snapshot
- **attacker capability:** (incorrectly claimed) last-writer wins silently
- **security impact:** Concurrent Owner ops integrity
- **financial impact:** Possible unexpected pause state under dual ceremonies
- **privacy impact:** None
- **reproduction:** Version read precedes `withLedgerTransaction` write
- **mitigations:** `UNIQUE(feature_flag_id, flag_version)`; setFeatureFlagEnabled + version INSERT in same transaction — loser hits unique constraint and rolls back flag UPDATE with the transaction
- **severity:** INFO
- **confidence:** HIGH
- **remediation:** None required — independent review concurrency analysis confirmed by disposable-DB proof
- **Mainnet blocker:** NO
- **Owner acceptance permitted:** YES
- **status:** FALSE_POSITIVE
- **verification (Step 2A):** Concurrent same-version mutations: at most one commits; exactly one N+1 version row; loser leaves no committed flag UPDATE / version / audit row.

### P19-SEC-016 — Payout pause absent treated as not paused

- **title:** `isPayoutDispatchPaused` fail-open if flag row missing
- **category:** CATEGORY_9_FEATURE_FLAGS
- **affected:** `packages/withdrawals/src/flags.ts`
- **preconditions:** Missing `PAYOUT_DISPATCH_PAUSE` row for environment
- **attacker capability:** Dispatch proceeds when pause misconfigured/absent
- **security impact:** Fail-open kill-switch semantics
- **financial impact:** Unauthorized dispatch if pause row deleted/missing
- **privacy impact:** None
- **reproduction:** Prior `rows[0]?.enabled === true` only
- **mitigations:** Seeded flags in normal environments; STAGING currently paused=true (unchanged live)
- **severity:** HIGH
- **confidence:** HIGH
- **remediation:** Fail closed when pause flag missing in STAGING/PRODUCTION
- **Mainnet blocker:** YES (was)
- **Owner acceptance permitted:** OWNER_POLICY_REQUIRED
- **status:** RESOLVED
- **resolution (Step 2A):** Missing row in STAGING/PRODUCTION ⇒ paused/fail-closed. Explicit true/false unchanged. No auto-create; no live STAGING flag mutation. Unit tests cover missing + explicit cases.

### P19-SEC-017 — Review Queue RESOLVE_AFTER_DOMAIN trusts hardcoded domainSucceeded

- **title:** Admin API invents domainSucceeded=true without server domain evidence
- **category:** CATEGORY_10_REVIEW_QUEUE
- **affected:** `apps/api/src/admin/review-queue.controller.ts`, `packages/contracts/src/admin.ts`
- **preconditions:** OWNER Admin; CSRF; reauth; confirmation for queue action
- **attacker capability:** Close Review Queue cases as if domain succeeded without verifying domain command commit
- **security impact:** Queue integrity / false operational closure (not ledger SoT)
- **financial impact:** None directly (`ledgerWrite: false`); can misrepresent financial-ops state
- **privacy impact:** Low
- **reproduction:** HTTP action branch hardcodes `domainSucceeded: true` (discovery test)
- **mitigations:** Review Queue not financial SoT; ASSIGN/COMMENT/ESCALATE non-monetary; future money actions blocked
- **severity:** HIGH
- **confidence:** HIGH
- **remediation:** Remove Admin HTTP RESOLVE_AFTER_DOMAIN until server-verifiable domain evidence exists
- **Mainnet blocker:** YES (was)
- **Owner acceptance permitted:** OWNER_POLICY_REQUIRED
- **status:** RESOLVED
- **resolution (Step 2A):** Removed from Admin public action union and HTTP switch. Lower-level `resolveReviewCaseAfterDomainSuccess` retained for future/internal trusted callers only. Client cannot manufacture domainSucceeded.

---

## Dependency / static security (Step 2A)

### Audit snapshot (post Fastify 5.12.2)

Command: `pnpm security:audit` / `pnpm audit --json`

Metadata observed after Fastify pin/override to **5.12.2**:

- **19 vulnerabilities** aggregate (2 low | 6 moderate | 10 high | 1 critical)
- Fastify `<5.12.2` advisories: **cleared** (P19-SEC-018 RESOLVED)

### Triage of Critical/High clusters

| Cluster | Advisory | Reachability | Finding |
| --- | --- | --- | --- |
| next 16.3.4 | GHSA-vcvr-r3jv-pc5j Critical — RCE in next/og ImageResponse | Production: `apps/admin`, `apps/miniapp` | **P19-SEC-019** OPEN |
| @nestjs/platform-fastify 12.0.1 | GHSA-9c5c-9qcx-q35q High — path-scoped middleware bypass | Production: `apps/api` | **P19-SEC-020** OPEN |
| @grpc/grpc-js 1.14.4 | GHSA-m9gg-hp2v-232j High — getAuthContext unauthorized certs | Production: Temporal via api/worker | **P19-SEC-021** OPEN |
| fast-uri 4.1.3 (via Fastify) | GHSA-qw65-cvwx-89v3 / GHSA-58mr-gqgx-xq4g High | Production: api/bot/signer/worker Fastify stack | **P19-SEC-022** OPEN |
| fast-uri 3.1.6 (via webpack/Sentry) | same GHSAs | Build/dev (admin/miniapp webpack plugin) | build/dev only — no finding ID |
| brace-expansion (eslint 5.x) | GHSA-qhr7-859c-m2p7 / GHSA-6j4f-fj2g-mc7p High | Build/dev/test only | build/dev only — no finding ID |
| brace-expansion 2.x (otel rimraf/glob) | same | Production dep; nested-brace DoS path not used by LOOTRA request surfaces | production dependency; affected path not used — no finding ID |

Do not invent advisory IDs beyond audit output. No broad auto-upgrade performed beyond Fastify 5.12.2.

### P19-SEC-018 — Fastify 5.12.1 security release gap

- **title:** Direct Fastify 5.12.1 pins below patched 5.12.2
- **category:** DEPENDENCY_SUPPLY_CHAIN
- **affected:** `apps/api`, `apps/bot`, `apps/worker`, `apps/signer` (+ workspace override)
- **severity:** HIGH
- **Mainnet blocker:** YES (was)
- **status:** RESOLVED
- **resolution (Step 2A):** Direct pins + `pnpm-workspace.yaml` override to **5.12.2**. Post-update audit no longer reports Fastify `<5.12.2` advisories (request validation / header validation / malformed URL auth boundary cluster cleared).

### P19-SEC-019 — Next.js ImageResponse RCE (GHSA-vcvr-r3jv-pc5j)

- **title:** Next.js Critical RCE in `next/og` ImageResponse
- **category:** DEPENDENCY_SUPPLY_CHAIN
- **affected:** `apps/admin`, `apps/miniapp` (next 16.3.4; patched `>=16.3.6`)
- **preconditions:** Vulnerable Next.js runtime serving ImageResponse / OG path
- **attacker capability:** Remote code execution per advisory
- **security impact:** Critical supply-chain / runtime RCE
- **financial impact:** Indirect (full host compromise)
- **privacy impact:** High if exploited
- **reproduction:** `pnpm audit` Critical advisory GHSA-vcvr-r3jv-pc5j
- **severity:** CRITICAL
- **confidence:** HIGH
- **remediation:** Upgrade Next.js to patched `>=16.3.6` in a focused follow-up (not auto-bundled with Fastify-only Step 2A pin)
- **Mainnet blocker:** YES
- **Owner acceptance permitted:** OWNER_POLICY_REQUIRED
- **status:** OPEN

### P19-SEC-020 — NestJS platform-fastify middleware path bypass (GHSA-9c5c-9qcx-q35q)

- **title:** `@nestjs/platform-fastify` path-scoped middleware bypass via absolute-form request targets
- **category:** DEPENDENCY_SUPPLY_CHAIN
- **affected:** `apps/api` (`@nestjs/platform-fastify` 12.0.1; patched `>=12.0.2`)
- **preconditions:** Path-scoped Nest middleware on Fastify adapter
- **attacker capability:** Bypass path-scoped middleware (auth/CSRF depending on placement)
- **security impact:** High — potential guard/middleware skip
- **financial impact:** Indirect if Admin/session middleware scoped by path is bypassed
- **privacy impact:** Medium
- **reproduction:** audit GHSA-9c5c-9qcx-q35q
- **severity:** HIGH
- **confidence:** HIGH
- **remediation:** Upgrade `@nestjs/platform-fastify` to `>=12.0.2` in focused follow-up; verify middleware binding
- **Mainnet blocker:** YES
- **Owner acceptance permitted:** OWNER_POLICY_REQUIRED
- **status:** OPEN

### P19-SEC-021 — @grpc/grpc-js unauthorized certificate context (GHSA-m9gg-hp2v-232j)

- **title:** `@grpc/grpc-js` getAuthContext can treat unauthorized certificates as authorized
- **category:** DEPENDENCY_SUPPLY_CHAIN
- **affected:** Temporal client/worker paths (`apps/api`, `apps/worker`; version 1.14.4; patched `>=1.14.5`)
- **preconditions:** gRPC TLS configurations using auth context certificate authorization
- **attacker capability:** Mis-authorization of peer certificates in affected configs
- **security impact:** High on Temporal control plane trust
- **financial impact:** Indirect (worker/workflow integrity)
- **privacy impact:** Medium
- **reproduction:** audit GHSA-m9gg-hp2v-232j
- **severity:** HIGH
- **confidence:** MEDIUM (config-dependent exploitability)
- **remediation:** Upgrade `@grpc/grpc-js` via Temporal/dependency resolution to `>=1.14.5`; confirm TLS auth context usage
- **Mainnet blocker:** YES
- **Owner acceptance permitted:** OWNER_POLICY_REQUIRED
- **status:** OPEN

### P19-SEC-022 — fast-uri authority injection / host confusion (Fastify runtime)

- **title:** `fast-uri` High advisories on Fastify JSON schema/URI serialize path
- **category:** DEPENDENCY_SUPPLY_CHAIN
- **affected:** Fastify stack in api/bot/signer/worker (`fast-uri` 4.1.3)
- **advisories:** GHSA-qw65-cvwx-89v3, GHSA-58mr-gqgx-xq4g
- **preconditions:** Code paths serializing untrusted URI authority via fast-uri
- **attacker capability:** Authority injection / host confusion per advisory
- **security impact:** High on URI serialization trust
- **financial impact:** Indirect
- **privacy impact:** Low–Medium
- **reproduction:** audit; transitive via `@fastify/ajv-compiler` / `fast-json-stringify`
- **severity:** HIGH
- **confidence:** MEDIUM
- **remediation:** Override/upgrade `fast-uri` to patched `>=4.1.4` (and clear 4.1.3-only host confusion) in focused follow-up
- **Mainnet blocker:** YES
- **Owner acceptance permitted:** OWNER_POLICY_REQUIRED
- **status:** OPEN

---

## Non-findings (verified OK / preserved)

- Founder claim consume: hash-only, atomic single-use, session userId authority, Redis throttle fail-closed, no ledger money
- Founder web grant: CSRF + gate + requireConsumedConfirmation with target binding; reassignment unavailable
- Client ads completion cannot issue money; webhook always `rewardCredited:false`; dynamic provider load absent
- Soft>hard provider limit create refused; Policy Center cannot apply PROVIDER_LIMITS / REWARD_RULES / FEATURE_FLAGS
- Mission claim wrong-user refuse; unique claim identity; concurrent issuance controls present in Phase 16 tests
- Notifications largely unimplemented; existing home announcement read is session-scoped; Admin draft-only
- AccessSessionGuard vs AdminSessionGuard separation for Admin mutate routes reviewed on sampled controllers
- Live STAGING `PAYOUT_DISPATCH_PAUSE` not changed in Phase 19 Step 2A
- Phase 18 canonical source/archive untouched
