# Signer database privilege isolation (S-05)

## Problem

Compose previously wired `SIGNER_DATABASE_URL` with shared `POSTGRES_USER` /
`POSTGRES_PASSWORD`. That login is typically table owner / broad DDL+DML capable.
A signer process that *queries* only `signer_withdrawal_attempt_signing_v` is **not**
isolated if its credential can mutate financial tables.

## Local (Docker / isolated_test)

1. Apply migrations through `0027_signer_login_isolation.sql` (creates LOGIN
   `alex_rewards_signer` inheriting `alex_rewards_signer_ro`; password NULL).
2. Provision password **outside** migrations (never commit production secrets):

```sql
-- LOCAL ONLY — run via scripts/provision-signer-db-role.mjs (binds password safely).
-- ALTER ROLE alex_rewards_signer WITH LOGIN PASSWORD '<local-only>';
-- GRANT CONNECT ON DATABASE "<db>" TO alex_rewards_signer;
```

Helper (local disposable DB):

```bash
DATABASE_URL=... SIGNER_DB_PASSWORD=local-signer-ro-only node scripts/provision-signer-db-role.mjs
```

Uses env `SIGNER_DB_PASSWORD` (required) against admin `DATABASE_URL`.

3. Compose / `.env` must set:

```text
SIGNER_DB_USER=alex_rewards_signer
SIGNER_DB_PASSWORD=<local-only>
SIGNER_DATABASE_URL=postgresql://alex_rewards_signer:<local-only>@postgres:5432/${POSTGRES_DB}
```

API/Worker continue to use `POSTGRES_USER` / `DATABASE_URL` and must **not** be
granted `alex_rewards_signer` / `alex_rewards_signer_ro`.

## Staging / production (NOT executed by this remediation)

Operational credential change is **Owner-approved ops**, not this code change:

1. Create/rotate `alex_rewards_signer` password via secret manager.
2. `GRANT CONNECT` on the target database.
3. Point signer only at `SIGNER_DATABASE_URL` with that login.
4. Confirm API/worker roles are **not** members of `alex_rewards_signer*`.
5. Restart signer; fail-closed privilege assert must pass.

This document does **not** authorize live ops migration.

## Fail-closed startup

`apps/signer` calls `assertSignerDatabaseReadBoundary` before serving traffic.
Privileged / writable sessions are rejected.
