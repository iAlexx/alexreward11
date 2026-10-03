# Phase 21 Step 4B - Owner Ceremony Preparation

Status: IN_PROGRESS preparation complete up to pre-keygen / witness gate
Date: 2026-10-03
Branch: phase21-mainnet-micro-launch
Baseline Step4A.2 HEAD: e7e6600f59e40e6da1c75a4f23b75c1815ea58bc
Canonical runtime (unchanged): production-runtime @ b9dd700de428498493fb6e497ec16901684532c0

## Scope performed

1. Enabled operational CLI modes: run --preflight-only (read-only) and run --apply (source-wired; gated; not executed).
2. Created Railway Postgres TCP Proxy (only authorized Railway mutation).
3. Retrieved public Postgres CA/server certificates via Railway SSH (no private keys).
4. Established verify-full TLS using numeric proxy dial IP + tls_server_name=postgres.railway.internal.
5. Ran read-only operational preflight (schema / Owner seat / target admin security).
6. Did not generate real Owner bootstrap key (human witness unavailable).
7. Did not set OWNER_PRODUCTION_BOOTSTRAP_APPLY, run --apply, mutate operational DB, migrate, deploy, or fund.

## Public TLS / endpoint evidence (sanitized)

- TCP proxy id: 31f901a3-dfce-43a8-b127-a61da777193d
- TCP proxy domain: shinkansen.proxy.rlwy.net
- TCP proxy port: 47255
- Dial IP (observed): 66.33.22.231
- TLS server name: postgres.railway.internal
- Root CA SHA256: d570a3aef28179e1b132b241c2b8c971246ce4753eb6eee99350381c9d4b8cf5
- Server cert SHA256: 2e62893528523509373e6f4d99fcf2ce84171472d89ab37cc363950f4b93c94b
- Server SAN: DNS:localhost, DNS:postgres.railway.internal
- Database name: railway
- System identifier: 7690096507315437630
- pg_stat_ssl.ssl: true
- Verify-full: PASS

Dial model: NUMERIC_PROXY_IP_PLUS_PRIVATE_DOMAIN_TLS_SERVER_NAME.
Do not use TCP proxy DNS hostname as URL host with a different tls_server_name.

## Schema / Owner / admin read-only verdict

- Required migrations 0024-0028: PRESENT
- Owner seat: VACANT
- Owner binding history: 0
- Active Owner bindings: 0
- OWNER role: ACTIVE
- Target admin id: a11a11a1-0000-4000-8000-000000000011
- Target admin status: ACTIVE
- Target admin security: CLEAN
- Official --preflight-only refuse code: TRUST_NOT_AUTHENTICATED (expected without witnessed Channel B)

## Pre-keygen go / no-go

- TRUSTED_ENDPOINT_READY=YES
- SCHEMA_READY=YES
- OWNER_SEAT_VACANT=YES
- OWNER_HISTORY_ZERO=YES
- TARGET_ADMIN_ACTIVE=YES
- TARGET_ADMIN_SECURITY_STATE=CLEAN
- HUMAN_WITNESS_READY=NO

STOP before real Owner key generation until an independent human witness is available.

## Outside-repo ceremony materials (not in Git)

Directory: %USERPROFILE%\.lootra-secrets\owner-bootstrap-production\

Contains certs/root.crt, certs/server.crt, production-endpoint-profile.json, intended-existing-admin.json (email omitted).

## Owner keygen (deferred)

When witness is available, Owner runs interactively on a real TTY (passphrase twice; never into chat/env/argv):

powershell:
cd to repo root
pnpm --filter @alex-rewards/auth build
pnpm --filter @alex-rewards/auth owner-production-bootstrap -- generate-keypair --phase21-production-owner-bootstrap --ceremony-dir "$HOME\.lootra-secrets\owner-bootstrap-production" --repo-root (Resolve-Path .)

Require at least 2 encrypted offline backups before future APPLY approval.

## Explicit non-actions

No Owner binding/seat/credentials. No OWNER_PRODUCTION_BOOTSTRAP_APPLY=1. No --apply. No migrations/Hot Wallet/funding/deploy/payout. production-runtime not moved.

## TCP proxy exposure

TCP Proxy left temporarily active for pending Owner APPLY approval after successful verify-full. If blocked long-term, delete proxy to restore private-only networking.
