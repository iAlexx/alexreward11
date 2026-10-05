# Phase 18 Owner Policy Register

Status: active during Phase 18 Step 3 closure.
Authority: Owner only. Agents MUST NOT invent values for items marked `OWNER_POLICY_REQUIRED`.

Semantic markers: PHASE18_OWNER_POLICY_REGISTER, OWNER_POLICY_REQUIRED.

## Fail-closed rule

Unresolved numeric thresholds MUST NOT silently produce OK / healthy status in ops-health or restore-drill.
Runtime semantics remain `THRESHOLD_NOT_CONFIGURED` / `OWNER_POLICY_REQUIRED` / `SIGNAL_NOT_CONFIGURED` / `UNKNOWN` as implemented.

## Unresolved Owner policy items

| Item | Status | Runtime effect when unset |
| --- | --- | --- |
| RTO target (seconds) | OWNER_POLICY_REQUIRED | Reports `OWNER_POLICY_REQUIRED`; observation only |
| RPO target (seconds) | OWNER_POLICY_REQUIRED | Reports `OWNER_POLICY_REQUIRED`; observation only |
| Outbox lag warning threshold | OWNER_POLICY_REQUIRED | Outbox lag stays policy-gated without a configured threshold |
| Provider near-limit warning threshold | OWNER_POLICY_REQUIRED | Near-exhaustion not invented; exact exhaustion may still be DANGER |
| Provider settlement variance materiality threshold | OWNER_POLICY_REQUIRED | Settlement alerts remain signal-gated / explicit dispute only |
| Reward budget near-exhaustion threshold | OWNER_POLICY_REQUIRED | `REWARD_BUDGET_EXPOSURE` policy-gated without threshold |
| Founder bonus budget near-exhaustion threshold | OWNER_POLICY_REQUIRED | `FOUNDER_BONUS_BUDGET_EXPOSURE` policy-gated without threshold |
| Review Queue backlog count/age threshold | OWNER_POLICY_REQUIRED | `REVIEW_QUEUE_BACKLOG` policy-gated without threshold |
| Alert / pager destination | OWNER_POLICY_REQUIRED | External delivery optional until Owner selects channel |
| Optional hosted dashboard vendor (Grafana/Datadog/etc.) | OWNER_POLICY_REQUIRED | Admin System Health remains the in-app dashboard contract |
| Incident response numeric SLA / on-call assignment | OWNER_POLICY_REQUIRED | Playbooks document procedures without invented SLAs |

## Explicitly decided (do not reopen in Step 3)

| Item | Value |
| --- | --- |
| Auto-unpause payouts | false |
| Auto-resend withdrawals | false |
| Payout resume after restore | OWNER_APPROVAL_REQUIRED |
| Mainnet | unchanged / not enabled by Phase 18 |
| Production monetary | disabled |
| STAGING PAYOUT_DISPATCH_PAUSE during Phase 18 closure | true (must remain) |
