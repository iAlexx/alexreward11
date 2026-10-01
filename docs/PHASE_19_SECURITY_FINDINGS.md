# Phase 19 — Security Findings (Step 1 Discovery)

**PHASE19_STATUS:** IN_PROGRESS
**PHASE19_GATE:** HOLD
**Review HEAD (branch tip at discovery commit):** recorded in git
**Starting source HEAD:** `6c195dd826fcaa3eb720be2d6bcbb0c00e75c7af`
**Canonical Phase 18 source (unchanged):** `654a7097456d7d18ad6e6a7072793ee6d353ca33`

No Critical findings opened in Step 1. Open High findings are Mainnet blockers.
Cursor does **not** accept findings on behalf of the Owner.

---

## Summary

| Severity | Open count |
| --- | --- |
| CRITICAL | 0 |
| HIGH | 3 |
| MEDIUM | 6 |
| LOW | 5 |
| INFO | 2 |
| **TOTAL** | **16** |

**Mainnet-blocking open IDs:** P19-SEC-001, P19-SEC-009, P19-SEC-014, P19-SEC-016, P19-SEC-017

(P19-SEC-014 / P19-SEC-016 classified Mainnet blocker under conservative policy; Owner may reclassify with documented mitigation.)

---

## Category matrix (Step 1)

| Category | REVIEWED | TEST_COVERAGE | OPEN_CRITICAL | OPEN_HIGH | OPEN_MEDIUM | OPEN_LOW | STATUS |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CATEGORY_1_MEMBERSHIP_CLAIM | YES | EXISTING + ADDED | 0 | 1 | 1 | 2 | FINDINGS |
| CATEGORY_2_ENTITLEMENT_ESCALATION | YES | EXISTING + ADDED | 0 | 0 | 0 | 1 | FINDINGS |
| CATEGORY_3_FOUNDER_ADMIN | YES | EXISTING + ADDED | 0 | 0 | 1 | 0 | FINDINGS |
| CATEGORY_4_PROVIDER_TRUST | YES | EXISTING + ADDED | 0 | 0 | 1 | 1 | FINDINGS |
| CATEGORY_5_PROVIDER_LIMITS | YES | EXISTING + ADDED | 0 | 0 | 0 | 2 | FINDINGS |
| CATEGORY_6_POLICY_CENTER | YES | EXISTING + ADDED | 0 | 1 | 0 | 0 | FINDINGS |
| CATEGORY_7_MISSION_CLAIM | YES | EXISTING + ADDED | 0 | 0 | 1 | 0 | FINDINGS |
| CATEGORY_8_NOTIFICATION_LEAKAGE | YES | EXISTING | 0 | 0 | 0 | 0 | PASS |
| CATEGORY_9_FEATURE_FLAGS | YES | EXISTING + ADDED | 0 | 1 | 2 | 0 | FINDINGS |
| CATEGORY_10_REVIEW_QUEUE | YES | EXISTING + ADDED | 0 | 1 | 0 | 0 | FINDINGS |

Note: CATEGORY_6 HIGH finding (P19-SEC-009) and CATEGORY_9 HIGH finding describe the same Policy Center FEATURE_FLAGS alternate path; counted once under Policy Center for HIGH, and cross-referenced under Feature Flags.

Adjusted open HIGH unique IDs: P19-SEC-001, P19-SEC-009, P19-SEC-017 (3).

---

## Explicit verification answers

### MEMBERSHIP_CLAIM_CODE_ISSUE_SECOND_CONFIRMATION_PRESENT = **false**

`MembershipsAdminController.issueClaimCode` calls `gateHighImpactMutation` but does **not** call `requireConsumedConfirmation`. Body type has no `confirmationId`. Contrast: `grantFounder` in the same file requires both.

Evidence: `apps/api/src/admin/memberships-admin.controller.ts` (`issueClaimCode` ~151–188 vs `grantFounder` ~112–124).

### POLICY_CENTER_FEATURE_FLAG_EQUIVALENT_SECURITY = **false**

`POST /v1/admin/policy/change` family `FEATURE_FLAGS` mutates via `setFeatureFlagEnabled` without dedicated-route DB version match, `feature_flag_versions` insert, `audit_logs` mutate audit, or PAYOUT silent-flip refuse.

Evidence: `policy-center.controller.ts` ~98–124 vs `feature-flags.controller.ts` ~109–195.

### REVIEW_QUEUE_RESOLVE_DOMAIN_EVIDENCE_SERVER_VERIFIED = **false**

HTTP `RESOLVE_AFTER_DOMAIN` hardcodes `domainSucceeded: true` with no server-verifiable domain command evidence for the case resource.

Evidence: `apps/api/src/admin/review-queue.controller.ts` ~160–172.

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
- **Mainnet blocker:** YES
- **Owner acceptance permitted:** OWNER_POLICY_REQUIRED
- **status:** OPEN

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
- **status:** OPEN

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
- **status:** OPEN

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
- **remediation:** Uniform public rejection code for claim failures where product allows
- **Mainnet blocker:** NO
- **Owner acceptance permitted:** YES
- **status:** OPEN

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
- **remediation:** Align view filters with engine eligibility predicates
- **Mainnet blocker:** NO
- **Owner acceptance permitted:** YES
- **status:** OPEN

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
- **remediation:** Include `targetUserId` in idempotency scope
- **Mainnet blocker:** NO
- **Owner acceptance permitted:** YES
- **status:** OPEN

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
- **Mainnet blocker:** YES
- **Owner acceptance permitted:** OWNER_POLICY_REQUIRED
- **status:** OPEN

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
- **remediation:** Bind placement when provider authenticity exists
- **Mainnet blocker:** NO
- **Owner acceptance permitted:** YES
- **status:** OPEN

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

### P19-SEC-013 — PROVIDER_HARD ceiling raiseable via Admin limit ceremony

- **title:** Hard/contract ceiling may be raised with source/reason ceremony
- **category:** CATEGORY_5_PROVIDER_LIMITS
- **affected:** `packages/ads` admin-limits
- **preconditions:** OWNER Admin high-impact ceremony
- **attacker capability:** Authorized Owner raises absolute ceiling (not soft>hard bypass)
- **security impact:** Absolute ceiling change (by design if Owner-approved)
- **financial impact:** Increases allowed provider traffic after raise
- **privacy impact:** None
- **reproduction:** `wouldExceedProviderHardLimit` returns false for HARD scopes
- **mitigations:** Ceremony + audit on dedicated limit route; Policy Center cannot apply PROVIDER_LIMITS
- **severity:** LOW
- **confidence:** MEDIUM
- **remediation:** Distinct Owner policy for hard-ceiling changes if desired
- **Mainnet blocker:** NO
- **Owner acceptance permitted:** YES
- **status:** OPEN

### P19-SEC-014 — Mission claim may accept REVOKED mission version after prior completion

- **title:** Claim path does not refuse REVOKED/DRAFT mission_versions while contribute does
- **category:** CATEGORY_7_MISSION_CLAIM
- **affected:** `packages/tasks/src/prepare-claim.ts` vs `contribute.ts`
- **preconditions:** Progress COMPLETED under earlier ACTIVE version; version later REVOKED; definition ACTIVE; window open
- **attacker capability:** Claim after version revoke (if race/ops revoke lag)
- **security impact:** Mission reward eligibility after revoke intent
- **financial impact:** Potential unauthorized mission reward issuance
- **privacy impact:** None
- **reproduction:** Source asymmetry contribute vs prepareMissionClaim version status checks; add DB adversarial case in remediation
- **mitigations:** Unique claim constraint; issuance pause/budget; locks
- **severity:** MEDIUM
- **confidence:** HIGH
- **remediation:** Refuse claim when mission_versions.status is REVOKED/DRAFT (match contribute)
- **Mainnet blocker:** YES
- **Owner acceptance permitted:** OWNER_POLICY_REQUIRED
- **status:** OPEN

### P19-SEC-015 — Dedicated feature-flag version check outside write transaction

- **title:** expectedVersion TOCTOU window on FeatureFlagsController
- **category:** CATEGORY_9_FEATURE_FLAGS
- **affected:** `apps/api/src/admin/feature-flags.controller.ts`
- **preconditions:** Two parallel Owner ceremonies with same version snapshot
- **attacker capability:** Last-writer wins without serializing version bump inside one critical section
- **security impact:** Concurrent Owner ops integrity
- **financial impact:** Possible unexpected pause state under dual ceremonies
- **privacy impact:** None
- **reproduction:** Version read precedes `withLedgerTransaction` write
- **mitigations:** Confirmation one-time use; Admin OWNER only
- **severity:** MEDIUM
- **confidence:** MEDIUM
- **remediation:** Version check + update inside one locked transaction
- **Mainnet blocker:** NO
- **Owner acceptance permitted:** YES
- **status:** OPEN

### P19-SEC-016 — Payout pause absent treated as not paused

- **title:** `isPayoutDispatchPaused` fail-open if flag row missing
- **category:** CATEGORY_9_FEATURE_FLAGS
- **affected:** `packages/withdrawals/src/flags.ts`
- **preconditions:** Missing `PAYOUT_DISPATCH_PAUSE` row for environment
- **attacker capability:** Dispatch proceeds when pause misconfigured/absent
- **security impact:** Fail-open kill-switch semantics
- **financial impact:** Unauthorized dispatch if pause row deleted/missing
- **privacy impact:** None
- **reproduction:** `rows[0]?.enabled === true` only
- **mitigations:** Seeded flags in normal environments; STAGING currently paused=true
- **severity:** MEDIUM
- **confidence:** HIGH
- **remediation:** Fail closed when pause flag missing in STAGING/PRODUCTION
- **Mainnet blocker:** YES
- **Owner acceptance permitted:** OWNER_POLICY_REQUIRED
- **status:** OPEN

### P19-SEC-017 — Review Queue RESOLVE_AFTER_DOMAIN trusts hardcoded domainSucceeded

- **title:** Admin API invents domainSucceeded=true without server domain evidence
- **category:** CATEGORY_10_REVIEW_QUEUE
- **affected:** `apps/api/src/admin/review-queue.controller.ts`, `packages/control-center/src/review-queue.ts`
- **preconditions:** OWNER Admin; CSRF; reauth; confirmation for queue action
- **attacker capability:** Close Review Queue cases as if domain succeeded without verifying domain command commit
- **security impact:** Queue integrity / false operational closure (not ledger SoT)
- **financial impact:** None directly (`ledgerWrite: false`); can misrepresent financial-ops state
- **privacy impact:** Low
- **reproduction:** HTTP action branch hardcodes `domainSucceeded: true` (discovery test)
- **mitigations:** Review Queue not financial SoT; ASSIGN/COMMENT/ESCALATE non-monetary; future money actions blocked
- **severity:** HIGH
- **confidence:** HIGH
- **remediation:** Require server-verifiable domain evidence (or remove Admin HTTP RESOLVE_AFTER_DOMAIN until evidence exists)
- **Mainnet blocker:** YES
- **Owner acceptance permitted:** OWNER_POLICY_REQUIRED
- **status:** OPEN

---

## Non-findings (verified OK for Step 1)

- Founder claim consume: hash-only, atomic single-use, session userId authority, Redis throttle fail-closed, no ledger money
- Founder web grant: CSRF + gate + requireConsumedConfirmation with target binding; reassignment unavailable
- Client ads completion cannot issue money; webhook always `rewardCredited:false`; dynamic provider load absent
- Soft>hard provider limit create refused; Policy Center cannot apply PROVIDER_LIMITS / REWARD_RULES
- Mission claim wrong-user refuse; unique claim identity; concurrent issuance controls present in Phase 16 tests
- Notifications largely unimplemented; existing home announcement read is session-scoped; Admin draft-only
- AccessSessionGuard vs AdminSessionGuard separation for Admin mutate routes reviewed on sampled controllers

---

## Dependency / static security (Step 1)

Recorded at discovery execution time in the Step 1 commit message / RETURN block.
Do not invent scanner results.

## Dependency security audit (executed Step 1)

Command: `pnpm security:audit` (`pnpm audit --audit-level=high`)

Result: **FAILED / findings present** (exit 1). Scanner summary observed:

- Reported aggregate: **23 vulnerabilities** (2 low | 6 moderate | 14 high | 1 critical) as printed by pnpm audit.
- Notable high package cluster: `fastify` (<5.12.2) — header validation / related advisories (including GHSA-hwr6-493r-vm6h, GHSA-9q9j-q6p8-xq58 among printed rows).
- Reachability: transitive/direct via `apps/api`, `apps/bot` (and related Nest/Fastify paths). Full exploitability vs LOOTRA Admin/financial surfaces **not fully triaged in Step 1**.
- Auto-upgrade: **NOT performed** (discovery-only).

Treat dependency Critical/High as open supply-chain risk requiring Owner triage in later Phase 19 steps. Do not invent CVEs beyond scanner output.
