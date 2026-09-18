# Phase 10 canary SIGNING+0-attempts recovery tooling

Narrow Owner-gated recovery for **exactly one** withdrawal:

`01a0afbd-2550-742b-967d-5aec6ee75a83`

Based on PR #5 HEAD `c4b7c1eb22c55ce6272d8ec29d44bfc17c9380af`.

## Security model

| Control                                                        | Role                                                                                                                              |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `confirmationPhrase`                                           | **Intent confirmation only** — not authentication                                                                                 |
| `operatorAdminUserId`                                          | **Authenticated operator** — must be an `ACTIVE` `admin_users` row; written to `audit_logs.admin_user_id`                         |
| `temporalTerminatedConfirmed` / `payoutWorkerStoppedConfirmed` | Operational attestations                                                                                                          |
| CI / `GITHUB_ACTIONS`                                          | **Cannot mutate**                                                                                                                 |
| Operational DB `alex_rewards`                                  | Requires additional env `PHASE10_CANARY_RECOVERY_OPERATIONAL_MUTATION_CONFIRM=I_CONFIRM_OPERATIONAL_ALEX_REWARDS_CANARY_RECOVERY` |
| Default mode                                                   | **dry-run** (plan/inspect only)                                                                                                   |

## Temporal

Original workflow `withdrawal/01a0afbd-…` must be **TERMINATED** (never claim COMPLETED).  
Re-entry is a **direct** `runRealTestnetPayoutPipeline` call — **no** new Temporal workflow.  
Completion is recorded in PostgreSQL + chain evidence.

## CLI

```bash
# Dry-run (default)
pnpm --filter @alex-rewards/withdrawals run phase10:canary-recovery -- \
  --withdrawal-id 01a0afbd-2550-742b-967d-5aec6ee75a83 \
  --expected-fencing-token 1

# Mutate (Owner-gated; still no broadcast)
pnpm --filter @alex-rewards/withdrawals run phase10:canary-recovery -- \
  --withdrawal-id 01a0afbd-2550-742b-967d-5aec6ee75a83 \
  --mode mutate \
  --confirmation-phrase PHASE10_OWNER_RECOVERY_SIGNING_ZERO_ATTEMPTS \
  --operator-admin-user-id <ACTIVE_ADMIN_UUID> \
  --expected-fencing-token 1 \
  --temporal-terminated-confirmed \
  --payout-worker-stopped-confirmed
```

## Rollback boundaries

A before Temporal terminate → B after terminate / before migrate → C after 0023 →  
D after recovery txn → E after attempt/sign → F after possible broadcast (**RECONCILE ONLY, NO RESEND**).

This tooling never migrates ops, terminates Temporal, unlocks Signer, enables real-chain, or broadcasts.
