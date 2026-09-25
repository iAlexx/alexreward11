# Admin Economics (Phase 13)

Owner Economics views distinguish classification labels. Dashboards aggregate authoritative
data; they are **not** independent financial truth.

## Labels (must not be merged)

- **ESTIMATED** — provider/model estimates (never labeled profit or realized revenue)
- **REPORTED** — provider-reported figures
- **SETTLED** — settlement/confirmed commercial amounts
- **REALIZED / ACTUAL** — only where domain data supports that classification

Unknown or unconfigured values are labeled **UNAVAILABLE** / incomplete — never fabricated
zeros or silent production defaults for `OWNER_DECISION_REQUIRED` exposure limits.

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
