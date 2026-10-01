# Disaster recovery

Phase 1 local data is disposable development data. Production backup, restore, dispatch-pause,
and mandatory reconciliation procedures remain governed by the Master Spec and must be
implemented and drilled before production/mainnet. No Phase 1 mechanism may be presented as
production recovery.

## Current verified Railway PostgreSQL state (Phase 18 Step 2A)

Read-only Railway inspection (staging Postgres service) established:

- PostgreSQL volume exists; operational Postgres is healthy/online.
- **PITR is NOT currently enabled.**
- No isolated restore service/environment currently exists.
- No restore drill has yet been executed against a restored target.

### Railway-supported PITR direction (do not DIY WAL)

Railway provides **managed PostgreSQL PITR** using its supported Postgres PITR workflow /
pgBackRest integration.

**Do NOT** manually edit:

- `postgresql.conf`
- `archive_mode` / `archive_command` / `restore_command`
- WAL directories

**Do NOT** build a custom WAL archive mechanism in application code.

Step 2A ships **code + DR tooling + runbook only**. Step 2B (Owner-approved) enables
Railway-managed PITR, creates an isolated restore target, and runs the drill.

## Phase 18 isolated restore-drill tooling (Step 2A)

Package: `@alex-rewards/restore-drill`

CLI (after build):

```text
pnpm phase18:restore-drill
```

Required env (fail-closed; **never** falls back to `DATABASE_URL`):

| Variable | Requirement |
| --- | --- |
| `PHASE18_RESTORE_DRILL_ENABLED` | Must be `true` (default `false`) |
| `PHASE18_RESTORE_DATABASE_URL` | Explicit restore-only connection string |
| `PHASE18_RESTORE_EXPECTED_DATABASE_NAME` | Exact `current_database()` match; rejects known operational names |
| `PHASE18_RESTORE_FEATURE_FLAG_ENVIRONMENT` | Environment for `PAYOUT_DISPATCH_PAUSE` read |
| `PHASE18_RESTORE_VERIFY_USER_IDS` | Optional UUID allowlist (omit → `NOT_EXECUTED`) |

The CLI is **read-only**: schema check, ledger invariants (`checkLedgerInvariants`), Phase 10
restore reconcile (`runPhase10RestoreReconcileScan` with `autoResend: false` /
`autoUnpause: false`), outbox observation, representative counts, optional user-history
aggregates, RTO/RPO **observations** (targets remain `OWNER_POLICY_REQUIRED`).

Step 2A / DB-only mode always reports:

- Temporal workflow live reconciliation = `NOT_OBSERVED`
- Live chain reconciliation = `NOT_OBSERVED`
- `PAYOUT_RESUME_ALLOWED = false`

Evidence artifacts (gitignored): `phase18-restore-drill-<UTC>.json` / `.md`

### Planned Step 2B sequence (NOT executed in Step 2A)

1. Verify payout dispatch pause on source staging
2. Enable/configure Railway-managed PITR
3. Establish backup recovery point
4. Create isolated restore target
5. Restore to isolated target
6. Record restore start/availability timestamps
7. Bind restore validator **ONLY** to isolated DB (`PHASE18_RESTORE_*`)
8. Verify schema (no auto-migrate)
9. Verify `PAYOUT_DISPATCH_PAUSE = true` (validator does not set it)
10. Run ledger invariants
11. Run withdrawal/attempt/outbox DB reconciliation
12. Compare representative source/restored counts
13. Verify selected test-user histories if Owner provides IDs
14. Perform read-only Temporal workflow reconciliation
15. Perform required read-only Testnet chain reconciliation
16. Record observed RTO/RPO
17. Prove financial ambiguity ⇒ payout resume blocked
18. No resume until Owner review

A backup is **not trusted** until successfully restored. No automatic payout resume.

## Hot Wallet / signer custody (v1.3)

Production signing uses **self-hosted encrypted Ed25519 (`FALLBACK_ENCRYPTED`)** under
`apps/signer`. AWS KMS compatibility is historical evidence only; AWS is **not** the production
custody backend. **No signer-custody migration required.**

### Encrypted bundle recovery

1. Keep **two offline encrypted backups** of the Hot Wallet key bundle (ciphertext only).
2. After host loss: restore bundle to a clean signer host, set `SIGNER_KEY_BUNDLE_PATH`, unlock
   via loopback with Owner-held passphrase, verify fingerprint/address, then resume only after
   reconciliation gates pass.
3. Passphrase is never stored in process environment; plaintext seeds are never archived.

### Hot Wallet compromise

1. Pause payout dispatch; hold ambiguous withdrawals.
2. Disable signer unlock / revoke encrypted-bundle access on compromised hosts (and revoke any
   residual historical KMS permission if somehow still present — not part of the production path).
3. Rotate: new Hot Wallet identity + new encrypted bundle + dual offline backups.
4. Update audited Hot Wallet configuration; reconcile ledger vs chain vs funding.
5. Resume dispatch only after Owner approval and mandatory post-restore reconciliation
   (dispatch starts PAUSED after database restore).

### Future providers

HSM or Vault-backed adapters may implement the same `SignPort` / `LockableSignPort` boundary later.
They must not return signing permission to general workers.

See `docs/TON_SIGNER.md` and `docs/OPERATIONS_RUNBOOK.md`.
