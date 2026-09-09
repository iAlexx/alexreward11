# ALEx Rewards Phase 5 Acceptance Report (Corrected — budget scope)

Status: **PASS (narrow correction)** — Base reward budget scope authority + canonical UTC
window integrity corrected after review of `82d73cf…`. Prior Phase 5 financial corrections remain
in force. GitHub Actions `quality` + `docker-smoke` are green on the new accepted commit.

Date: 2026-09-09

Source of truth: ALEx Rewards Master Product, Financial, Security & Engineering Specification **v1.2**.

| Item                                       | Value                                                           |
| ------------------------------------------ | --------------------------------------------------------------- |
| New accepted Phase 5 commit                | `a25026d5aa8ccd7844a416beb95ab32c99d20daf`                      |
| Prior corrected Phase 5 archive (retained) | `82d73cfcefd8368493f24219d89ba1b680dcc48a`                      |
| Historical first Phase 5 archive           | `a7da07d623c63819344dc72ebb2266d7ad0bcc06`                      |
| GitHub Actions run                         | https://github.com/iAlexx/alexreward11/actions/runs/34293423687 |
| `quality`                                  | PASS — job `102284736190`                                       |
| `docker-smoke`                             | PASS — job `102285504148`                                       |
| New migration                              | `0015_budget_period_utc_window_integrity.sql`                   |
| Migrations `0001`–`0014`                   | **unchanged**                                                   |

Phase 6 has **not** started.

## Narrow correction scope

1. `validateBaseBudgetPeriod` enforces exact Phase 5 base scopes only:
   `GLOBAL` | `PROVIDER` | `COUNTRY_GROUP` | `REWARD_RULE`.
2. `MEMBERSHIP_PLAN` / `MISSION` / `REFERRAL` cannot authorize Phase 5 base simulated quotes.
3. GLOBAL requires null `scope_reference_id` and null `country_group`.
4. PROVIDER requires resolved provider match; optional country_group requires exact quote country.
5. COUNTRY_GROUP requires exact quote country; rejects null quote country; rejects `scope_reference_id` authority abuse.
6. REWARD_RULE requires `scope_reference_id == rewardRuleId`; stored `rule_version` must match when present.
7. Canonical UTC HOUR / UTC_DAY / UTC_MONTH windows enforced in app + DB (`0015`).

## Tests

| Suite                     | Count  |
| ------------------------- | ------ |
| Prior Phase 5 suites      | 48     |
| Phase 5 base budget scope | 7      |
| **Phase 5 total**         | **55** |
| Phase 2                   | 27     |
| Phase 3                   | 21     |
| Phase 4                   | 41     |

**No Phase 6 work started.**

## O. Archive verification

| Item                                | Result                                                             |
| ----------------------------------- | ------------------------------------------------------------------ |
| Canonical source ZIP                | `ALEx_Rewards_PHASE_05_REWARD_ENGINE_20260909-031500_a25026d.zip`  |
| Canonical source SHA256             | `1419f39a12673033ee1ba9531eafdc9d7b1ecc852e922f7e8535b7df8d938403` |
| Final review-package ZIP            | `PHASE_05_REWARD_ENGINE_PACKAGE_20260909-043500_a25026d.zip`       |
| Source extraction                   | PASS                                                               |
| Source prohibited-path scan         | PASS                                                               |
| Review-package extraction           | PASS                                                               |
| Review-package prohibited-path scan | PASS                                                               |
| Nested canonical source validation  | PASS                                                               |
| Forward-slash ZIP entry validation  | PASS                                                               |

Final review-package SHA256 is recorded externally in `PACKAGE_SHA256.txt` beside the package.
