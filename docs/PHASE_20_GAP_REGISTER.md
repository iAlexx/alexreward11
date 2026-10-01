# Phase 20 — Gap Register (Step 1–2)

**PHASE20_GATE:** HOLD
**Step:** 2 (source/config readiness; Owner decisions still required)
**Register scope:** Closed Beta readiness gaps + carried Phase 19 residuals
**Rule:** Do not hide issues because they originated in an older phase.
**Status values:** OPEN | DEFERRED | REMEDIATED | ACCEPTED_RESIDUAL (Owner only for Critical/High)

Canonical IDs: `P20-GAP-001` .. contiguous.

---

## Summary

| Metric                                                   | Count |
| -------------------------------------------------------- | ----- |
| Total gaps                                               | 18    |
| Blocks Closed Beta (observation / non-money)             | 2     |
| Blocks real-money beta                                   | 8     |
| Blocks Phase 20 archive (until resolved or Owner-scoped) | 2 |
| Carried Phase 19 residuals mapped                        | 8     |

---

## Gaps

### P20-GAP-001 — AdsGram production monetary remains BLOCKED

- **title:** AdsGram cannot issue rewards under current monetary gate
- **category:** PROVIDER_MONETARY
- **affected component:** `packages/ads` monetary eligibility; `ad_providers.production_monetary_status`
- **evidence:** seed BLOCKED; capabilities cashRewardPolicyApproved=false; six OPEN clarifications; webhook rewardCredited=false
- **impact:** Earn credits unavailable; observation-only Closed Beta for ads money
- **prerequisite:** Clarifications closed + authenticity/correlation upgrades + Admin APPROVED ceremony
- **proposed remediation/test:** Keep BLOCKED for Steps 1–7; Owner-gated unlock path in Step 8 only
- **blocks Closed Beta?** NO — observation allowed while money remains BLOCKED
- **blocks real-money beta?** YES
- **blocks Phase 20 archive?** NO — if archive scopes money as out-of-scope / still BLOCKED with evidence
- **status:** OPEN

### P20-GAP-002 — AdsGram unsigned / authenticity NONE

- **title:** Server signal authentication strength NONE
- **category:** PROVIDER_AUTHENTICITY
- **affected component:** `packages/ads/src/providers/adsgram/adapter.ts`, `manifest.ts`
- **evidence:** verifyServerSignal → UNVERIFIED / NONE; uniqueProviderEventId UNKNOWN
- **impact:** Monetary gate correctly refuses; production money unsafe
- **prerequisite:** Provider-signed Reward URL or equivalent Owner-accepted model
- **proposed remediation/test:** EXTERNAL provider clarification + adapter upgrade + cert harness
- **blocks Closed Beta?** NO
- **blocks real-money beta?** YES
- **blocks Phase 20 archive?** NO — if money remains BLOCKED
- **status:** OPEN / EXTERNAL_CLARIFICATION_REQUIRED

### P20-GAP-003 — Six OPEN AdsGram clarification items

- **title:** Clarification register prevents monetary APPROVED
- **category:** PROVIDER_COMPLIANCE
- **affected component:** `provider_clarification_items`; `docs/ADSGRAM_CLARIFICATION_REGISTER.md`
- **evidence:** Admin `assertProviderMonetaryApprovalAllowed` refuses APPROVED while OPEN
- **impact:** Cannot lawfully enable AdsGram production money in-app
- **prerequisite:** Owner/provider written closures
- **proposed remediation/test:** Track clarifications; refuse APPROVED (existing tests)
- **blocks Closed Beta?** NO
- **blocks real-money beta?** YES
- **blocks Phase 20 archive?** NO — if still BLOCKED documented
- **status:** OPEN / EXTERNAL_CLARIFICATION_REQUIRED

### P20-GAP-004 — P19-SEC-010 AdsGram duplicate when provider_event_id NULL

- **title:** Webhook duplicate weakness (carried)
- **category:** PROVIDER_EVIDENCE / PHASE19_RESIDUAL
- **affected component:** AdsGram reward webhook / uniqueness
- **evidence:** `docs/PHASE_19_SECURITY_FINDINGS.md` P19-SEC-010 OPEN MEDIUM
- **impact:** Evidence noise now; duplicate credit risk if money enabled without fix
- **prerequisite:** Schema/idempotency remediation before APPROVED money
- **proposed remediation/test:** Unique partial index / synthetic event key; duplicate ingest tests
- **blocks Closed Beta?** NO
- **blocks real-money beta?** YES
- **blocks Phase 20 archive?** NO — while money remains BLOCKED (would become YES only if claiming monetary beta complete without fix)
- **status:** OPEN

### P20-GAP-005 — P19-SEC-011 placement/blockId not bound to session

- **title:** Correlation ignores placement/blockId (carried)
- **category:** PROVIDER_EVIDENCE / PHASE19_RESIDUAL
- **affected component:** webhook correlation
- **evidence:** P19-SEC-011 OPEN LOW
- **impact:** Forensic mismatch if money on
- **prerequisite:** Signed authenticity + correlation binding
- **proposed remediation/test:** Bind placement/blockId when provider supplies stable fields
- **blocks Closed Beta?** NO
- **blocks real-money beta?** YES
- **blocks Phase 20 archive?** NO — while money remains BLOCKED
- **status:** OPEN

### P20-GAP-006 — P19-SEC-012 REQUEST hard ceiling uses inert provider_requests

- **title:** Issue-path REQUEST hard ceiling counter weakness (carried)
- **category:** PROVIDER_LIMITS / PHASE19_RESIDUAL
- **affected component:** ads limits issue path vs authorize session count
- **evidence:** P19-SEC-012 OPEN LOW
- **impact:** Defense-in-depth gap before money
- **prerequisite:** Align counters or document authorize-only enforcement with Owner
- **proposed remediation/test:** Increment or join authorize counts; limit tests
- **blocks Closed Beta?** NO
- **blocks real-money beta?** YES
- **blocks Phase 20 archive?** NO — while money remains BLOCKED
- **status:** OPEN

### P20-GAP-007 — Notifications engine stub / draft-only / Mini App unavailable

- **title:** Notification delivery not implemented; Phase 20 accepts draft/no-send scope
- **category:** NOTIFICATIONS
- **affected component:** `packages/notifications`; Admin notifications; Mini App notifications page
- **evidence:** Step 2 draft/no-send proofs; Owner Step 3 decision `NOTIFICATIONS_SCOPE=DRAFT_ONLY_NO_SEND`
- **impact:** Real send/dispatch remains unimplemented (intentional for Phase 20)
- **prerequisite:** None for Phase 20 Closed Beta exit under Owner draft-only scope
- **proposed remediation/test:** Retain draft/no-send proofs; future phases may implement delivery MVP
- **blocks Closed Beta?** NO — Owner scoped Phase 20 to draft/no-send validation
- **blocks real-money beta?** NO
- **blocks Phase 20 archive?** NO — Master Spec notification-behavior for Phase 20 satisfied by scoped draft/no-send evidence
- **status:** DEFERRED
- **note:** OWNER_SCOPED_FOR_PHASE20 — DRAFT_ONLY_NO_SEND
- **step2 note:** Draft-only / no-send unit+DB proofs exist.
- **step3 note:** Owner accepted draft/no-send for Phase 20. Delivery is NOT implemented and NOT production-ready.

### P20-GAP-008 — Activity surface PLACEHOLDER

- **title:** Activity page is UnavailableShell placeholder
- **category:** UI
- **affected component:** `apps/miniapp` activity page
- **evidence:** discovery inventory
- **impact:** Incomplete UX surface
- **prerequisite:** Owner scope (required for Closed Beta UX or defer)
- **proposed remediation/test:** Implement or document out-of-scope for Phase 20
- **blocks Closed Beta?** NO — non-core vs Earn/Wallet; deferrable with documented scope
- **blocks real-money beta?** NO
- **blocks Phase 20 archive?** NO — if documented deferred
- **status:** OPEN

### P20-GAP-009 — Fraud/eligibility production policy seeds Owner-required

- **title:** Production ACTIVE fraud/eligibility policies not assumed present
- **category:** FRAUD_TRUST_ELIGIBILITY
- **affected component:** `packages/fraud` rules/policies
- **evidence:** engines fail-closed without ACTIVE rules; Phase 14 noted seeds Owner-required
- **impact:** Controlled beta may refuse actions until policies seeded
- **prerequisite:** Owner-approved policy rows for staging beta
- **proposed remediation/test:** Step 2 disposable fixtures + fail-closed proofs + `docs/PHASE_20_FRAUD_ELIGIBILITY_POLICY_PROPOSAL.md`; staging ACTIVE still Owner-gated
- **blocks Closed Beta?** YES — blocks complete Phase 20 fraud/trust/eligibility validation until controlled ACTIVE policies exist
- **blocks real-money beta?** YES — unsafe to pay without eligibility/fraud ACTIVE
- **blocks Phase 20 archive?** YES — until fraud/eligibility category evidenced
- **status:** OPEN / READY_FOR_OWNER_POLICY_APPROVAL
- **step2 note:** Disposable fail-closed + ACTIVE fixture proofs exist; TEST fixture numbers are REFERENCE ONLY — NOT APPROVED FOR STAGING. See `docs/PHASE_20_FRAUD_ELIGIBILITY_POLICY_PROPOSAL.md`.

### P20-GAP-010 — Provider-limit Admin UI ceremony incomplete

- **title:** Limit-change ceremony enforced on API; Admin UI surface PARTIAL
- **category:** PROVIDER_LIMITS_OPS
- **affected component:** Admin Ads/providers UI vs `providers-admin` API
- **evidence:** API ceremony present; no dedicated HighImpactCeremony limits page found
- **impact:** Operator may struggle to safely change limits in UI
- **prerequisite:** UI wiring or documented API-only ops procedure
- **proposed remediation/test:** Add UI or runbook API procedure + staging dry-run
- **blocks Closed Beta?** NO — API path exists
- **blocks real-money beta?** NO
- **blocks Phase 20 archive?** NO — if staging limit change validated via API/runbook
- **status:** OPEN

### P20-GAP-011 — Withdrawal operational freeze still active

- **title:** Minimal-funds payout blocked by pause/signer/REAL-off posture
- **category:** WITHDRAWALS
- **affected component:** withdrawals flags, signer, chain enables
- **evidence:** PAYOUT_DISPATCH_PAUSE true; signer LOCKED; REAL/FAKE off documented
- **impact:** No live payout in Step 1 (correct)
- **prerequisite:** Multi-step Owner authorization list in readiness matrix R16
- **proposed remediation/test:** Do not unlock in Step 1; later Owner-gated Step 8 only if in scope
- **blocks Closed Beta?** NO — non-payout Closed Beta validation may proceed
- **blocks real-money beta?** YES
- **blocks Phase 20 archive?** NO — if minimal-funds payout deferred/excluded by Owner from Phase 20 exit
- **status:** OPEN

### P20-GAP-012 — P19-SEC-007 Founder grant idempotency not scoped to targetUserId

- **title:** Founder grant idempotency key scoping (carried)
- **category:** FOUNDER / PHASE19_RESIDUAL
- **affected component:** Founder Admin grant
- **evidence:** P19-SEC-007 OPEN MEDIUM
- **impact:** Cross-target idempotency confusion risk under concurrent grants
- **prerequisite:** Key includes targetUserId or equivalent
- **proposed remediation/test:** Controlled concurrent grant tests; remediate if beta uses grants heavily
- **blocks Closed Beta?** NO
- **blocks real-money beta?** NO
- **blocks Phase 20 archive?** NO
- **status:** OPEN

### P20-GAP-013 — P19-SEC-004 blocked-user Founder claim status oracle

- **title:** Blocked-user status oracle on Founder claim (carried)
- **category:** FOUNDER / PHASE19_RESIDUAL
- **affected component:** Founder claim path
- **evidence:** P19-SEC-004 OPEN LOW
- **impact:** Information leak to blocked users
- **prerequisite:** Uniform error responses
- **proposed remediation/test:** Claim as blocked user → uniform refuse
- **blocks Closed Beta?** NO
- **blocks real-money beta?** NO
- **blocks Phase 20 archive?** NO
- **status:** OPEN

### P20-GAP-014 — P19-SEC-005 membership expires_at filter may omit

- **title:** Membership view expires_at filter (carried)
- **category:** MEMBERSHIP / PHASE19_RESIDUAL
- **affected component:** membership views
- **evidence:** P19-SEC-005 OPEN LOW
- **impact:** Possible stale membership visibility
- **prerequisite:** Filter audit
- **proposed remediation/test:** Expired membership read tests
- **blocks Closed Beta?** NO
- **blocks real-money beta?** NO
- **blocks Phase 20 archive?** NO
- **status:** OPEN

### P20-GAP-015 — P19-SEC-006 entitlements exposure INFO by design

- **title:** Public/internal entitlements on membership API
- **category:** MEMBERSHIP / PHASE19_RESIDUAL
- **affected component:** membership API
- **evidence:** P19-SEC-006 OPEN INFO
- **impact:** Design exposure; document for beta
- **prerequisite:** None if accepted as INFO
- **proposed remediation/test:** Document in beta ops notes
- **blocks Closed Beta?** NO
- **blocks real-money beta?** NO
- **blocks Phase 20 archive?** NO
- **status:** OPEN

### P20-GAP-016 — P19-SEC-008 Telegram CC Founder actions lack web confirmation

- **title:** CC Founder ceremony differs from web (carried)
- **category:** FOUNDER / PHASE19_RESIDUAL
- **affected component:** control-center Telegram Founder actions
- **evidence:** P19-SEC-008 OPEN INFO
- **impact:** Different authz model; not Mainnet-blocking
- **prerequisite:** Owner policy on CC vs web equivalence
- **proposed remediation/test:** Prefer web Admin for Closed Beta Founder grants when possible
- **blocks Closed Beta?** NO
- **blocks real-money beta?** NO
- **blocks Phase 20 archive?** NO
- **status:** OPEN

### P20-GAP-017 — Tasks/Friends depend on ACTIVE engine content

- **title:** Tasks/Friends UI PARTIAL without ACTIVE missions/referral engine content
- **category:** UI / MISSIONS / REFERRALS
- **affected component:** Mini App Tasks/Friends
- **evidence:** ENGINE_NOT_ENABLED empty states; refuse invented data
- **impact:** Closed Beta UX incomplete until content/config present
- **prerequisite:** Owner-published ACTIVE mission versions / referral config
- **proposed remediation/test:** Step 2 empty-list / authority proofs + `docs/PHASE_20_CONTROLLED_CONTENT_PROPOSAL.md`; no operational publish
- **blocks Closed Beta?** YES — until ACTIVE mission/referral content exists for Spec category validation (or Owner documents deferral)
- **blocks real-money beta?** NO
- **blocks Phase 20 archive?** YES — until missions category evidenced OR Owner defers with documented scope
- **status:** OPEN / READY_FOR_OWNER_CONTENT_APPROVAL
- **step2 note:** Empty mission list honesty + referral self-referral/ALREADY_ATTRIBUTED proofs exist; do not activate live content without Owner. See `docs/PHASE_20_CONTROLLED_CONTENT_PROPOSAL.md`.

### P20-GAP-018 — No second rewarded-ad provider

- **title:** Only AdsGram adapter exists; others UNSUPPORTED
- **category:** PROVIDERS
- **affected component:** `packages/ads/src/providers`
- **evidence:** single RewardedAdProvider adapter
- **impact:** Cannot diversify providers in Phase 20; Spec forbids enabling unsupported providers for production money
- **prerequisite:** Phase 24 multi-provider onboarding for additional networks
- **proposed remediation/test:** Keep UNSUPPORTED; do not enable
- **blocks Closed Beta?** NO
- **blocks real-money beta?** NO — AdsGram path only, still BLOCKED; no second provider to enable
- **blocks Phase 20 archive?** NO
- **status:** OPEN

---

## Notifications scope decision (Owner — Step 3)

**Owner decision recorded:** `NOTIFICATIONS_SCOPE = DRAFT_ONLY_NO_SEND`

For Phase 20 Closed Beta:
- Admin may create notification campaign draft metadata
- no send / dispatch / Telegram / push / external provider delivery
- no ledger or reward effect
- SECURITY category remains refused
- Admin authorization/privacy boundaries remain mandatory

This is Phase 20 scope acceptance only. Delivery is **not** implemented, **not** production-ready, and **not** permanently out of scope for future phases.

`P20-GAP-007` status: **DEFERRED** (`OWNER_SCOPED_FOR_PHASE20 — DRAFT_ONLY_NO_SEND`).
Blockers: Closed Beta **NO**, real-money **NO**, archive **NO**.

## Blocking tallies (derived)

Counts below MUST match mechanical derivation from each gap section (`YES` / `NO` first token).
Do not add inferred items that lack a canonical `P20-GAP-xxx` entry.

**P20_BLOCKING_CLOSED_BETA_GAPS** (count = 2):

- P20-GAP-009
- P20-GAP-017

**P20_BLOCKING_REAL_MONEY_GAPS** (count = 8):

- P20-GAP-001
- P20-GAP-002
- P20-GAP-003
- P20-GAP-004
- P20-GAP-005
- P20-GAP-006
- P20-GAP-009
- P20-GAP-011

**P20_BLOCKING_ARCHIVE_GAPS** (count = 2):

- P20-GAP-009
- P20-GAP-017

---

## Non-goals for Step 1–3 remediations

Do not implement notification delivery, activate staging policies/content, or enable AdsGram monetary in Steps 1–3.
Integrity check: `pnpm phase20:gap-register:check`.