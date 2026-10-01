# Phase 20 — Controlled Content Proposal (missions / referrals) (Step 2)

**Status:** OWNER DECISION REQUIRED — do **not** activate on staging without approval.
**PHASE20_GATE:** HOLD
**Scope:** Minimal mission + referral content for Closed Beta UX honesty. Not monetary unlock.

---

## Purpose

Propose the smallest Owner-approved content needed so Tasks / Friends can be validated without
fabricating rewards or inventing rates.

---

## Missions (Tasks)

### Current honesty

- `listUserMissions` returns `[]` when no ACTIVE mission versions apply.
- No fabricated reward amounts in empty state (Step 2 DB proof).

### Owner decisions required before publish

| Decision                            | Notes                                                         |
| ----------------------------------- | ------------------------------------------------------------- |
| Mission definition code / name keys | Stable codes for beta cohort                                  |
| Condition type + target             | e.g. DAILY_LOGIN target=1 — Owner picks                       |
| Reset policy / window               | NONE / daily / monthly                                        |
| Reward rule binding                 | Must pin a real MISSION reward rule — **no invented amounts** |
| Eligibility policy on version       | Membership / country requirements if any                      |
| Status path                         | DRAFT → Owner activate ACTIVE → PAUSED/ARCHIVED rollback      |

### Proposal for minimal beta

Publish **at most one** ACTIVE mission version after Owner approves reward rule + copy.
Until then, keep engine empty and UI empty-state honest.

**Do not activate in Step 2 automation.**

---

## Referrals (Friends)

### Current honesty

- Attribution refuses `SELF_REFERRAL` and preserves first-win via `ALREADY_ATTRIBUTED`.
- Effective rate has **no** hardcoded 500/700 bps defaults; rates come from ACTIVE referral rules / membership replacement profiles.
- Test harness uses `TEST_REFERRAL_BASE_RATE_BPS = 123` (REFERENCE ONLY).

### Owner decisions required before publish

| Decision                                                      | Notes                             |
| ------------------------------------------------------------- | --------------------------------- |
| ACTIVE `referral_rule_versions.base_rate_bps`                 | Owner-approved bps — not test 123 |
| Activation thresholds                                         | account age / valid ad count      |
| Whether REFERRAL_RATE_BOOST membership profiles apply in beta | Replacement profile, not additive |
| Code issuance / disable policy                                | Ops procedure                     |

### Proposal for minimal beta

Seed one Owner-approved ACTIVE referral rule on staging only after rate approval.
Keep self-referral refusal and attribution idempotency as non-negotiable.

**Do not activate in Step 2 automation.**

---

## Rollback

- Missions: set definition PAUSED/ARCHIVED and/or SUPERSEDE/REVOKE mission versions (claims refuse).
- Referrals: DISABLE codes and/or SUPERSEDE referral rule versions; never invent fallback rates.
- Prefer empty honest UI over fake catalog rows.

---

## Evidence companions

- `packages/tasks/test/phase20-mission-list-empty.db.test.ts`
- `packages/referrals/test/phase20-referral-authority.unit.test.ts`
- `packages/referrals/test/phase20-referral-controlled.db.test.ts`
- `docs/PHASE_20_GAP_REGISTER.md` → P20-GAP-017
