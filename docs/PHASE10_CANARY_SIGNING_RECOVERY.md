# Phase 10 canary SIGNING+0-attempts recovery tooling

Narrow Owner-gated recovery for **exactly one** withdrawal:

`01a0afbd-2550-742b-967d-5aec6ee75a83`

Based on PR #5 HEAD `c4b7c1eb22c55ce6272d8ec29d44bfc17c9380af`.

## Security model

| Control                                                        | Role                                                                                                                                                                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `confirmationPhrase`                                           | **Intent confirmation only** — not authentication                                                                                                                                                      |
| `ownerAdminUserId` + session token                             | **Authenticated Owner** — ACTIVE admin, unrevoked `OWNER` binding, matching unexpired `admin_sessions` row; recent reauth must be on **that exact session** (`admin_sessions.reauthenticated_at` only) |
| CLI session token input                                        | Interactive non-echoing TTY only — **forbidden** on argv / env / logs / errors                                                                                                                         |
| `temporalTerminatedConfirmed` / `payoutWorkerStoppedConfirmed` | Operational attestations                                                                                                                                                                               |
| CI / `GITHUB_ACTIONS`                                          | Fail-closed on nonempty markers. **Cannot mutate operational recovery**. Narrow exception: `NODE_ENV=test` + approved isolated test DB + fixture env matches a **non-production** ID                   |
| Fixture override                                               | Never honored against operational `alex_rewards`                                                                                                                                                       |
| Operational DB `alex_rewards`                                  | Requires `PHASE10_CANARY_RECOVERY_OPERATIONAL_MUTATION_CONFIRM=…`. **Always refused in CI.**                                                                                                           |
| Default mode                                                   | **dry-run** (plan/inspect only)                                                                                                                                                                        |

## Temporal

Original workflow `withdrawal/01a0afbd-…` must be **TERMINATED** (never claim COMPLETED).  
Re-entry is a **direct** `runRealTestnetPayoutPipeline` call — **no** new Temporal workflow.  
Completion is recorded in PostgreSQL + chain evidence.

## Currently authorized during Owner-auth workstreams

**Recovery CLI execution (including dry-run) is NOT authorized** during Owner authentication
stabilization/closure. Do not run it from these workstreams.

Owner-auth CLI may issue sessions only on approved **isolated** test databases.
All Owner-auth operational `alex_rewards` entry points are **default-deny** until a separate
Owner-held endpoint trust ceremony is approved and implemented
(`docs/OWNER_ADMIN_DB_IDENTITY_DESIGN.md`). Operational first enrollment remains refused.

Isolated auth CLI (test DB only):

```powershell
pnpm --filter @alex-rewards/auth run build
pnpm --filter @alex-rewards/auth run owner-admin-auth -- enroll `
  --expected-database <ISOLATED_TEST_DB_NAME> `
  --admin-user-id <ACTIVE_OWNER_ADMIN_UUID>
pnpm --filter @alex-rewards/auth run owner-admin-auth -- login `
  --expected-database <ISOLATED_TEST_DB_NAME> `
  --admin-user-id <ACTIVE_OWNER_ADMIN_UUID>
```

`--expected-database` is required. Session tokens are TTY-only; never argv/env.

## Future / historical Recovery CLI (NOT authorized now)

The following commands are documented for a **separate, Owner-authorized Recovery window**.
They are **not** part of Owner-auth closure and must not be executed from this phase.

```bash
# Dry-run (default) — NOT authorized in Owner-auth closure
pnpm --filter @alex-rewards/withdrawals run phase10:canary-recovery -- \
  --withdrawal-id 01a0afbd-2550-742b-967d-5aec6ee75a83 \
  --expected-fencing-token 1

# Mutate — NOT authorized in Owner-auth closure
pnpm --filter @alex-rewards/withdrawals run phase10:canary-recovery -- \
  --withdrawal-id 01a0afbd-2550-742b-967d-5aec6ee75a83 \
  --mode mutate \
  --confirmation-phrase PHASE10_OWNER_RECOVERY_SIGNING_ZERO_ATTEMPTS \
  --owner-admin-user-id <ACTIVE_OWNER_ADMIN_UUID> \
  --expected-fencing-token 1 \
  --temporal-terminated-confirmed \
  --payout-worker-stopped-confirmed
```

## Rollback boundaries

A before Temporal terminate → B after terminate / before migrate → C after 0023 →  
D after recovery txn → E after attempt/sign → F after possible broadcast (**RECONCILE ONLY, NO RESEND**).

This tooling never migrates ops, terminates Temporal, unlocks Signer, enables real-chain, or broadcasts.
