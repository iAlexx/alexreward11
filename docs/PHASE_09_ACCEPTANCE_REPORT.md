# Phase 9 Acceptance Report — TON Testnet Signer Spike

**Status:** CANDIDATE RUNTIME — ordinary CI **PASS**; formal KMS gate **BLOCKED** (GitHub secrets empty). Not accepted until real `ECC_NIST_EDWARDS25519` spike evidence.

**Date:** 2026-09-10

**Authority:** `docs/ALEx_Rewards_Master_Product_Financial_Security_Engineering_Specification_v1.2.md`

**Start tip:** `a6ff87dd6511a568508401bdd890b640301120a0`

**Phase 8 accepted runtime (closed):** `a7554474b8b5ee22a3323a221d00bb1714d88ff7`

**Phase 9 candidate tip (not accepted until KMS evidence):** `7d8cb06e18f319271750d9378dc7cb5a5a9f8178`

**Ordinary CI:** https://github.com/iAlexx/alexreward11/actions/runs/34422715453 — quality `102701408253` **PASS**; docker-smoke `102702545301` **PASS**

**KMS spike dispatch (FAILED — secrets missing):** https://github.com/iAlexx/alexreward11/actions/runs/34422797023

---

## A. Phase objective

Build and validate the separate `apps/signer` security boundary and AWS KMS / TON Wallet V5 R1 compatibility spike. Prove the signing boundary — not Phase 10 payout broadcast.

## B. Exact scope delivered

- Migration `0020_signer_read_boundary.sql` (view + RO role + payout_jetton_wallet_address)
- Package `@alex-rewards/signing` (policy, Wallet V5 R1, canonical Jetton message, local ephemeral port)
- `apps/signer` KMS adapter + `POST /v1/sign-withdrawal-attempt` (attempt id only)
- Boundaries / CI `test:phase9` / `pnpm spike:kms`
- Docs: `docs/TON_SIGNER.md`

## C. Files/modules changed

Primary: `migrations/0020_*`, `packages/signing/**`, `apps/signer/**`, `packages/config`, `scripts/verify-boundaries.mjs`, CI, root scripts.

Migrations `0001`–`0019`: unchanged.

## D. Migration(s)

`0020_signer_read_boundary.sql`

## E. Commands executed

```bash
pnpm install
pnpm validate:migrations
pnpm test:phase9
pnpm spike:kms   # requires real AWS; currently blocked in this environment
```

## F. Test evidence

Ordinary Phase 9 suites against local Postgres (`PHASE9_DATABASE_URL`):

| Suite                      | Focus                                                     |
| -------------------------- | --------------------------------------------------------- |
| `phase9-migration`         | 0020 / view / RO role                                     |
| `phase9-wallet-v5r1`       | TESTNET derive; MAINNET reject                            |
| `phase9-canonical-message` | 100× identical hash; field mutation                       |
| `phase9-policy`            | fake-hash / MAINNET / HELD / native reject                |
| `phase9-sign-flow`         | production-shaped attempt + local sign + 100× reconstruct |
| `phase9-db-readonly`       | SELECT view PASS; INSERT/UPDATE DENIED                    |
| `phase9-boundary`          | no KMS/broadcast in `@alex-rewards/signing`               |
| `phase9-kms-local`         | ephemeral crypto only (not formal evidence)               |

Latest local run: **14/14 PASS** (includes 3 production-shaped sign-flow tests).

## G. Real KMS compatibility evidence

**KMS compatibility: BLOCKED — REAL KMS SPIKE ENVIRONMENT UNAVAILABLE**

Observed at seal attempt time (local + GitHub Actions):

- Local: `AWS_ACCESS_KEY_ID` / `AWS_PROFILE` / `SIGNER_KMS_KEY_ARN` / `SIGNER_AWS_REGION` unset; no `~/.aws`; no `aws` CLI
- GitHub Actions run `34422797023` on tip `7d8cb06…`: step **Require spike secrets** saw empty `SIGNER_AWS_REGION`, `SIGNER_KMS_KEY_ARN`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` → exit 2

`pnpm spike:kms` / workflow both report:
`PHASE 9 BLOCKED — REAL KMS SPIKE ENVIRONMENT UNAVAILABLE`

Owner unblock path:

1. Create repo secrets: `SIGNER_AWS_REGION`, `SIGNER_KMS_KEY_ARN`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (optional `AWS_SESSION_TOKEN`).
2. Key must be AWS KMS `ECC_NIST_EDWARDS25519` (Testnet signer spike only).
3. Re-dispatch `.github/workflows/phase9-kms-spike.yaml` with `commit_sha=7d8cb06e18f319271750d9378dc7cb5a5a9f8178` (or later CI-green tip).
4. Or run locally with the same env vars.

Local/`local_ephemeral` adapters are **not** formal evidence.

## H. CI

- Run URL: https://github.com/iAlexx/alexreward11/actions/runs/34422715453
- quality job `102701408253`: **PASS** (includes Phase 9 TON signer spike gates + audit)
- docker-smoke job `102702545301`: **PASS**
- Tip: `7d8cb06e18f319271750d9378dc7cb5a5a9f8178`

## I. Known deviations

None vs Phase 9 scope, except formal KMS evidence is **blocked** pending Owner AWS access (per §12 of Owner Phase 9 brief — STOP, do not mock).

## J. §34.2 split (mandatory)

**Completed in Phase 9 (when real spike runs / already in code path):**

1. create/use test KMS Ed25519 key (Owner provisions; helper `pnpm provision:kms-spike-key`)
2. retrieve public key
3. derive Wallet V5 R1 state/address (TESTNET `-3`)
4. build signed external / signable Cell hash bytes
5. call KMS signing correctly (`ED25519_SHA_512` + `MessageType RAW`)
6. verify signature locally

**Explicitly deferred to Phase 10:**

7. broadcast Testnet transaction
8. confirm wallet accepts
   9–14. repeat / seqno / crash-before-persist / crash-after-broadcast / reconcile / Jetton confirmation program

## K. Security invariants held

- Only `apps/signer` imports AWS KMS SDK
- Caller input = `withdrawalAttemptId` only
- Signer RO DB role cannot mutate financial tables
- No TON RPC / `sendBoc` / broadcast in signer boundary
- Phase 7 `fake-hash:*` rejected
- MAINNET global id `-239` rejected
- No private key/seed/mnemonic columns or archives

## L. Archive status

**Not sealed.** Dual archive under `phase-archives/PHASE_09_TON_TESTNET_SIGNER_SPIKE/` waits for formal KMS PASS on the accepted SHA.

## M. Candidate vs companion tips

| Role                                    | SHA                                        |
| --------------------------------------- | ------------------------------------------ |
| Candidate runtime (CI green; await KMS) | `7d8cb06e18f319271750d9378dc7cb5a5a9f8178` |
| Docs companion (this report)            | current `main` tip after this commit       |

Do not treat companion docs tips as the accepted runtime.

## N. Owner action required (unblock seal)

Provide either:

**A. GitHub Actions secrets** on `iAlexx/alexreward11`:

- `SIGNER_AWS_REGION`
- `SIGNER_KMS_KEY_ARN` (existing `ECC_NIST_EDWARDS25519` TEST/SPIKE key, or create via `pnpm provision:kms-spike-key` with AWS creds)
- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (optional `AWS_SESSION_TOKEN`)

Then re-dispatch workflow **Phase 9 KMS Spike** with
`commit_sha=7d8cb06e18f319271750d9378dc7cb5a5a9f8178`.

**B. Local AWS credentials** in this environment with the same env vars, then
`pnpm spike:kms` (and optionally `pnpm provision:kms-spike-key` first).

## O. STOP packet

```text
PHASE 9 BLOCKED — REAL KMS SPIKE ENVIRONMENT UNAVAILABLE
Candidate tip (ordinary CI PASS): 7d8cb06e18f319271750d9378dc7cb5a5a9f8178
Ordinary CI: https://github.com/iAlexx/alexreward11/actions/runs/34422715453
KMS dispatch (secrets empty): https://github.com/iAlexx/alexreward11/actions/runs/34422797023
Phase 8 accepted runtime remains closed: a7554474b8b5ee22a3323a221d00bb1714d88ff7
No Phase 10 / Mainnet work started.
Awaiting Owner AWS KMS ECC_NIST_EDWARDS25519 spike credentials.
```

**No Phase 10 work started.**
