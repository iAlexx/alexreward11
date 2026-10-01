# Phase 20 — Fraud / Trust / Eligibility Policy Proposal (Step 2)

**Status:** OWNER DECISION REQUIRED — do **not** activate on staging/production without approval.
**PHASE20_GATE:** HOLD
**Scope:** Controlled Closed Beta observation policies only. Not production monetary unlock.

---

## Purpose

Document the **fields and structures** Owner must approve before any ACTIVE fraud / trust /
eligibility policy is seeded outside disposable `*_test` databases.

Step 2 disposable DB proofs reuse Phase 14 harness fixtures. Those fixture numbers are
**REFERENCE ONLY — NOT APPROVED FOR STAGING**.

---

## Authority rules (unchanged)

- Engines fail closed when no ACTIVE rule/policy applies at evaluation time.
- Client-supplied outcome / gateFacts / clientScore are forbidden on evaluate-and-persist inputs.
- Founder / membership status is **not** a security bypass for risk or eligibility.
- No invented Owner thresholds. Do not copy TEST fixture numbers into staging without Owner sign-off.

---

## Fields requiring Owner approval

### Risk rule version (`risk_rule_versions`)

| Field                                        | Owner decision                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------ |
| `rule_version`                               | Integer identity for ACTIVE row                                                |
| `thresholds`                                 | `lowMax` / `mediumMax` / `highMax` bands                                       |
| `signal_weights`                             | Per-signal integer weights                                                     |
| `signal_params`                              | Per-signal collector params (windows, min counts)                              |
| `actions`                                    | Per-tier configured action labels (never auto-ban / never auto-approve payout) |
| `status` / `effective_from` / `effective_to` | Activation window                                                              |
| `reason` / source reference                  | Audit text                                                                     |

### Trust rule version (`trust_rule_versions`)

| Field                                | Owner decision                     |
| ------------------------------------ | ---------------------------------- |
| `rule_version`                       | Integer identity                   |
| `policy_config.signals`              | Signal weights + mins              |
| `policy_config.stateThresholds`      | basic / established / trusted mins |
| `status` / effective window / reason | Activation + audit                 |

### Eligibility policy version (`eligibility_policy_versions`)

| Field                                | Owner decision                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `policy_version`                     | Integer identity                                                                                  |
| `policy_config.actions.<ACTION>`     | `requiredGates`, `precedence`, optional `riskAllowedActions`                                      |
| Action coverage                      | Which of WITHDRAWAL_REQUEST / AD_SESSION_START / MISSION_CLAIM / TASK_CLAIM (etc.) are configured |
| `status` / effective window / reason | Activation + audit                                                                                |

---

## REFERENCE ONLY — disposable TEST fixtures (NOT APPROVED FOR STAGING)

Harness constants in `packages/fraud/test/harness.ts`:

- `TEST_RULE_THRESHOLDS` / `TEST_RULE_WEIGHTS` / `TEST_RULE_ACTIONS`
- `TEST_TRUST_POLICY_CONFIG`
- `TEST_ELIGIBILITY_POLICY_CONFIG`

These exist solely so disposable DB gates can prove fail-closed + evaluateAndPersist paths.
**Copying them into staging/production without Owner approval is forbidden.**

---

## Proposed Closed Beta posture (Owner must choose)

1. Keep fail-closed (no ACTIVE staging policies) until Owner publishes approved rows, **or**
2. Seed Owner-approved ACTIVE policies on staging only for the Closed Beta cohort, with documented reason + version + rollback.

Do **not** treat Step 2 test PASS as policy approval.

---

## Rollback

- SUPERSEDE / REVOKED the ACTIVE policy versions (append-only discipline).
- Prefer fail-closed over silent permissive defaults.
- Never invent temporary “open” policies to unblock UI demos.

---

## Evidence companions

- `packages/fraud/test/phase20-eligibility-controlled.db.test.ts`
- Phase 14 authoritative eligibility suites (reused under Step 2 readiness when DB gates required)
- `docs/PHASE_20_GAP_REGISTER.md` → P20-GAP-009
