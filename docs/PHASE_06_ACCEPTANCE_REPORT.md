# ALEx Rewards Phase 6 Acceptance Report — TON Connect Wallet Ownership

Status: **PASS (pending CI + archive seal)** — Wallet ownership via TON Connect + `ton_proof`
implemented. No money movement. Phase 5 remains closed. Phase 7 has **not** started.

Date: 2026-09-09

Source of truth: ALEx Rewards Master Product, Financial, Security & Engineering Specification **v1.2**.

| Item                     | Value                                                                      |
| ------------------------ | -------------------------------------------------------------------------- |
| Phase 6 start tip        | `a22994c46202eba44ad41451cda6d4d9c8c16fb8` (Phase 5 archive evidence only) |
| Accepted Phase 6 commit  | _(filled after commit)_                                                    |
| GitHub Actions run       | _(filled after CI)_                                                        |
| `quality`                | _(filled after CI)_                                                        |
| `docker-smoke`           | _(filled after CI)_                                                        |
| New migration            | `0016_wallet_proof_nonce_lifecycle.sql`                                    |
| Migrations `0001`–`0015` | **unchanged**                                                              |

## Scope delivered

1. CSPRNG challenge; hashed nonce; short TTL; single-use; replay prevention.
2. Official ton_proof message construction + real Ed25519 verification.
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
| Phase 6 concurrency / replay                  | **5**  |
| **Phase 6 DB total (`pnpm test:phase6`)**     | **35** |
| Phase 2                                       | 27     |
| Phase 3                                       | 21     |
| Phase 4                                       | 41     |
| Phase 5                                       | 55     |

ton_proof related (unit + DB matrix): **34**. Wallet lifecycle: **11**. Concurrency/replay suite: **5**.

## O. Archive verification

_Filled after dual packaging — Section O must exist before final package seal._

| Item                                | Result      |
| ----------------------------------- | ----------- |
| Canonical source ZIP                | _(pending)_ |
| Canonical source SHA256             | _(pending)_ |
| Final review-package ZIP            | _(pending)_ |
| Source extraction                   | _(pending)_ |
| Source prohibited-path scan         | _(pending)_ |
| Review-package extraction           | _(pending)_ |
| Review-package prohibited-path scan | _(pending)_ |
| Nested canonical source validation  | _(pending)_ |
| Forward-slash ZIP entry validation  | _(pending)_ |
| Exact accepted commit               | _(pending)_ |
| External `PACKAGE_SHA256.txt`       | _(pending)_ |

**No Phase 7 work started.**
