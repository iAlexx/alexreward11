# Phase 19 — Security Findings (ARCHIVED)

**PHASE19_STATUS:** CLOSED / PASS / ARCHIVED
**PHASE19_GATE:** PASS
**PHASE19_ARCHIVE:** PASS
**Canonical accepted source HEAD:** `b5110524f90f29dc2a9235aac91ee9de731a03c0`
**Step 2C remediation HEAD:** `b5110524f90f29dc2a9235aac91ee9de731a03c0`
**Step 2B remediation HEAD:** `6f3d20d37ad5e250374bd0837fd28ca8f9d5b4bf`
**Step 2A remediation HEAD:** `1da5a6c5c9fb14beeb145daa5823517d778c48b8`
**Step 1 discovery HEAD:** `616fe53dbc30494bac0f9d9ee538a2e84b6d8307`
**Starting source HEAD:** `6c195dd826fcaa3eb720be2d6bcbb0c00e75c7af`
**Canonical Phase 18 source (unchanged):** `654a7097456d7d18ad6e6a7072793ee6d353ca33`

**Wording:** `PHASE 19 SECURITY REVIEW = PASS / ARCHIVED`

Final archive gate preserved residual OPEN Medium/Low/Info findings (004–008, 010–012) as
accepted residual / non-Mainnet-blocking carry-forward backlog. This is **not** Owner risk
acceptance of a Critical/High issue. Phase 20 has **not** started. Historical Step 1 / 2A / 2B /
2C evidence below is retained.

---

## Summary (recalculated after Step 2C)

| Severity | Open count | Notes |
| --- | --- | --- |
| CRITICAL | 0 | |
| HIGH | 0 | |
| MEDIUM | 2 | P19-SEC-007, P19-SEC-010 |
| LOW | 4 | P19-SEC-004, P19-SEC-005, P19-SEC-011, P19-SEC-012 |
| INFO | 2 | P19-SEC-006, P19-SEC-008 |
| **TOTAL OPEN** | **8** | |
| FALSE_POSITIVE | 2 | P19-SEC-013, P19-SEC-015 |
| RESOLVED | 13 | P19-SEC-001..003, 009, 014, 016..023 |

**Mainnet-blocking open IDs:** none


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
| DEPENDENCY_SUPPLY_CHAIN | YES | AUDIT | 0 | 0 | 0 | 0 | REMEDIATED (incl. P19-SEC-023) |

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

### P19-SEC-005 — Membership view may omit expires_at filter

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

### P19-SEC-006 — Public/internal entitlements exposed on membership API (by design)

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

### P19-SEC-008 — Telegram Control Center Founder actions lack web confirmation ceremony

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

### P19-SEC-009 — Policy Center FEATURE_FLAGS weaker than dedicated Feature Flags route

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

### P19-SEC-011 — Webhook placement/blockId not bound to session unit

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

### P19-SEC-012 — Monetary REQUEST hard ceiling uses inert provider_requests counter

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

### P19-SEC-013 — PROVIDER_HARD ceiling raiseable via Admin limit ceremony

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

## Dependency / static security (Step 2B → Step 2C)

### Step 2B audit residual (historical — corrected in Step 2C)

After Next 16.3.6 / Nest platform-fastify 12.0.3 / grpc-js 1.14.5 / fast-uri patches, audit still
reported High `brace-expansion` advisories. Step 2B documentation incorrectly characterized those
remaining Highs too broadly as purely build/dev or unused.

Accurate dependency presence at Step 2B HEAD (`6f3d20d`):

| Version | Chains |
| --- | --- |
| `brace-expansion@2.1.4` | build/dev (and otel/rimraf/glob transitive paths) |
| `brace-expansion@5.0.9` | **build/dev** (eslint) **and** API production dependency closure: `apps/api` → `@fastify/static@10.1.3` → `glob@13.0.6` → `minimatch@10.2.6` → `brace-expansion@5.0.9` |

Advisories (vendor High): GHSA-6j4f-fj2g-mc7p; GHSA-qhr7-859c-m2p7 / CVE-2026-102278; GHSA-q2hr-2g5m-vwhr / CVE-2026-102277 (as reported by independent review / upstream).

Distinguish:

- **A. Dependency presence:** `5.0.9` was in the API direct dependency closure via `@fastify/static` (not build/dev-only).
- **B. Demonstrated runtime exploit reachability:** API source review did **not** observe `@fastify/static` registration/import/use, and did **not** observe attacker-controlled glob/brace input. Remote exploitability is **NOT CLAIMED**.

Nevertheless a reviewed High advisory remained unresolved with no Owner acceptance → Phase 19 blocker until patched (P19-SEC-023).

### Step 2C audit snapshot (post brace-expansion patch)

Command: `pnpm security:audit` / `pnpm audit --json`

Target: Critical=0, High=0 after overrides `brace-expansion@^2` → 2.1.7 and `brace-expansion@^5` → 5.0.12.
Record exact counts in Step 2C RETURN.

### Reachability accuracy (pre-patch dependency clusters)

| Finding | Dependency presence | Exact exploit precondition in source |
| --- | --- | --- |
| P19-SEC-019 | next 16.3.4 Admin/Mini App | ImageResponse / next/og **NOT OBSERVED** |
| P19-SEC-020 | @nestjs/platform-fastify 12.0.1 | MiddlewareConsumer/forRoutes/exclude **NOT OBSERVED** |
| P19-SEC-021 | @grpc/grpc-js 1.14.4 via Temporal | getAuthContext / TLS auth-context **NOT OBSERVED** (address-only Temporal) |
| P19-SEC-022 | fast-uri 4.1.3 via Fastify | direct fast-uri object-form calls **NOT OBSERVED** |
| P19-SEC-023 | brace-expansion 2.1.4 / 5.0.9 (incl. API `@fastify/static` closure) | `@fastify/static` runtime registration **NOT OBSERVED**; attacker-controlled glob **NOT OBSERVED** |

Patched regardless; RESOLVED by removal of vulnerable versions.


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
- **affected:** `apps/admin`, `apps/miniapp` (was next 16.3.4; patched `>=16.3.6`)
- **preconditions:** Vulnerable Next.js runtime serving ImageResponse / OG path
- **reachability (Step 2B):** Affected dependency present; repo-wide source scan shows **no** `next/og` / `ImageResponse` usage — exact RCE precondition **NOT OBSERVED**. Still patched because Admin/Mini App are production Next runtimes.
- **attacker capability:** Remote code execution per advisory (if ImageResponse used)
- **security impact:** Critical supply-chain / runtime RCE when precondition present
- **financial impact:** Indirect (full host compromise)
- **privacy impact:** High if exploited
- **reproduction:** prior `pnpm audit` Critical advisory GHSA-vcvr-r3jv-pc5j
- **severity:** CRITICAL
- **confidence:** HIGH
- **remediation:** Upgrade Next.js to patched `>=16.3.6`
- **Mainnet blocker:** YES (was)
- **Owner acceptance permitted:** OWNER_POLICY_REQUIRED
- **status:** RESOLVED
- **resolution (Step 2B):** Direct pins `apps/admin` + `apps/miniapp` → **16.3.6**; lockfile updated; audit no longer reports GHSA-vcvr-r3jv-pc5j.

### P19-SEC-020 — NestJS platform-fastify middleware path bypass (GHSA-9c5c-9qcx-q35q)

- **title:** `@nestjs/platform-fastify` path-scoped middleware bypass via absolute-form request targets
- **category:** DEPENDENCY_SUPPLY_CHAIN
- **affected:** `apps/api` (was `@nestjs/platform-fastify` 12.0.1; patched `>=12.0.2`, applied **12.0.3**)
- **preconditions:** Path-scoped Nest `MiddlewareConsumer` / `.forRoutes` / `.exclude`
- **reachability (Step 2B):** Affected dependency present; source review found **no** `MiddlewareConsumer` / `.forRoutes` / `.exclude`. Auth uses guards/decorators — **not** the advisory's path-scoped middleware primitive. Exact bypass precondition **NOT OBSERVED**. Still patched.
- **attacker capability:** Bypass path-scoped middleware (when used)
- **security impact:** High when path-scoped middleware authorizes
- **financial impact:** Indirect
- **privacy impact:** Medium
- **reproduction:** prior audit GHSA-9c5c-9qcx-q35q
- **severity:** HIGH
- **confidence:** HIGH
- **remediation:** Upgrade `@nestjs/platform-fastify` to patched 12.x
- **Mainnet blocker:** YES (was)
- **Owner acceptance permitted:** OWNER_POLICY_REQUIRED
- **status:** RESOLVED
- **resolution (Step 2B):** Pin **12.0.3**; route guards remain authoritative; no middleware-based auth model introduced.

### P19-SEC-021 — @grpc/grpc-js unauthorized certificate context (GHSA-m9gg-hp2v-232j)

- **title:** `@grpc/grpc-js` getAuthContext can treat unauthorized certificates as authorized
- **category:** DEPENDENCY_SUPPLY_CHAIN
- **affected:** Temporal client/worker paths (was 1.14.4; patched `>=1.14.5`)
- **preconditions:** gRPC TLS configurations using auth context certificate authorization
- **reachability (Step 2B):** Dependency present via Temporal. Current source connects with **address-only** (`Connection.connect({ address })`); **no** direct `getAuthContext` usage; **no** Temporal TLS/`ChannelCredentials` configuration observed. Certificate-auth exploitability **not claimed**. Still patched transitive version.
- **attacker capability:** Mis-authorization of peer certificates in affected TLS configs
- **security impact:** High on Temporal control plane trust when TLS auth-context used
- **financial impact:** Indirect
- **privacy impact:** Medium
- **reproduction:** prior audit GHSA-m9gg-hp2v-232j
- **severity:** HIGH
- **confidence:** MEDIUM (config-dependent)
- **remediation:** Override `@grpc/grpc-js` to `>=1.14.5`
- **Mainnet blocker:** YES (was)
- **Owner acceptance permitted:** OWNER_POLICY_REQUIRED
- **status:** RESOLVED
- **resolution (Step 2B):** Workspace override `@grpc/grpc-js: 1.14.5`; no 1.14.4 runtime resolution remains; audit advisory cleared.

### P19-SEC-022 — fast-uri authority injection / host confusion (Fastify runtime)

- **title:** `fast-uri` High advisories on Fastify JSON schema/URI serialize path
- **category:** DEPENDENCY_SUPPLY_CHAIN
- **affected:** Fastify stack in api/bot/signer/worker (was `fast-uri` 4.1.3)
- **advisories:** GHSA-qw65-cvwx-89v3, GHSA-58mr-gqgx-xq4g
- **preconditions:** Code paths serializing untrusted URI authority via fast-uri object-form APIs
- **reachability (Step 2B):** Dependency present through Fastify serializer/schema stack. Repo has **no** direct `fast-uri` object-form serialize/normalize/equal calls. Dependency presence ≠ demonstrated exploit path. Still patched.
- **attacker capability:** Authority injection / host confusion per advisory
- **security impact:** High on URI serialization trust when exploitable path exercised
- **financial impact:** Indirect
- **privacy impact:** Low–Medium
- **reproduction:** prior audit; transitive via `@fastify/ajv-compiler` / `fast-json-stringify`
- **severity:** HIGH
- **confidence:** MEDIUM
- **remediation:** Override `fast-uri@^4` → 4.1.4 and `fast-uri@^3` → 3.1.7
- **Mainnet blocker:** YES (was)
- **Owner acceptance permitted:** OWNER_POLICY_REQUIRED
- **status:** RESOLVED
- **resolution (Step 2B):** Runtime resolves `fast-uri@4.1.4`; build/dev paths resolve `fast-uri@3.1.7`. Vulnerable production 4.1.3 / 3.1.6 cleared from audit Critical/High for this cluster.

### P19-SEC-023 — brace-expansion residual DoS advisories remain after Step 2B

- **title:** brace-expansion residual DoS advisories remain after Step 2B
- **category:** DEPENDENCY_SUPPLY_CHAIN
- **affected (Step 2B HEAD `6f3d20d`):** `brace-expansion@2.1.4`, `brace-expansion@5.0.9`
- **advisories:** GHSA-6j4f-fj2g-mc7p; GHSA-qhr7-859c-m2p7 / CVE-2026-102278; GHSA-q2hr-2g5m-vwhr / CVE-2026-102277 (vendor High)
- **dependency presence:**
  - build/dev chains (eslint / related tooling) resolving 5.0.9 and 2.x
  - API production dependency closure: `apps/api` → `@fastify/static@10.1.3` → `glob` → `minimatch` → `brace-expansion@5.0.9`
- **reachability (source review):**
  - direct `@fastify/static` runtime registration / import / use: **NOT OBSERVED**
  - attacker-controlled glob / brace-pattern input: **NOT OBSERVED**
  - demonstrated remote exploitability: **NOT CLAIMED**
- **why Phase 19 blocker before remediation:** known High advisory remained in the dependency graph after Step 2B; no Owner acceptance existed; Step 2B docs understated the API `@fastify/static` closure by treating remaining Highs too broadly as build/dev-only
- **attacker capability:** DoS via uncontrolled recursion on nested brace groups (per advisory) if vulnerable code path is exercised
- **security impact:** High vendor severity; practical exploit not demonstrated in current API source
- **financial impact:** None demonstrated
- **privacy impact:** None demonstrated
- **severity:** HIGH
- **confidence:** HIGH (dependency presence); MEDIUM (exploitability without static registration)
- **remediation:** Workspace overrides `brace-expansion@^2.0.0` → `2.1.7`, `brace-expansion@^5.0.0` → `5.0.12`; prefer transitive patch over removing `@fastify/static` unless unused-and-safe removal is separately proven
- **Mainnet blocker:** YES (was)
- **Owner acceptance permitted:** OWNER_POLICY_REQUIRED
- **status:** RESOLVED
- **resolution (Step 2C):** Lockfile resolves only `2.1.7` / `5.0.12`; no `2.1.4` / `5.0.9` remain; post-patch audit Critical=0 High=0 for this cluster.

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
