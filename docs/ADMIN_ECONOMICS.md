# Admin Economics (Phase 13 + P13-04 remediation)

Owner Economics views distinguish classification labels. Dashboards aggregate authoritative
data; they are **not** independent financial truth.

## Labels (must not be merged)

- **ESTIMATED** — provider/model estimates (never labeled profit or realized revenue)
- **ACCRUED** — recognized but not settled commercial amounts
- **SETTLED** — settlement/confirmed commercial amounts from an authoritative source
- **ACTUAL** — only where domain data supports that classification
- **OPERATIONAL** — operational figures that are not revenue/margin (e.g. confirmed
  withdrawal payout principal)

Unknown or unconfigured values are labeled **UNAVAILABLE** / incomplete — never fabricated
zeros or silent production defaults for `OWNER_DECISION_REQUIRED` exposure limits.

## Typed metrics (Spec §156M)

The Admin economics API returns a typed `metrics[]` list. Required metric codes include:

- `PROVIDER_ESTIMATED_REVENUE`
- `PROVIDER_SETTLED_CONFIRMED_REVENUE`
- `PROVIDER_RECEIVABLES`
- `BASE_USER_REWARD_EXPENSE`
- `MEMBERSHIP_FOUNDER_BONUS_EXPENSE`
- `REFERRAL_BONUS_EXPENSE`
- `MISSION_TASK_REWARD_EXPENSE`
- `WITHDRAWAL_FEE_REVENUE`
- `TON_NETWORK_FEE_EXPENSE`
- `INVALID_TRAFFIC_ADJUSTMENTS_LOSS`
- `NET_CONTRIBUTION_MARGIN_ESTIMATE`
- `HOT_WALLET_COVERAGE`
- `OUTSTANDING_USER_LIABILITIES`

When an authoritative rollup is not yet configured, the metric is returned with
`status: UNAVAILABLE` and a `reasonCode` — never as invented numeric profit.

## Confirmed withdrawal principal is not margin

`SUM(withdrawals.net_amount_atomic WHERE state = 'CONFIRMED')` is **payout principal**,
not settled contribution margin or provider revenue. It may appear only as
`CONFIRMED_WITHDRAWAL_PRINCIPAL_OPERATIONAL` with basis `OPERATIONAL`. Controllers and UI
must never call this figure “settled margin.”

`NET_CONTRIBUTION_MARGIN_ESTIMATE` remains `UNAVAILABLE` until the required revenue and
expense inputs exist.

## Exposure controls

Architecture for versioned exposure breakers (global/provider/country/membership/referral/
mission/margin/receivable). Unconfigured limits stay inactive/safe. When an enabled limit
is reached, stop **new** affected monetary authorization; do not rewrite valid in-flight
quotes unless existing quote rules allow it. Redis is not financial exposure truth.

## Settlement

Provider settlement/reconciliation foundations track estimated vs reported vs settled
periods. Discrepancies create reconciliation issues; they must **not** rewrite historical
user ledger entries.

See `apps/api/src/admin/economics.controller.ts`, `exposure.controller.ts`.
