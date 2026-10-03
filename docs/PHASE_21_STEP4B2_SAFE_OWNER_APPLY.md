# Phase 21 Step 4B.2 - Safe production Owner bootstrap APPLY hardening

Status: SOURCE + DISPOSABLE-DB TESTS ONLY. No real `--apply` was run. Cursor/CI must never execute
`--apply`, never set `OWNER_PRODUCTION_BOOTSTRAP_APPLY=1` in any real Railway/operational path, never
regenerate or decrypt the real Owner key, and never mutate the operational database. A real APPLY is an
Owner-manual action performed only after independent review of this step.

## Step 4B.2a — Windows interactive secret input fix

Observed on real Windows PowerShell: after Channel B + backup attestation + authenticated
preflight + one-time TOTP display, the CLI printed the TOTP confirmation prompt and the Node
process exited before any secret was entered (Owner typed the code at the `PS>` prompt). Root
cause: the production CLI had a local `readSecret` that attached `stdin.on('data')` without
`stdin.resume()`. Closing a prior `readline` Interface pauses stdin; on Windows that left no
active handle, so Node exited with the Promise still unresolved. No APPLY confirmation, passphrase,
password, or orchestrator mutation occurred.

Fix: remove the local duplicate reader; all production CLI secrets use shared `readSecretFromTty()`
(`packages/auth/src/tty-secret.ts`), which calls `prepareStdinForSecretRead()` → `stdin.resume()`,
sets raw mode, attaches one listener, and always removes the listener + restores raw mode in
`finally` (including Ctrl+C). Regression: `test/tty-secret.test.ts` (readline pause → resume → CR
complete). Each APPLY still calls `generateTotpSecretBytes()` fresh; an aborted enrollment secret
must never be reused (delete the abandoned authenticator entry).

## What changed

1. **Production TOTP has no auto-confirm.** `orchestrateProductionOwnerBootstrapCeremony` now REQUIRES
   `totpSecretBytes` (non-empty) and `totpConfirmCode` (6 digits, verified with `verifyTotpCode`). It never
   generates a secret or a code. The check runs before any database access, key decryption, grant or attempt
   creation, so a missing/wrong code cannot leave a partial lifecycle. The orchestrator works on a private
   copy of the secret and zeroizes it in `finally`; the caller's buffer is not touched. The
   `ALEX_OWNER_BOOTSTRAP_DISPOSABLE_PRODUCTION_SIM` flag does not re-enable auto-confirm; disposable tests
   supply the secret and a code explicitly.
2. **Interactive backup attestation** (`attestOwnerOfflineBackupsInteractive`). Owner types exactly
   `I_HAVE_TWO_SHA256_VERIFIED_OFFLINE_OWNER_KEY_BACKUPS`. Requires stdin+stdout TTY. No env/argv/boolean
   shortcut exists. A reader can be injected only with `ALEX_OWNER_BOOTSTRAP_TEST_HOOKS=1` together with
   `requireInteractiveTty: false`.
3. **Final APPLY confirmation** (`confirmProductionOwnerBootstrapApplyInteractive`). Owner types exactly
   `APPLY_LOOTRA_PRODUCTION_OWNER_BOOTSTRAP`. Same TTY / test-hook rules.
4. **Strict READY gate** (`assertApplyPreflightReady`, `listApplyPreflightBlockers`). Apply stops with
   `APPLY_PREFLIGHT_NOT_READY` and zero mutation unless the authenticated read-only preflight reports
   trustAuthenticated, tlsEndpointVerified, schemaReady, ownerSeatReady, targetAdminReady,
   targetAdminSecurityState `CLEAN`, ownerKeyBackupsReady, readyForOwnerBootstrapApply, `refuseCode: null`
   and `operationalDbMutation: false`.
5. **Post-apply read-only verification** (`verifyProductionOwnerBootstrapApplyReadOnly`, CLI `verify-apply`).
   `BEGIN READ ONLY` + `SHOW transaction_read_only` + `ROLLBACK`. Checks: admin ACTIVE, Owner seat holder,
   exactly 1 active Owner binding, 1 active PASSWORD, 1 active TOTP, grant `CONSUMED`, attempt `CONSUMED`,
   enrollment audit record. Output is sanitized (no email, no secret material, no hashes).
6. **Standalone `--authenticated-preflight-only`** now prompts for the same backup attestation after live
   Channel B. Exact phrase => `ownerKeyBackupsReady=true` and (if the DB is otherwise fine)
   `readyForOwnerBootstrapApply=true`. A wrong/empty phrase does not hard-fail the report: backups stay
   pending and the command exits 1 with `OWNER_KEY_OFFLINE_BACKUPS_PENDING` while still reporting DB
   readiness fields. The preflight remains read-only.

## `--apply` order (runApplyCommand)

1. Gates: `--apply`, `DEPLOYMENT_ENV=production`, `OWNER_PRODUCTION_BOOTSTRAP_ENABLED=true`,
   `OWNER_PRODUCTION_BOOTSTRAP_APPLY=1`.
2. Require real TTY (stdin, stdout, stderr). Profile-only overrides (`--database`, `--ca-file`,
   `--tls-server-name`, `--email`, `--system-identifier`) are refused: they come from the ceremony dir.
3. Load ceremony dir, endpoint profile, public key, encrypted bundle (ciphertext only; NOT decrypted yet).
4. Build the connection string with a numeric public dial IP.
5. Live Channel B authentication (`authenticateProductionCeremonyFromOwnerTty`).
6. Backup attestation phrase.
7. Authenticated read-only preflight with `ownerKeyOfflineBackupsReady: true`.
8. Strict READY gate; otherwise STOP with `APPLY_PREFLIGHT_NOT_READY` (no mutation).
9. TOTP enrollment: secret shown once on interactive stderr (Issuer `LOOTRA`, Account `Owner`, base32 secret,
   optional `otpauth://` URI); Owner enters the current 6-digit code; verified locally. Failure stops
   pre-mutation and zeroizes the secret.
10. Bootstrap passphrase, new password, confirmation (no echo, never argv/env).
11. Password policy and confirmation match checked before any mutation.
12. Final phrase `APPLY_LOOTRA_PRODUCTION_OWNER_BOOTSTRAP`. If the TOTP code is older than 15 s it is
    re-requested here (still pre-mutation) so it cannot go stale inside the lifecycle.
13. Only now the orchestrator decrypts the Owner key in memory and runs the lifecycle (TOTP secret + code
    passed in).
14. Post-apply read-only verification on the same verified pool.
15. Sanitized JSON result only (masked email, ids, verification facts).
16. `finally`: session/pool closed, TOTP secret zeroized.

Failure classification: errors before the orchestrator call => `PRE_MUTATION_FAILURE`. Errors after the
orchestrator was invoked => `PARTIAL_LIFECYCLE_RECONCILIATION_REQUIRED` (mutation state unknown, no rollback
is claimed, do not retry blindly; inspect read-only first). The lifecycle's final enrollment transaction
(credentials, binding, seat, grant/attempt consumption, audit) is a single database transaction; the
earlier grant/attempt/PoP steps are separate committed steps, which is why post-orchestrator failures need
reconciliation rather than a retry.

The internal `permitApplyEnvironment` option on `runAuthenticatedProductionOwnerBootstrapPreflightOnly`
only skips the "APPLY env is set" refusal so the apply command can run its read-only gate; the evaluation is
still `BEGIN READ ONLY` + `ROLLBACK` and is trace-tested.

## Owner PowerShell template for a FUTURE manual APPLY

NOT TO RUN until the independent review of Step 4B.2 is complete. Cursor did not execute this. Fill the
placeholders yourself; never paste secrets into chat. Run only from the Owner workstation in a real
interactive terminal.

```powershell
# Real TTY only. DB password is entered into the shell by the Owner, never committed or shared.
$env:OWNER_PRODUCTION_BOOTSTRAP_DB_PASSWORD = Read-Host -AsSecureString | ConvertFrom-SecureString -AsPlainText
$env:DEPLOYMENT_ENV = 'production'
$env:OWNER_PRODUCTION_BOOTSTRAP_ENABLED = 'true'
$env:OWNER_PRODUCTION_BOOTSTRAP_APPLY = '1'
pnpm --filter @alex-rewards/auth owner-production-bootstrap run --apply `
  --ceremony-dir "<OWNER_CEREMONY_DIR_OUTSIDE_REPO>" `
  --proxy-host "<RAILWAY_TCP_PROXY_DOMAIN>" --proxy-port <PORT> --user "<DB_USER>"
# Immediately afterwards (always):
Remove-Item Env:OWNER_PRODUCTION_BOOTSTRAP_APPLY, Env:OWNER_PRODUCTION_BOOTSTRAP_DB_PASSWORD, Env:DEPLOYMENT_ENV, Env:OWNER_PRODUCTION_BOOTSTRAP_ENABLED
# Independent re-check (read-only), using ids from the APPLY output:
pnpm --filter @alex-rewards/auth owner-production-bootstrap verify-apply `
  --ceremony-dir "<OWNER_CEREMONY_DIR_OUTSIDE_REPO>" --proxy-host "<RAILWAY_TCP_PROXY_DOMAIN>" `
  --proxy-port <PORT> --user "<DB_USER>" --admin-user-id <ADMIN_UUID> --grant-id <GRANT_UUID> --attempt-id <ATTEMPT_UUID>
```

## Tests

`pnpm --filter @alex-rewards/auth test:owner-production-bootstrap` (disposable DB `alex_rewards_s4b2_test`
on 127.0.0.1 via `OWNER_ADMIN_AUTH_DATABASE_URL`). Covers: attestation/confirmation phrase rules, READY gate,
CLI ordering and source constraints, orchestrator TOTP requirements (missing/empty/wrong => no pool access),
disposable full lifecycle with explicit TOTP (PASSWORD=1, TOTP=1), wrong TOTP leaves seat empty and zero
credentials/bindings/grants/attempts, post-apply verify (read-only trace, negative case), pool close.
