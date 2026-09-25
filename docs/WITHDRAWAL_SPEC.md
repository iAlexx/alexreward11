# Withdrawal specification

Withdrawal state and financial behavior follow the Master Spec and `docs/WITHDRAWALS.md`.
Phase 7+ engines remain authoritative.

## Phase 13 Admin

Owner Admin withdrawals UI/API lists queue state and invokes existing withdrawal domain
commands (approve / hold / reject). Admin never direct-`UPDATE`s withdrawal state.
Versioned withdrawal settings changes use Policy/Config ceremony (reason, expected
version, reauth, audit). Displaying `PAYOUT_DISPATCH_PAUSE` does not silently change the
Phase 10 baseline.
