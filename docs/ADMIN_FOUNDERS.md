# Admin Memberships / Founders (Phase 13)

## Views

Plans, user memberships, Founders (number, status, source), grant/claim history, benefit
rules and entitlement versions.

## Owner Founder grant

Only through the authoritative membership command: Owner session, recent reauth, validated
target, plan validation, unique Founder number, reason/reference, idempotency, immutable
grant event, audit. Grant does **not** award money.

## Claims

Issue one-time codes (secret shown once); store hashes; revoke unused where policy allows;
never re-display raw secret from DB.

## Invariants

- Membership ≠ Trust; Founder ≠ Trust (no automatic trusted mark)
- Founder cannot bypass provider hard limits
- Benefit changes create new entitlement rule versions + audit
- Historical membership/grant history is never erased by status change
- Proposed launch benefit values remain gated (`OWNER_DECISION_REQUIRED` / not auto-activated)
