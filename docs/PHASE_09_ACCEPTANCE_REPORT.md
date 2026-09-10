# Phase 9 Acceptance Report — TON Testnet Signer Spike (Owner custody amendment)

**Status:** **ACCEPTED** — Owner-selected production custody = `apps/signer` + **SELF-HOSTED ENCRYPTED Ed25519** (`FALLBACK_ENCRYPTED`). **No Phase 10 started.**

**Date:** 2026-09-10

**Authority:** `docs/ALEx_Rewards_Master_Product_Financial_Security_Engineering_Specification_v1.3.md` (supersedes conflicting v1.2 AWS production-custody language; does not silently erase security requirements)

| Item                                         | Decision                                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| AWS KMS Ed25519 compatibility                | **TECHNICALLY PROVEN** (historical evidence — section F)                                                            |
| AWS as production Hot Wallet signing custody | **OWNER REJECTED** (ops / vendor risk after account suspension)                                                     |
| Selected production custody                  | **`apps/signer` + SELF-HOSTED ENCRYPTED (`FALLBACK_ENCRYPTED`)**                                                    |
| Signer-custody DB migration                  | **No signer-custody migration required** (`FALLBACK_ENCRYPTED` already in enum; migration `0020` preserved exactly) |
| Phase 10                                     | **Not started**                                                                                                     |

**Phase 8 accepted runtime (closed):** `a7554474b8b5ee22a3323a221d00bb1714d88ff7`

**Historical AWS-era sealed tip (SUPERSEDED package):** `973e6974a0e8ee7a5465bcf5514352b1351ece0c` — marked `SUPERSEDED — AWS signer candidate, not Owner-approved production architecture` under `phase-archives/PHASE_09_TON_TESTNET_SIGNER_SPIKE_AWS_SUPERSEDED_973e697/`.

**Phase 9 accepted runtime SHA (self-hosted amendment):** `06ed3d414f70c60abbff960d7ecfbb2e2fd8f8f4`

**Prior candidate (superseded by final security corrections):** `dc20d197796623aac2ce0611139e8606eb333f9b`

**CI:** https://github.com/iAlexx/alexreward11/actions/runs/34516299249 — quality `103002438246` **PASS**; docker-smoke `103004116509` **PASS** (no AWS secrets/jobs required)

### Final security corrections (pre-Owner approval)

1. **Fail-closed unlock:** any failed `EncryptedLocalSigningProvider.unlock()` leaves `custodyState=LOCKED`, `signingReady=false`, and destroys any previously unlocked key material (including after a prior successful unlock).
2. **Bounded Argon2id v1 params:** `assertArgon2idParamsV1` validates finite integers and approved bounds for `memory` / `passes` / `parallelism` / `dkLen` **before** Argon2id; `dkLen` must equal XChaCha20-Poly1305 key length (32). Tampered KDF metadata cannot request unreasonable CPU/RAM.

---

## A. Phase objective

Prove the separate `apps/signer` trust boundary with **self-hosted encrypted** Hot Wallet custody on TESTNET Wallet V5 R1 — **not** Phase 10 broadcast.

## B. Exact scope delivered

- Migration `0020_signer_read_boundary.sql` preserved (no custody migration)
- `@alex-rewards/signing`: policy, Wallet V5 R1, canonical Jetton message, `EncryptedLocalSigningProvider`, Argon2id + XChaCha20-Poly1305 key bundle
- `apps/signer`: attempt-id-only sign API; boot **LOCKED**; loopback local unlock/relock; no public unlock; no plaintext key/passphrase env
- Provider-neutral `SignPort` / `LockableSignPort` (AWS runtime removed)
- Operator keygen CLI (`apps/signer` `keygen`) — offline, never prints seed
- Docs / `.env.example` / Master Spec **v1.3** / CI boundaries forbidding AWS KMS + plaintext signer secrets
- Phase 9 amendment tests: bundle, lock state, identity, signing, boundary, secret absence, fail-closed unlock, Argon2id bounds

## C. Files/modules changed (high level)

Primary: `packages/signing/**`, `apps/signer/**`, `packages/config`, `scripts/verify-boundaries.mjs`, docs, `.env.example`. AWS KMS adapter/helpers/workflow removed from product tree. Migrations `0001`–`0020` not mutated.

## D. Database migrations

**No signer-custody migration required.**

`0001`–`0020` unchanged in place. `FALLBACK_ENCRYPTED` already exists from baseline enum. Migration `0020_signer_read_boundary.sql` preserved exactly.

## E. Commands executed (local)

```text
pnpm verify:local
pnpm test:phase2 … pnpm test:phase9
pnpm security:audit
pnpm smoke
```

## F. Test evidence

Final dedicated Phase 9 gate (`pnpm test:phase9`):

| Suite                      | Focus                                                               |
| -------------------------- | ------------------------------------------------------------------- |
| `phase9-migration`         | 0020 / view / RO role                                               |
| `phase9-wallet-v5r1`       | TESTNET derive; MAINNET reject                                      |
| `phase9-canonical-message` | 100× identical hash; field mutation                                 |
| `phase9-policy`            | fake-hash / MAINNET / HELD / native / non-FALLBACK_ENCRYPTED reject |
| `phase9-sign-flow`         | production-shaped attempt + local sign + 100× reconstruct           |
| `phase9-db-readonly`       | SELECT view PASS; INSERT/UPDATE DENIED                              |
| `phase9-boundary`          | no broadcast; no AWS KMS; only signer wires encrypted provider      |
| `phase9-kms-local`         | ephemeral crypto only (historical naming; not formal AWS evidence)  |
| `phase9-encrypted-custody` | bundle AEAD, fail-closed unlock, Argon2id v1 bounds                 |

**Final dedicated Phase 9 evidence: 9 files / 35 tests PASS** (CI run `34516299249`).

Historical note (non-authoritative): an earlier self-hosted tip before final security corrections recorded **9 files / 30 tests**; that count does **not** describe the final accepted Phase 9 dedicated gate.

## G. Build/health

- `pnpm verify:local` PASS
- `pnpm security:audit` PASS (no known high+)
- `pnpm smoke` PASS
- Signer health may report alive while LOCKED; signing readiness is false until unlock

## H. CI

- Run URL: https://github.com/iAlexx/alexreward11/actions/runs/34516299249
- quality job `103002438246`: **PASS**
- docker-smoke job `103004116509`: **PASS**
- Tip (accepted runtime): `06ed3d414f70c60abbff960d7ecfbb2e2fd8f8f4`
- No AWS secrets/jobs required for PASS

## I. Known deviations

Owner amended production custody away from AWS after historical KMS PASS (vendor/ops risk). Product tree no longer carries AWS KMS signing adapter or operational AWS signup helpers. Master Spec **v1.3** is normative for custody.

## J. Open blockers / technical debt

None for Phase 9 acceptance. Phase 10 broadcast / chain watcher / confirmation program remain explicitly deferred.

## K. Security / domain invariants

- Separate `apps/signer` trust boundary
- Worker/caller sends only authenticated `withdrawalAttemptId`
- Signer independently validates payout intent; no caller-controlled message/recipient/amount/key
- Signer read-only DB; no financial mutation permission; no public ingress
- No signing capability in API/Bot/Admin/Worker
- No private key in repository/database/frontend/logs; no passphrase in env/Docker/CI/Telegram/Admin
- One withdrawal → one traceable payout attempt hash
- Hot Wallet limited operational reserve; Owner Treasury separate
- Testnet before Mainnet; no TON broadcast in Phase 9
- Unlock does not mutate financial records
- Fail-closed unlock; bounded Argon2id v1 params before KDF
- Pre-broadcast failures (`SIGNER_LOCKED`, `KEY_BUNDLE_*`, `KEY_DECRYPT_FAILED`, `KEY_IDENTITY_MISMATCH`, `SIGNATURE_VERIFY_FAILED`, `MAINNET_REJECTED`) are never `BROADCASTED` / `CONFIRMED` / `PAID`

## L. Rollback / recovery

- Relock signer (best-effort in-memory scrub; JS cannot guarantee perfect zeroization)
- Replace Hot Wallet / encrypted bundle under Owner procedure; dual offline encrypted backups required
- Historical AWS package retained as SUPERSEDED evidence only — not production custody
- See `docs/DISASTER_RECOVERY.md` / `docs/OPERATIONS_RUNBOOK.md` / `docs/TON_SIGNER.md`

## M. Exact accepted SHA

| Role                                     | SHA                                        |
| ---------------------------------------- | ------------------------------------------ |
| Accepted Phase 9 runtime                 | `06ed3d414f70c60abbff960d7ecfbb2e2fd8f8f4` |
| Prior self-hosted candidate (superseded) | `dc20d197796623aac2ce0611139e8606eb333f9b` |
| Historical AWS-era seal (SUPERSEDED pkg) | `973e6974a0e8ee7a5465bcf5514352b1351ece0c` |
| Phase 8 accepted runtime (closed)        | `a7554474b8b5ee22a3323a221d00bb1714d88ff7` |

Docs-only archive-evidence correction commits may follow the accepted runtime tip; they are **not** the accepted runtime.

## N. PASS/FAIL Phase 9 gates

| Gate                                                       | Result |
| ---------------------------------------------------------- | ------ |
| Self-hosted encrypted Ed25519 (`FALLBACK_ENCRYPTED`)       | PASS   |
| Wallet V5 R1 Testnet derivation                            | PASS   |
| Canonical signing / independent withdrawal validation      | PASS   |
| LOCKED / UNLOCKED lifecycle + fail-closed unlock           | PASS   |
| Encrypted-at-rest key custody; no persistent plaintext key | PASS   |
| Bounded Argon2id v1 params before KDF                      | PASS   |
| Signer read-only DB; no signing outside `apps/signer`      | PASS   |
| No AWS production dependency                               | PASS   |
| No TON broadcast in Phase 9                                | PASS   |
| Phase 2–8 regressions                                      | PASS   |
| Phase 9 dedicated gate **9 files / 35 tests**              | PASS   |
| Migrations 0001–0020 unchanged                             | PASS   |
| CI quality + docker-smoke on accepted runtime              | PASS   |
| No Phase 10 started                                        | PASS   |

## O. Archive verification

Section O records packaging verification. The authoritative final **outer** review-package SHA256 is recorded **only** in external `PACKAGE_SHA256.txt` beside the package (not embedded here — embedding an outer archive hash inside that same archive would create a self-reference problem). See `docs/PHASE_ARCHIVE.md`.

| Item                                           | Result                                                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Accepted runtime SHA                           | `06ed3d414f70c60abbff960d7ecfbb2e2fd8f8f4`                                                                               |
| CI run                                         | https://github.com/iAlexx/alexreward11/actions/runs/34516299249                                                          |
| quality job                                    | `103002438246` — PASS                                                                                                    |
| docker-smoke job                               | `103004116509` — PASS                                                                                                    |
| Phase 9 dedicated gate                         | **9 files / 35 tests PASS**                                                                                              |
| Canonical source ZIP                           | `ALEx_Rewards_PHASE_09_TON_TESTNET_SIGNER_SPIKE_20260910-185430_06ed3d4.zip`                                             |
| Canonical source SHA256                        | `60add092bac70bfde172b5a700ece94ff41a1576982bf51b0821661ec836e4bf`                                                       |
| Final review-package ZIP                       | `PHASE_09_TON_TESTNET_SIGNER_SPIKE_PACKAGE_20260910-191200_06ed3d4.zip`                                                  |
| Final review-package path                      | `phase-archives/PHASE_09_TON_TESTNET_SIGNER_SPIKE/PHASE_09_TON_TESTNET_SIGNER_SPIKE_PACKAGE_20260910-191200_06ed3d4.zip` |
| Canonical source extraction                    | PASS                                                                                                                     |
| Canonical source prohibited-path scan          | PASS                                                                                                                     |
| Review-package extraction                      | PASS                                                                                                                     |
| Review-package prohibited-path scan            | PASS                                                                                                                     |
| Nested canonical source identity / integrity   | PASS                                                                                                                     |
| SHA256SUMS verification                        | PASS                                                                                                                     |
| ZIP entry separator / forward-slash validation | PASS                                                                                                                     |
| Exactly four outer members                     | PASS                                                                                                                     |
| External `PACKAGE_SHA256.txt`                  | Authoritative outer hash beside the package (**not** embedded in this report)                                            |
| Migrations 0001–0020 unchanged                 | YES                                                                                                                      |
| No Phase 10 work started                       | YES                                                                                                                      |

Verified with `scripts/create-phase-archive.mjs` v2.1.0 `--from-existing` (outer reseal stamp `20260910-191200`; **canonical source stamp `20260910-185430` and bytes unchanged**).

Historical AWS dual package remains under `phase-archives/PHASE_09_TON_TESTNET_SIGNER_SPIKE_AWS_SUPERSEDED_973e697/` and was not overwritten.

**No Phase 10 work started.**

---

## STOP packet

```text
PHASE 9 ARCHIVE EVIDENCE RESEAL — SELF-HOSTED ENCRYPTED CUSTODY
Master Spec: docs/ALEx_Rewards_Master_Product_Financial_Security_Engineering_Specification_v1.3.md
Accepted runtime SHA: 06ed3d414f70c60abbff960d7ecfbb2e2fd8f8f4
CI: https://github.com/iAlexx/alexreward11/actions/runs/34516299249
quality 103002438246 PASS · docker-smoke 103004116509 PASS
Phase 9 dedicated gate: 9 files / 35 tests PASS
Canonical: ALEx_Rewards_PHASE_09_TON_TESTNET_SIGNER_SPIKE_20260910-185430_06ed3d4.zip
Canonical SHA256: 60add092bac70bfde172b5a700ece94ff41a1576982bf51b0821661ec836e4bf
Outer: PHASE_09_TON_TESTNET_SIGNER_SPIKE_PACKAGE_20260910-191200_06ed3d4.zip
Outer SHA256: see external PACKAGE_SHA256.txt only
No Phase 10 / Mainnet work started.
STOP AND WAIT FOR OWNER APPROVAL.
```
