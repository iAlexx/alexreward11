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
- Status: `docs/PHASE_10_ACCEPTANCE_REPORT.md` — **IN PROGRESS / BLOCKED**.

See `docs/TON_SIGNER.md` and `docs/DISASTER_RECOVERY.md`.
