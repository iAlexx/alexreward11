# Owner admin operational database identity (design)

**Status:** DESIGN — Owner-auth subsystem **operational default-deny** is implemented in code.
**Operational readiness:** **BLOCKED**.
**Related:** FS-01, ADR-019, `docs/OWNER_ADMIN_BOOTSTRAP_DESIGN.md`.

## Implemented policy (code)

All Owner-auth entry points call `assertOwnerAdminAuthDatabaseWritable`, which invokes
`assertOwnerAuthOperationalDefaultDeny` when `current_database()` or `expectedDatabase` is
`alex_rewards`. **No** cluster identifier, confirmation literal, or URL makes ops access succeed.

Blocked APIs until a separately approved trust ceremony exists:

- `preflightOwnerAdminEnrollment`
- `completeOwnerAdminTotpEnrollment` (first enroll and replace)
- `loginOwnerAdmin`
- `reauthenticateOwnerAdminSession`
- `logoutOwnerAdminSession`
- `verifyOwnerAdminPasswordAndTotp`

Unconditional first-enrollment refusal for ops remains as an additional belt-and-suspenders check
inside enrollment (still unreachable while default-deny holds).

## Required trustworthy target identity (future Owner ceremony)

1. Owner-controlled expected database name.
2. Owner-controlled expected cluster `system_identifier` (out-of-band record).
3. Owner-controlled expected endpoint / TLS identity for the transport actually used.
4. Least-privilege Owner-auth DB role.
5. Intent confirmation literal — intent only, never identity.

Until that ceremony is approved **and** implemented, operational Owner-auth remains refused.

## Residual risks

- Compromised Operator host; cloned clusters without endpoint pinning; over-privileged roles.
