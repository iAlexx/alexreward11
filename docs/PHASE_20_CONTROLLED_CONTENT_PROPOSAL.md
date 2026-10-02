# Phase 20 — Controlled Content Proposal (missions / referrals) (Step 2)

**Status:** `OWNER_SCOPED_FOR_PHASE20` — final Owner decision recorded (Step 5, 2026-10-02).
**PHASE20_GATE:** `HOLD_FOR_FINAL_ACCEPTANCE_REVIEW`
**Scope:** Minimal mission + referral content for Closed Beta UX honesty. Not monetary unlock.

### Final Owner decision (Phase 20 only)

```text
OWNER_SCOPED_FOR_PHASE20
FRIENDS:
  PRE_EXISTING_STAGING_NON_MONETARY_CONTENT_ACCEPTED
MISSIONS:
  DEFERRED_NO_LIVE_CONTENT
```

**Friends:** Accept pre-existing staging Referral rule v1 + code policy v1 for non-monetary validation. `base_rate_bps=500` is a **staging placeholder**, not production/real-money rate approval. `REFERRAL_REWARD_PAUSE/STAGING=true` keeps Referral issuance paused.

**Missions:** No ACTIVE mission publish in Phase 20. Honest empty Tasks state accepted. Mission producers (e.g. daily-login candidate selection) lack a Phase 20 approved-tester cohort filter — global publish would exceed Closed-Beta scope.

This task did **not** create the pre-existing Referral rows. See `docs/PHASE_20_STEP5_MISSION_REFERRAL_SCOPE_DECISION.md`.

---

## Missions (Tasks) — historical Step 2 proposal (preserved)

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
