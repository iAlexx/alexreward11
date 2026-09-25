# Admin Feature Flags / Kill Switches (Phase 13)

Environment-aware, versioned, audited flags. Examples:

`GLOBAL_REWARDS_PAUSE`, `PROVIDER_<CODE>_ENABLED`, `PROVIDER_<CODE>_MONETARY_ENABLED`,
`MEMBERSHIP_BONUS_PAUSE`, `REFERRAL_REWARD_PAUSE`, `MISSION_REWARD_PAUSE`,
`WITHDRAWAL_REQUESTS_PAUSE`, `PAYOUT_DISPATCH_PAUSE`, `AUTO_PAYOUT_PAUSE`,
`WALLET_VERIFICATION_PAUSE`.

## Safety

Flags may disable/restrict behavior. They must **not** bypass ledger invariants, payout
reconciliation, signer validation, auth, provider hard limits, or mandatory legal blocks.

## PAYOUT_DISPATCH_PAUSE

Phase 10 baseline remains authoritative. Displaying the flag in Admin does not authorize a
silent flip. Changes require full high-impact ceremony when Owner elects to change them.
