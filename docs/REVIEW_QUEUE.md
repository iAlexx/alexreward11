# Review Queue (Phase 8)

Operational control surface over existing domain state. Domain systems remain the
source of money and membership truth; review actions must call authoritative commands.

## Case types

`WITHDRAWAL_REVIEW`, `FRAUD_REVIEW`, `PROVIDER_ANOMALY`, `INVALID_TRAFFIC`,
`REFERRAL_ABUSE`, `FOUNDER_CLAIM_ISSUE`, `MEMBERSHIP_REASSIGNMENT`,
`SUPPORT_ESCALATION`, `RECONCILIATION_ISSUE`.

At most one live case (`OPEN` / `IN_REVIEW` / `WAITING_INPUT` / `ESCALATED`) per
`(case_type, resource_type, resource_id)`.

## Operations

| Operation         | Behavior                                                         |
| ----------------- | ---------------------------------------------------------------- |
| ensure/open       | Idempotent create or return live case                            |
| assign            | Bind Owner admin; OPEN → IN_REVIEW                               |
| comment           | Append-only `review_case_events`                                 |
| escalate          | Transition to `ESCALATED`                                        |
| resolve / dismiss | Allowed **only** when `domainSucceeded=true` after domain commit |
| reopen            | Supported for terminal → OPEN where product needs it             |

## Unsupported mutations

Future-domain mutations (fraud force-ban, membership reassignment money path, provider
force settle, etc.) return `ACTION_UNAVAILABLE` / review-only. Phase 8 does not invent
domain shortcuts.

## Package API

Implemented in `@alex-rewards/control-center` (`review-queue.ts`). Telegram Owner
authorization is required before invoking these from Control Center callbacks.
