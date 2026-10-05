# Admin Provider Operations (Phase 13)

Owner Admin surfaces over the Phase 11 provider framework.

## Surfaces

- Registry: code, environment, status, capabilities, monetary status, health, formats
- Contracts: structured metadata (no raw secret credentials)
- Capabilities: versioned; UNKNOWN stays unknown — never upgraded to trusted
- Limits: versioned changes with OLD/NEW, dimension, window, scope, source/reference,
  valid_from/to, rule version, reason, impact preview; optimistic concurrency
- Certification: read/rerun only through existing harness paths — checkbox cannot mark
  uncertified providers APPROVED
- Country/provider rules: typed/versioned; fail closed when eligibility policy missing
- Settlement: commercial accounting distinct from user ledger

## Hard limit rule

No Admin control may produce an effective allowance above applicable `PROVIDER_HARD`
contract limit. Founder/tier experiments cannot bypass it.

## AdsGram

`productionMonetaryStatus = BLOCKED` until the clarification gate passes. Admin UI does
not authorize APPROVED. See `docs/ADSGRAM_CLARIFICATION_REGISTER.md`.
