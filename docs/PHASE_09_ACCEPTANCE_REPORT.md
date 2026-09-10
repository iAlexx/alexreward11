# Phase 9 Acceptance Report — TON Testnet Signer Spike

**Status:** CANDIDATE RUNTIME pushed — ordinary CI pending; formal KMS gate **BLOCKED** until real AWS ECC_NIST_EDWARDS25519 spike evidence exists on the accepted SHA.

**Date:** 2026-09-10

**Authority:** `docs/ALEx_Rewards_Master_Product_Financial_Security_Engineering_Specification_v1.2.md`

**Start tip:** `a6ff87dd6511a568508401bdd890b640301120a0`

**Phase 8 accepted runtime (closed):** `a7554474b8b5ee22a3323a221d00bb1714d88ff7`

**Phase 9 candidate tip (not accepted until KMS evidence):** `61db6ac9904b4f6b24e8cafcb5f559b020ce02a7`

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

Observed at seal attempt time:

- `AWS_ACCESS_KEY_ID` unset
- `AWS_PROFILE` unset
- `SIGNER_KMS_KEY_ARN` unset
- `SIGNER_AWS_REGION` unset
- no `~/.aws/credentials`
- `aws` CLI not installed

`pnpm spike:kms` exits 2 with:
`PHASE 9 BLOCKED — REAL KMS SPIKE ENVIRONMENT UNAVAILABLE`

Owner unblock path:

1. Configure GitHub Actions secrets (`SIGNER_AWS_REGION`, `SIGNER_KMS_KEY_ARN`, AWS keys).
2. Dispatch workflow `.github/workflows/phase9-kms-spike.yaml` against the Phase 9 candidate SHA.
3. Or run locally with the same env vars.

Local/`local_ephemeral` adapters are **not** formal evidence.

## H–O

Pending formal acceptance after ordinary CI green **and** real KMS spike PASS on the same accepted SHA.

**No Phase 10 work started.**
