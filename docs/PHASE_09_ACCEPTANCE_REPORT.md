# Phase 9 Acceptance Report — TON Testnet Signer Spike (Owner custody amendment)

**Status:** **ACCEPTED** — Owner-selected production custody = `apps/signer` + **SELF-HOSTED ENCRYPTED Ed25519** (`FALLBACK_ENCRYPTED`). **No Phase 10 started.**

**Date:** 2026-09-10

**Authority:** `docs/ALEx_Rewards_Master_Product_Financial_Security_Engineering_Specification_v1.3.md` (supersedes conflicting v1.2 AWS production-custody language; does not silently erase security requirements)

| Item                                         | Decision                                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| AWS KMS Ed25519 compatibility                | **TECHNICALLY PROVEN** (historical evidence — section G)                                                            |
| AWS as production Hot Wallet signing custody | **OWNER REJECTED** (ops / vendor risk after account suspension)                                                     |
| Selected production custody                  | **`apps/signer` + SELF-HOSTED ENCRYPTED (`FALLBACK_ENCRYPTED`)**                                                    |
| Signer-custody DB migration                  | **No signer-custody migration required** (`FALLBACK_ENCRYPTED` already in enum; migration `0020` preserved exactly) |
| Phase 10                                     | **Not started**                                                                                                     |

**Phase 8 accepted runtime (closed):** `a7554474b8b5ee22a3323a221d00bb1714d88ff7`

**Historical AWS-era sealed tip (SUPERSEDED package):** `973e6974a0e8ee7a5465bcf5514352b1351ece0c` — marked `SUPERSEDED — AWS signer candidate, not Owner-approved production architecture` under `phase-archives/PHASE_09_TON_TESTNET_SIGNER_SPIKE_AWS_SUPERSEDED_973e697/`.

**Phase 9 accepted runtime SHA (self-hosted amendment):** _filled after commit + CI PASS_

**CI:** _filled after push_

---

## A. Phase objective

Prove the separate `apps/signer` trust boundary with **self-hosted encrypted** Hot Wallet custody on TESTNET Wallet V5 R1 — **not** Phase 10 broadcast.

## B. Scope delivered (Owner-approved)

- Migration `0020_signer_read_boundary.sql` preserved (no custody migration)
- `@alex-rewards/signing`: policy, Wallet V5 R1, canonical Jetton message, `EncryptedLocalSigningProvider`, Argon2id + XChaCha20-Poly1305 key bundle
- `apps/signer`: attempt-id-only sign API; boot **LOCKED**; loopback local unlock/relock; no public unlock; no plaintext key/passphrase env
- Provider-neutral `SignPort` / `LockableSignPort` (AWS runtime removed)
- Operator keygen CLI (`apps/signer` `keygen`) — offline, never prints seed
- Docs / `.env.example` / Master Spec **v1.3** / CI boundaries forbidding AWS KMS + plaintext signer secrets
- Phase 9 amendment tests: bundle, lock state, identity, signing, boundary, secret absence

## C. Migrations

**No signer-custody migration required.**

`0001`–`0020` unchanged in place. `FALLBACK_ENCRYPTED` already exists from baseline enum.

## D. Local verification (amendment)

```text
pnpm verify:local                          PASS
pnpm test:phase2 .. test:phase9            PASS (phase9: 9 files / 30 tests)
pnpm security:audit                        PASS (no known high+)
pnpm smoke                                 PASS
```

Phase 9 suites include `phase9-encrypted-custody` (generate/encrypt/decrypt, tamper fail-closed, LOCKED boot, unlock/relock, identity/network mismatch, MAINNET reject) plus preserved policy/sign-flow/RO DB/boundary suites.

## E. Failure semantics (pre-broadcast)

`SIGNER_LOCKED`, `KEY_BUNDLE_MISSING`, `KEY_BUNDLE_INVALID`, `KEY_DECRYPT_FAILED`, `KEY_IDENTITY_MISMATCH`, `SIGNATURE_VERIFY_FAILED` are **never** interpreted as `BROADCASTED` / `CONFIRMED` / `PAID`. Signer does not release Reserved funds.

## F. Historical AWS evidence (NON-AUTHORITATIVE)

**AWS KMS Ed25519 compatibility: TECHNICALLY PROVEN** with `ECC_NIST_EDWARDS25519` / `ED25519_SHA_512` / `MessageType=RAW`. Safe metadata only:

```json
{
  "ok": true,
  "region": "eu-central-1",
  "keySpec": "ECC_NIST_EDWARDS25519",
  "keyUsage": "SIGN_VERIFY",
  "signingAlgorithm": "ED25519_SHA_512",
  "messageType": "RAW",
  "localSignatureVerification": "PASS",
  "repeatability": "PASS",
  "alteredMessageRejects": "PASS",
  "note": "Historical engineering evidence only. AWS production custody OWNER REJECTED."
}
```

## G. Security invariants held

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

## H. Archive

1. Historical AWS dual package: **preserved**, directory renamed to `PHASE_09_TON_TESTNET_SIGNER_SPIKE_AWS_SUPERSEDED_973e697` with `SUPERSEDED.md`.
2. Final Owner-selected dual package: created under `phase-archives/PHASE_09_TON_TESTNET_SIGNER_SPIKE/` after CI PASS on accepted runtime SHA (via `pnpm archive:phase`).

## I. STOP packet

```text
PHASE 9 OWNER AMENDMENT — SELF-HOSTED ENCRYPTED CUSTODY SELECTED
Master Spec: docs/ALEx_Rewards_Master_Product_Financial_Security_Engineering_Specification_v1.3.md
AWS KMS Ed25519: TECHNICALLY PROVEN (historical, non-authoritative)
AWS production custody: OWNER REJECTED
Selected signer: apps/signer + FALLBACK_ENCRYPTED (encrypted-at-rest; unlock in-memory only)
No AWS runtime dependency; no plaintext key persisted
No signer-custody migration required (0020 preserved)
No Phase 10 / Mainnet work started.
STOP AND WAIT FOR OWNER APPROVAL.
```

**No Phase 10 work started.**
