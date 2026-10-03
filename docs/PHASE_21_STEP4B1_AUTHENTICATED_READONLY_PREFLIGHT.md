# Phase 21 Step 4B.1 - Authenticated Read-Only Preflight

Status: SOURCE COMPLETE (disposable tests only; no real authenticated preflight run yet)
Date: 2026-10-03
Branch: phase21-mainnet-micro-launch
Baseline HEAD: 9d04c08c256c41bf32e250ebcdf3ea6e0e0e2e62
Public evidence: production ceremony bundle digest 686e3361dedc833312e8698c560b1fccdee84ff3d796cc38a8250c10dce33298

## Purpose

Step 4B left `--preflight-only` unauthenticated (it can only ever report `TRUST_NOT_AUTHENTICATED`).
Step 4B.1 adds a read-only mode whose trust authority is the live Owner TTY digest
authentication, so the Owner can see `readyForOwnerBootstrapApply` before any `--apply`.

## What changed

1. `authenticateProductionCeremonyFromOwnerTty` now returns a scoped
   `AuthenticatedProductionCeremonySession { productionTrust, verifiedPool, close() }`.
   Callers MUST `close()` in `finally`. The pool is also closed internally if trust minting fails
   after pool creation. The CLI `--apply` path reuses `session.verifiedPool` (no second pool).
   An optional `createPoolForTests` hook exists only with `ALEX_OWNER_BOOTSTRAP_TEST_HOOKS=1` and
   `requireInteractiveTty=false`; the production CLI never supplies it.
2. Unauthenticated `runProductionOwnerBootstrapPreflightOnly` no longer accepts
   `trustAuthenticated`. It always reports `trustAuthenticated=false` and
   `readyForOwnerBootstrapApply=false` (`refuseCode=TRUST_NOT_AUTHENTICATED` when otherwise clean).
3. New `runAuthenticatedProductionOwnerBootstrapPreflightOnly({ productionTrust, pool,
   ownerKeyOfflineBackupsReady? })`:
   - asserts the runtime-branded trust (booleans, spreads and fake objects are refused);
   - uses only trust-bound intended admin id/email, endpoint profile id, key id, bundle digest;
   - requires the pool to be the verified pool bound to that trust (connection facts identity);
   - `BEGIN READ ONLY`, verifies `SHOW transaction_read_only = on`, live database /
     system_identifier / TLS state must equal trust facts, always `ROLLBACK`;
   - schema 0024-0028 preflight, Owner seat checks, claim preflight with the root-bound admin;
   - `readyForOwnerBootstrapApply` additionally requires `ownerKeyOfflineBackupsReady === true`
     (default false => `OWNER_KEY_OFFLINE_BACKUPS_PENDING`; never read from env);
   - does not call the orchestrator and has no admin/email override parameters.
4. CLI `run`/`enroll-existing` take exactly one of `--preflight-only`,
   `--authenticated-preflight-only`, `--apply` (`MUTUALLY_EXCLUSIVE_MODES` / `MODE_REQUIRED`).
   `--authenticated-preflight-only` needs a real TTY and `--ceremony-dir`; CA, tls_server_name,
   database and system_identifier come from the ceremony profile only (override flags are refused);
   the Owner types the bundle digest at a live prompt; output is sanitized JSON with a masked email,
   `ownerKeyOfflineBackupsReady` hardcoded false, and the session is closed in `finally`.
5. New `hydrate-intended-admin` command: verify-full connect, `BEGIN READ ONLY`/`ROLLBACK`,
   selects the admin row, requires `ACTIVE`, writes `intended-existing-admin.json` with the
   canonical (trimmed, lower-cased) email, prints the masked email only and whether the existing
   bundle still matches (if not, seal/bundle must be re-drafted). The binding remains a locator,
   not authority.
6. `validateCeremonyEndpointProfileV1` already rejects unknown keys; regression tests now cover
   `dial`, `created_for`, `credential_url_omitted` (top level) and unknown `tls` keys.

## Not done in this step

- No real Owner key, seal, bundle or Channel B regenerated.
- No `--apply`, no `OWNER_PRODUCTION_BOOTSTRAP_APPLY`, no operational DB mutation, no Owner key
  decryption, no passphrase prompt.
- No real Railway authenticated preflight (Owner runs it manually).

## Tests

`pnpm --filter @alex-rewards/auth test:owner-production-bootstrap` against disposable
`alex_rewards_s4b1_test` (loopback production simulation, TEST_HOOKS only) covers: branded-trust
requirement, fake/boolean refusal, tamper refusal, no override params, wrong digest / non-TTY
refusal, pool close on success and failure, READ ONLY query trace + zero row-count drift, forged
connection-fact refusal, hydrate canonical email without printing it, profile extra-key rejection.

## Owner manual command (PowerShell)

Set the DB password in the shell only (never chat/argv), then:

```powershell
$sec = Read-Host 'Railway DB password' -AsSecureString
$env:OWNER_PRODUCTION_BOOTSTRAP_DB_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
Remove-Item Env:OWNER_PRODUCTION_BOOTSTRAP_APPLY -ErrorAction SilentlyContinue
$env:PGUSER = '<railway db user>'
pnpm --filter @alex-rewards/auth build
node packages/auth/dist/cli/owner-production-bootstrap.js run --authenticated-preflight-only `
  --ceremony-dir '<CEREMONY_DIR outside repo>' `
  --proxy-host shinkansen.proxy.rlwy.net --proxy-port 47255
```

At the prompt type the production bundle digest from offline media. Expected before backups are
confirmed: `trustAuthenticated=true`, `refuseCode=OWNER_KEY_OFFLINE_BACKUPS_PENDING`,
`readyForOwnerBootstrapApply=false`. Unset `OWNER_PRODUCTION_BOOTSTRAP_APPLY`.
