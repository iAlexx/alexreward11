# Operations runbook

## Phase 1 foundation

Use `pnpm dev:stack` to start the local foundation and `pnpm smoke` to verify it. Inspect services
with `docker compose -f infra/docker/compose.yaml --env-file .env --profile apps ps`. Stop without
data deletion using `pnpm dev:stack:down`. Production financial operations beyond the signer
custody notes below remain phase-gated.

## Signer custody (Phase 9 / v1.3) — self-hosted encrypted

Authority: Master Spec v1.3. Production target: `apps/signer` + `FALLBACK_ENCRYPTED`.
**No signer-custody migration required.** AWS operational helpers are removed; there is no AWS
dependency on the production signing path.

### Keygen (offline / controlled host)

1. On a trusted machine, generate seed + encrypt bundle via `@alex-rewards/signing`
   (`generateHotWalletSeed`, `encryptKeyBundle`, `writeKeyBundleFile`).
2. Confirm derived Wallet V5 R1 address and `publicKeyFingerprint` for TESTNET (`-3`).
3. Install ciphertext at `SIGNER_KEY_BUNDLE_PATH` on the signer host only (restrictive file mode).
4. Create **two offline encrypted backups** of the same bundle file; store separately from the live host.
5. Destroy plaintext seed from memory/disk; never place passphrase in env files.

### Unlock

1. Ensure `SIGNER_KEY_MODE=self_hosted_encrypted` and bundle path are set.
2. Start signer (boots **LOCKED**).
3. From loopback only: `POST /v1/local-unlock` with `{ "passphrase": "..." }`.
4. Confirm health/readiness reports `custodyState=UNLOCKED` and `signingReady=true`.
5. Relock with `POST /v1/local-relock` when signing window ends; restart always returns to LOCKED.

### Backup / restore drill

1. Copy live ciphertext bundle to offline media (backup #1 and #2).
2. Practice restore onto a non-production signer host: place file, unlock, verify fingerprint/address match, relock.
3. Document Owner custody of passphrase material separately from backups.

### Rotation / Hot Wallet replacement

1. Pause payout dispatch.
2. Generate new seed + new encrypted bundle + dual offline backups.
3. Update audited Hot Wallet rows / `SIGNER_EXPECTED_SIGNER_REFERENCE`.
4. Deploy new bundle; unlock; verify identity; destroy old unlock capability and obsolete backups under Owner procedure.

### Compromise response (summary)

Pause dispatch → relock / revoke host+backup access → rotate Hot Wallet / bundle → reconcile →
Owner approval before resume. Future HSM/Vault may plug in via `SignPort` / `LockableSignPort`
without giving signing rights to API/bot/worker.

## Phase 10 Testnet payout foundation (broadcast outside signer)

- `apps/signer` signs only and may return `externalMessageBocBase64`; it must not call TON RPC.
- Worker / withdrawals persist signed BOC evidence **before** `sendBoc`, classify ambiguous RPC
  outcomes, and never blind-resend after `broadcast_submitted_at` or ambiguity.
- Keep `WITHDRAWAL_REAL_CHAIN_ENABLED=false` until Owner sets `TON_TESTNET_JETTON_MASTER` and
  Testnet provider URLs. Fake chain remains for Phase 7 local tests.
- Forbidden: Mainnet, AWS KMS, plaintext Hot Wallet keys in env.
- Status: `docs/PHASE_10_ACCEPTANCE_REPORT.md` — **PHASE 10 CODE COMPLETE — LIVE VALIDATION READY (NOT CLOSED)**.

## Phase 10 Testnet Available provisioning (internal Owner CLI)

**Testnet only. Host-access Owner-operated tool. Default OFF. Not a production balance editor.**

Used only to provision a deliberately small withdrawable Available USDT balance to ONE
configured allowlisted controlled Testnet user for Phase 10 payout validation.

Config (safe placeholders only; never commit real user IDs):

- `PHASE10_TESTNET_AVAILABLE_PROVISION_ENABLED=false`
- `PHASE10_TESTNET_PROVISION_ALLOWED_USER_ID=` (UUID when enabling)
- `PHASE10_TESTNET_PROVISION_MAX_ATOMIC=1000000`
- `PHASE10_TESTNET_PROVISION_OWNER_ADMIN_USER_ID=` (ACTIVE Owner admin UUID when enabling)

CLI (after `pnpm --filter @alex-rewards/ledger build`):

```text
pnpm --filter @alex-rewards/ledger run phase10:provision-available -- \
  --operation-id 00000000-0000-4000-8000-000000000001 \
  --user-id 00000000-0000-4000-8000-000000000002 \
  --amount-atomic 100000 \
  --reason "phase10-controlled-testnet-provision"

pnpm --filter @alex-rewards/ledger run phase10:reverse-available -- \
  --operation-id 00000000-0000-4000-8000-000000000003 \
  --original-ledger-tx 00000000-0000-4000-8000-000000000004 \
  --reason "phase10-controlled-testnet-provision-reverse"
```

Preserve the exact `--operation-id` UUID for safe retries. Reversal goes through the guarded
ledger reversal API only.

See `docs/TON_SIGNER.md` and `docs/DISASTER_RECOVERY.md`.

## Phase 10 operational tooling (read-only / dry-run)

Status: **tooling available — no live Testnet yet.** Do not unlock signer, enable real
chain, start worker payout dispatch, fund users, or mutate live `alex_rewards` until
Owner external resources and an explicit controlled live gate are approved.

CLI (after `pnpm --filter @alex-rewards/withdrawals build`):

```text
pnpm --filter @alex-rewards/withdrawals run phase10:readiness
pnpm --filter @alex-rewards/withdrawals run phase10:preflight
pnpm --filter @alex-rewards/withdrawals run phase10:restore-reconcile
pnpm --filter @alex-rewards/withdrawals run phase10:hot-wallet-monitor
pnpm --filter @alex-rewards/withdrawals run phase10:campaign-plan
```

Optional: `--user-id <uuid>` on readiness/preflight; `--mode real` on campaign-plan
(refused unless every explicit gate object field is true — env is never flipped).

### Readiness / preflight

- `runPhase10Readiness` — PASS/WARN/BLOCKED items + machine-readable summary (no secrets).
- Distinguishes **intentionally_safe_off** (real chain still disabled / resources not set)
  from **misconfigured** (real enabled but incomplete).
- `runPhase10Preflight` aggregates readiness + restore scan →
  `READY_FOR_CONTROLLED_LIVE_TESTNET` or `BLOCKED`.

### Restore → pause → reconcile

After any database restore:

1. Ensure `PAYOUT_DISPATCH_PAUSE` remains enabled (do not unpause from tooling).
2. Run `phase10:restore-reconcile` (read-only). Categories include approved-without-workflow,
   submitted/UNKNOWN needing chain observation, confirmed-without-settlement, pending outbox
   recovery, competing attempt lineage, synthetic UNKNOWN isolation.
3. **Never auto-resend.** **Never unpause** from this scanner.
4. Resume only after Owner review of findings + mandatory reconciliation.

### Campaign dry-run

`phase10:campaign-plan` (default `dry-run`) emits the intended scenario matrix from
`PHASE10_FAILURE_SCENARIO_CATALOGUE` (`LOCAL_DETERMINISTIC` vs `REQUIRES_REAL_TESTNET`).
It creates **no** withdrawals and does not flip env. Real mode is refused unless every
gate in the explicit gates object is `true`.
