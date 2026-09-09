# ALEx Rewards Phase 6 Acceptance Report — TON Connect Wallet Ownership

Status: **PASS** — Wallet ownership via TON Connect + `ton_proof` implemented. No money
movement. Phase 5 remains closed. Phase 7 has **not** started.

Date: 2026-09-09

Source of truth: ALEx Rewards Master Product, Financial, Security & Engineering Specification **v1.2**.

| Item                     | Value                                                              |
| ------------------------ | ------------------------------------------------------------------ |
| Phase 6 start tip        | `a22994c46202eba44ad41451cda6d4d9c8c16fb8` (Phase 5 archive evidence only) |
| Accepted Phase 6 commit  | `79fbf90b0d07ad786ee616ad1c7e51b7f1004d3c`                           |
| GitHub Actions run       | https://github.com/iAlexx/alexreward11/actions/runs/34302244318    |
| `quality`                | PASS — job `102311430003`                                          |
| `docker-smoke`           | PASS — job `102312181043`                                          |
| New migration            | `0016_wallet_proof_nonce_lifecycle.sql`                            |
| Migrations `0001`–`0015` | **unchanged**                                                      |

## Scope delivered

1. CSPRNG challenge; hashed nonce; short TTL; single-use; replay prevention.
2. Official ton_proof message construction + real Ed25519 verification (`@ton/crypto`).
3. Domain / timestamp skew / StateInit pubkey / address binding; fail closed on unknown wallets.
4. Authoritative `networks` acceptance (`TON` + ACTIVE + environment + global_chain_identifier).
5. Canonical raw/friendly address storage; duplicate encoding → one logical wallet.
6. Verified wallet upsert (`verification_method = TON_PROOF`); first primary without cooldown.
7. Primary change A→B with fresh proof; 24h withdrawal cooldown; open challenge invalidation.
8. `PRIMARY_WALLET_CHANGED` audit + transactional outbox; Founder cannot bypass.
9. Authenticated throttling hooks (Redis assist only; never ownership authority).

## Explicit non-goals (not started)

Withdrawal quotes, Available→Reserved, fees/limits/approvals, Temporal payout, Jetton transfer,
signer/KMS, Hot Wallet, chain reconciliation, Phase 7+.

## Tests

| Suite                                         | Count  |
| --------------------------------------------- | ------ |
| `@alex-rewards/ton` crypto / canonicalization | **15** |
| Phase 6 ton_proof DB matrix                   | **19** |
| Phase 6 wallet lifecycle                      | **11** |
| Phase 6 concurrency / replay                   | **5**  |
| **Phase 6 DB total (`pnpm test:phase6`)**     | **35** |
| Phase 2                                       | 27     |
| Phase 3                                       | 21     |
| Phase 4                                       | 41     |
| Phase 5                                       | 55     |

ton_proof related (unit + DB matrix): **34**. Wallet lifecycle: **11**. Concurrency/replay suite: **5**.

## O. Archive verification

Section O is included **before** final packaging. Outer review-package SHA256 is recorded only in
external `PACKAGE_SHA256.txt` (not embedded here — self-reference is impossible).

| Item                                | Result |
| ----------------------------------- | ------ |
| Canonical source ZIP                | `ALEx_Rewards_PHASE_06_TON_WALLET_OWNERSHIP_20260909-051900_79fbf90.zip` |
| Canonical source SHA256             | `d8fc5c630ef42c86b057bb4a4857a3a3618c601e2f5256ea3443856a5a59d4bf` |
| Final review-package ZIP            | `PHASE_06_TON_WALLET_OWNERSHIP_PACKAGE_20260909-051900_79fbf90.zip` |
| Source extraction                   | PASS |
| Source prohibited-path scan         | PASS |
| Review-package extraction           | PASS |
| Review-package prohibited-path scan | PASS |
| Nested canonical source validation  | PASS |
| Forward-slash ZIP entry validation  | PASS |
| Exact accepted commit               | `79fbf90b0d07ad786ee616ad1c7e51b7f1004d3c` |
| External `PACKAGE_SHA256.txt`       | Authoritative outer hash beside the package |

Verified with `scripts/create-phase-archive.mjs` v2.1.0 (stamp `20260909-051900`).

**No Phase 7 work started.**
