# Admin Policy Center (Phase 13)

Typed, versioned Owner control surface coordinating domain-specific rule families.
**Not** a scripting engine.

## Allowed families

Provider Limits, Provider Routing, Country Eligibility, Reward Rules, Membership Benefits,
Referral Rules, Withdrawal Fees/Limits, Pending Hold Rules, Risk/Trust Thresholds,
Mission Rules, Feature Flags, Economic Exposure Limits.

Each family keeps its own schema and validation. High-impact changes require Owner
session, recent reauth when configured, reason, expected version, old/new diff, optional
impact preview, second confirmation when configured, effective time, immutable version
history, and append-only audit.

## Forbidden

- Arbitrary JavaScript / SQL / `eval` / “custom code” fields
- Direct ledger posts, payout signing, signer/reconciliation/auth bypass
- Exceeding provider hard limits
- Treating client callbacks as financial truth

See ADR-023 and `apps/api/src/admin/policy-center.controller.ts`.
