# PHASE 21 - STEP 4A.2 - Final Owner Bootstrap Hardening

**Status:** SOURCE ONLY - no real ceremony executed  
**Date:** 2026-10-03  
**Branch:** `phase21-mainnet-micro-launch`  
**Parent:** Step4A / Step4A.1  
**Step4:** `PAUSED_OWNER_AUTHORITY_REQUIRED`

## Scope

Step4A.2 hardens production Owner-bootstrap **source** (trust mint privacy, encrypted Owner key, schema preflight, CLI APPLY refusal). It does **not** run a real ceremony, generate a real Owner key, bind Owner authority, claim the seat, mutate credentials, enable Railway TCP Proxy, or unfreeze the Hot Wallet.

## Architecture fixes

| Area | Step4A.2 truth |
| --- | --- |
| Trust mint | `mintAuthenticatedProductionBootstrapTrust` is package-private - **not** exported from `owner-bootstrap/index` or `@alex-rewards/auth` root |
| Brand + mint | WeakSet brand and mint live in an internal module |
| Public API | `AuthenticatedProductionBootstrapTrust` type; `is` / `assert` helpers; `authenticateProductionCeremonyFromOwnerTty` |
| Caller forge | `tryForgeProductionTrustFromCallerTrustClass` removed from public API; test-only helper under `ALEX_OWNER_BOOTSTRAP_TEST_HOOKS=1` |
| Production Owner key | Argon2id + XChaCha20-Poly1305 encrypted `.enc` bundle; **no** plaintext `bootstrap-private-seed.hex` |
| Passphrase | Interactive TTY only - never env / argv / JSON / stdout |
| Schema migrations query | Column `version` `ORDER BY version` |
| Required migrations | `0024_owner_admin_auth_hardening`, `0025_single_owner_authority`, `0026_owner_bootstrap_grants`, `0027_signer_login_isolation`, `0028_owner_bootstrap_attempt_nonce_attempt_wide` |
| 0028 preflight | Groups by `(attempt_id, nonce_hex) HAVING count(*)>1` - catches cross-purpose nonce reuse; does **not** apply migration |
| Operator CLI | `owner-production-bootstrap run` orchestrates full lifecycle; **APPLY default NO**; Step4A.2 refuses real apply; no `forceApply`; secrets TTY-only |
| Redeem | `redeem.ts` uses single `assertBootstrapEndpointForTrust` helper |
| Encrypted key backups | Require >=2 offline ciphertext backups before real ceremony; passphrase separate; no cloud sync |
| Key directory | Outside repo; not temp; not OneDrive / Dropbox / Google Drive |

## Hot Wallet (unchanged)

Hot Wallet remains **frozen**. Registered address (identity only; not Owner bootstrap authority):

```text
EQD4NWgFbqCOIGQL9k0SDIP8onQH9cj_MxDcBr3N7DYLy8Lf
```

Hot Wallet keys must never be reused as Owner bootstrap / seal / grant signing material.

## Railway / endpoint trust

```text
DATABASE_PUBLIC_URL=absent (do not invent)
TCP Proxy=do not enable for this step
railway connect / tunnel=DISCOVERY_ONLY_NOT_TRUST_AUTHORITY
```

Ceremony endpoint trust still requires Owner-approved verify-full profile + `expected_system_identifier`. Discovery tunnels are not trust authority.

## Ready states (honest)

```text
PRODUCTION_OWNER_BOOTSTRAP_SOURCE_READY=YES
PRODUCTION_OWNER_BOOTSTRAP_SCHEMA_READY=NO
PRODUCTION_OWNER_BOOTSTRAP_ENDPOINT_TRUST_READY=NO
PRODUCTION_OWNER_BOOTSTRAP_TRUST_RESOURCES_READY=NO
READY_FOR_PRODUCTION_OWNER_BOOTSTRAP_CEREMONY=NO

REAL_OWNER_BOOTSTRAP_KEY_GENERATED=NO
```

`SOURCE_READY` progresses to **YES** after Step4A.2 source fixes. `SCHEMA_READY` / `ENDPOINT_TRUST_READY` / `TRUST_RESOURCES` / `READY_FOR_CEREMONY` remain **NO** without a real trusted endpoint and Owner-held ceremony resources.

## Not executed

- Real Owner bootstrap key generation / encryption ceremony
- Owner binding / seat claim / credential mutation
- Production APPLY / operational DB writes for bootstrap
- Railway public endpoint enablement
- Hot Wallet unfreeze / funding / payout enable
- Step4 operational APPLY

## Related docs

- `docs/OWNER_ADMIN_PRODUCTION_BOOTSTRAP.md`
- `docs/PHASE_21_STEP4A_PRODUCTION_OWNER_BOOTSTRAP_READINESS.md`
- `docs/PHASE_21_STEP4A1_PRODUCTION_OWNER_BOOTSTRAP_CORRECTIONS.md`
- `docs/PHASE_21_READINESS_MATRIX.md`

