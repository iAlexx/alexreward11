# Owner admin authentication — Owner review package (Round 2)

**Branch:** `feature/owner-admin-session-auth`

**Baseline:** `f1798ca7b6b656a943dabadec1acdb7c96e8e6aa`

**Scope:** Local source + isolated tests only. No ops writes, Recovery mutate, Worker,
Temporal, Signer, TON broadcast, commit, push, merge, or deploy.

**Authoritative Round-2 review file**
`ALEX_REWARDS_OWNER_AUTH_POST_REMEDIATION_INDEPENDENT_REVIEW.md` was **not found**
in the local Downloads path at remediation time; findings R-01–R-06 were taken from
the Owner remediation prompt.

## Implementation summary (post Round 2)

- **Factors:** password (Argon2id) + TOTP into `admin_credentials`.
- **Sessions:** opaque tokens; `sha256Hex("admin-session:" + token)`; 15-minute same-session reauth.
- **R-01:** ACTIVE unsupported credentials (WEBAUTHN / unknown) refuse enroll/replace; no silent WebAuthn removal.
- **R-02:** `withPoolOwnedOwnerAuthTransaction` commits auth failure accounting before throwing; concurrent lockout tests.
- **R-03:** operational path requires Owner-controlled `expectedClusterSystemIdentifier` vs `pg_control_system().system_identifier` (see `OWNER_ADMIN_DB_IDENTITY_DESIGN.md`).
- **R-04:** no secret-bearing serializable enroll/login JSON; `LoginOwnerAdminBundle.takeSessionTokenOnce()`; TTY-only CLI.
- **R-05:** docs corrected; expanded regression suite.
- **R-06:** Pool-owned transactions only; `PoolClient` nesting refused; caller-owned path does not COMMIT/ROLLBACK outer txns.
- **Bootstrap:** design-only; operational first enrollment remains **BLOCKED**.

## Changed files (Round 2 delta on baseline work)

| Path | Change |
| --- | --- |
| `packages/auth/src/admin-auth.ts` | AuthOutcome protocol, mixed-cred policy, cluster id, Pool ownership, session bundle |
| `packages/auth/src/cli/owner-admin-auth.ts` | cluster env; `takeSessionTokenOnce`; no provisioning JSON |
| `packages/auth/src/index.ts` | exports |
| `packages/auth/test/owner-admin-auth.test.ts` | R-01–R-06 coverage |
| `docs/OWNER_ADMIN_AUTH.md` | corrected usage / limitations |
| `docs/OWNER_ADMIN_AUTH_REVIEW.md` | this review package |
| `docs/OWNER_ADMIN_BOOTSTRAP_DESIGN.md` | design-only status |
| `docs/OWNER_ADMIN_DB_IDENTITY_DESIGN.md` | cluster identity design |
| `docs/PHASE10_CANARY_SIGNING_RECOVERY.md` | handoff; no ops first-enroll pretend |
| `migrations/0024_owner_admin_auth_hardening.sql` | throttle + totp step (local/test only until Owner ops approval) |

## Authentication / enrollment instructions

See `docs/OWNER_ADMIN_AUTH.md`. **Operational first enrollment does not work and must not be attempted.**

Isolated test path only:

1. ACTIVE Owner UUID with OWNER binding on an approved `*_test` DB.
2. `OWNER_ADMIN_AUTH_DATABASE_URL` + `--expected-database` matching live name.
3. `pnpm --filter @alex-rewards/auth run build`
4. `owner-admin-auth enroll|login|reauth|logout` with TTY secrets.

## Test results

Recorded after Round 2 validation against isolated `alex_rewards_test` (see final report).
Do **not** treat sequential lockout alone as proof that the throttle race is fixed —
concurrency tests are required and included.

**Not run:** Recovery mutate/dry-run, ops enrollment, Worker, Temporal, Signer, TON broadcast,
real Owner credentials, Windows Terminal smoke with real secrets.

## Security limitations

1. Operational first enrollment **BLOCKED** (bootstrap design not implemented).
2. WebAuthn verification/replacement not implemented — mixed ACTIVE WEBAUTHN refuses replace.
3. Local TOTP seal is password-bound, not KMS/HSM.
4. Terminal screen recording remains a residual exposure.
5. Cluster `system_identifier` requires Owner out-of-band custody for ops.
6. Spec browser Admin WebAuthn Control Plane remains unimplemented.

## Review checklist

- [ ] R-01–R-06 remediation acceptable for another independent review
- [ ] Mixed WebAuthn fail-closed policy acceptable as interim
- [ ] AuthOutcome failure-commit protocol acceptable
- [ ] Cluster identity design acceptable / ops still BLOCKED until bootstrap
- [ ] Secret output surfaces acceptable
- [ ] Isolated test results accepted
- [ ] No merge/push until Owner GO
- [ ] No claim of full security approval

## Readiness distinction

| Surface | Status |
| --- | --- |
| Local code review | Ready for independent re-review of uncommitted Round 2 diff |
| Commit | **Not ready** — Owner has not authorized commit |
| Operational | **BLOCKED** — bootstrap + ops migration approval missing |
| Recovery mutate | **BLOCKED** — requires real Owner session + separate Owner authorization |

## Exact future deployment requirements

1. Owner GO to commit/merge (separate from this stop).
2. Owner-approved application of migration 0024 to ops (separate).
3. Approved bootstrap ceremony before any ops first enrollment.
4. Owner custody of production `system_identifier` before ops privileged auth writes.
5. Build `@alex-rewards/auth` into the Operator artifact used for Recovery.
