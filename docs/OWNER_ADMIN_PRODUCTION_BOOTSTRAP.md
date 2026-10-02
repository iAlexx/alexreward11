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
