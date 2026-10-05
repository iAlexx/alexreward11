# Owner Admin — Production Bootstrap (`production_sealed_v1`)

## Separation from isolated Stage B

| Path | Trust class | DB | Admin creation |
| --- | --- | --- | --- |
| `owner-bootstrap-ceremony` | `ephemeral_isolated_test_only` | loopback `*_test` only | INSERT new admin |
| `owner-production-bootstrap` | `production_sealed_v1` | verify-full + system_identifier | CLAIM_EXISTING_ADMIN |

Isolated tooling continues to refuse operational / production databases.

## Cryptographic authority (Option C)

Owner authority is established only by:

- External ceremony seal + dual Channel A/B evidence
- Signed `FIRST_OWNER_ENROLLMENT` grant
- Owner PoP + channel PoP + FinalCredReq
- Atomic consume + OWNER binding insert

**Not** authority: admin UUID, email, Telegram ID, Railway access, vacant seat, Hot Wallet possession, DB password.

## CLAIM_EXISTING_ADMIN

When an ACTIVE admin row already exists (current ops observation):

1. Preflight eligibility (exact id+email, vacant seat, no OWNER history, no ACTIVE PASSWORD/TOTP)
2. Cryptographic ceremony must still pass
3. Final TX binds OWNER role to existing row (no `admin_users` INSERT)
4. M0 trigger `app_enforce_single_owner_authority` claims seat — no manual `UPDATE admin_owner_authority`
5. Production refuses silently reactivating a DISABLED OWNER role

## TLS

Production requires verify-full with Owner CA + hostname. Plaintext / `rejectUnauthorized=false` / loopback are refused.

If Railway access cannot satisfy verify-full endpoint trust:

```text
PRODUCTION_BOOTSTRAP_TLS_STATUS=BLOCKED_ENDPOINT_TRUST
```

## APPLY gates (future)

```text
DEPLOYMENT_ENV=production
OWNER_PRODUCTION_BOOTSTRAP_ENABLED=true
OWNER_PRODUCTION_BOOTSTRAP_APPLY=1
--apply
```

No `forceApply`. Password/TOTP never via env/argv.

## Hot Wallet separation

Phase21 payout Hot Wallet fingerprint must never be used as Owner bootstrap / seal / grant signing key.

## Step 4A.1 corrections

- `AuthenticatedProductionBootstrapTrust` (WeakSet-branded); caller `trustClass` refused
- `ProductionCeremonyBundleV1` root-binds intended admin; Channel B authenticates bundle digest via live Owner TTY
- Same-host Channel B JSON is documentary only
- Production lifecycle wrappers; isolated path unchanged
- Fail-closed existing-admin auth/session inspection (correct `idle_expires_at` / `absolute_expires_at`)
- Witness model: HUMAN_ATTESTED (not cryptographic identity proof)

## Step 4A.2 final hardening (source only)

- `mintAuthenticatedProductionBootstrapTrust` package-private (not exported from `owner-bootstrap/index` or `@alex-rewards/auth` root)
- Public API: `AuthenticatedProductionBootstrapTrust` type, is/assert helpers, `authenticateProductionCeremonyFromOwnerTty`
- `tryForgeProductionTrustFromCallerTrustClass` removed from public API; test-only under `ALEX_OWNER_BOOTSTRAP_TEST_HOOKS=1`
- Production Owner key: Argon2id + XChaCha20-Poly1305 `.enc` bundle; no plaintext `bootstrap-private-seed.hex`; passphrase TTY-only
- Schema preflight: `version` ORDER BY version; migrations 0024-0028; 0028 duplicate `(attempt_id, nonce_hex)` check does not apply
- CLI `run` orchestrates lifecycle; APPLY default NO; Step4A.2 refuses real apply; no `forceApply`
- Encrypted key backups: >=2 offline ciphertext copies; key dir outside repo / not temp / not cloud sync
- `SOURCE_READY=YES`; `SCHEMA_READY` / `ENDPOINT_TRUST_READY` / `TRUST_RESOURCES` / `READY_FOR_CEREMONY=NO`; `REAL_OWNER_BOOTSTRAP_KEY_GENERATED=NO`
- See `docs/PHASE_21_STEP4A2_FINAL_OWNER_BOOTSTRAP_HARDENING.md`

## Step 4B.1 authenticated read-only preflight

- `run --authenticated-preflight-only` authenticates the production bundle digest at a live Owner TTY
  (public digest reference `686e3361dedc833312e8698c560b1fccdee84ff3d796cc38a8250c10dce33298`) and then runs a
  `BEGIN READ ONLY` preflight bound to the same verified pool. Unauthenticated `--preflight-only` can never be ready.
- `authenticateProductionCeremonyFromOwnerTty` returns a scoped session; callers `close()` in `finally`.
- `hydrate-intended-admin` writes the canonical admin email into the binding file (masked output only).
- See `docs/PHASE_21_STEP4B1_AUTHENTICATED_READONLY_PREFLIGHT.md`.

## Step 4B.2 - safe APPLY hardening (2026-10-03)

- Production TOTP is Owner-enrolled: the orchestrator requires `totpSecretBytes` + a live `totpConfirmCode` and never auto-generates or auto-confirms.
- `--apply` order: gates, TTY, ceremony dir/connection, live Channel B, backup attestation phrase `I_HAVE_TWO_SHA256_VERIFIED_OFFLINE_OWNER_KEY_BACKUPS`, authenticated read-only preflight, strict READY gate (`APPLY_PREFLIGHT_NOT_READY` stops with zero mutation), TOTP enrollment (Issuer LOOTRA, Account Owner, secret shown once on stderr, Owner types current code), passphrase/password, password policy, final phrase `APPLY_LOOTRA_PRODUCTION_OWNER_BOOTSTRAP`, then decrypt + lifecycle, then read-only `verify-apply` checks.
- Failures are classified `PRE_MUTATION_FAILURE` or `PARTIAL_LIFECYCLE_RECONCILIATION_REQUIRED` (no rollback claimed; do not retry blindly).
- Real APPLY is Owner-manual only after independent review; Cursor must not execute it.
- Step 4B.2a: CLI secret input uses shared `readSecretFromTty` (stdin.resume after readline). If APPLY aborted at the TOTP code prompt, delete the abandoned authenticator entry and start fresh (new TOTP each run).
- See `docs/PHASE_21_STEP4B2_SAFE_OWNER_APPLY.md`.

## Phase 21 Step 4C closeout (sanitized)

- `PRODUCTION_OWNER_BOOTSTRAP=COMPLETE`
- `OWNER_ADMIN_USER_ID=a11a11a1-0000-4000-8000-000000000011`
- `OWNER_GRANT_ID=e075fc33-ee46-4848-ac84-53c509adc96f`
- `OWNER_ATTEMPT_ID=ccd4b016-6dd8-43a8-a536-ee341d2fad7e`
- Subsequent Phase 21 APPLY tools require branded Owner ceremony trust (TTY password+TOTP); `PHASE21_CEREMONY_ADMIN_USER_ID` is a locator only.
- See `docs/PHASE_21_STEP4C_OWNER_CLOSEOUT_AND_HOT_WALLET_READINESS.md`.
