# Control Center (Phase 8)

Private Telegram Owner Control Center for ALEx Rewards. Package:
`@alex-rewards/control-center`.

## Authority model

Group membership alone grants **nothing**. Every Owner action must pass:

1. `CONTROL_CENTER_OWNER_TELEGRAM_USER_IDS` allowlist
2. ACTIVE `admin_users.telegram_user_id` match
3. ACTIVE `OWNER` role binding (`revoked_at IS NULL`)
4. Named permission via `admin_role_permissions`
5. Destination environment + enabled chat/topic binding
6. One-time `admin_action_tokens` (hash-at-rest, opaque callback_data)

## Topics (11)

| Topic     | Destination purpose           |
| --------- | ----------------------------- |
| Approvals | `CONTROL_CENTER_APPROVALS`    |
| Payouts   | `CONTROL_CENTER_PAYOUTS`      |
| Warnings  | `CONTROL_CENTER_WARNINGS`     |
| Critical  | `CONTROL_CENTER_CRITICAL`     |
| Fraud     | `CONTROL_CENTER_FRAUD`        |
| Wallet    | `CONTROL_CENTER_WALLET`       |
| Ads       | `CONTROL_CENTER_ADS`          |
| Reports   | `CONTROL_CENTER_DAILY_REPORT` |
| Support   | `CONTROL_CENTER_SUPPORT`      |
| Audit     | `CONTROL_CENTER_AUDIT`        |
| System    | `CONTROL_CENTER_SYSTEM`       |

Production chat/topic IDs are operational configuration only — never seeded in the repo.

## Withdrawal decisions

Approvals buttons issue opaque action tokens. Consume path calls
`decideWithdrawal(..., decisionSource: 'TELEGRAM')` with idempotency key
`aat:{token.id}`. Duplicate clicks return ALREADY_PROCESSED without a second domain
mutation / Outbox insert.

## Founder admin

Owner grant / claim-code issue / search / history wrap `@alex-rewards/auth`. Grants are
zero-ledger. Founder reassignment mutation is **ACTION_UNAVAILABLE** in V1.

## Boundaries

- No `@alex-rewards/ledger` imports
- No `@alex-rewards/ton` sign / KMS paths
- No `@aws-sdk/client-kms`
- Raw action/claim secrets never enter audit logs or group publications

## Config (bot)

See `packages/config` `botSchema`: `DATABASE_URL`, Owner allowlist, action/confirm TTLs,
rate-limit window/max. Local/test merges fixture defaults; staging/production fail closed.

## Tests

```bash
pnpm test:phase8
# or
PHASE8_DATABASE_URL=postgresql://... pnpm --filter @alex-rewards/control-center run test:phase8
```

Migration: `0019_control_center_security_integrity.sql`.
