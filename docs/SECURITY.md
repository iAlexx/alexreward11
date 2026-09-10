# Security foundation

- All configuration is validated before a process starts.
- Production-like environments reject loopback service endpoints and known local-only tokens.
- Secrets are never returned by health endpoints or passed to frontend applications.
- Logs redact common credential, token, cookie, authorization, and key fields.
- The Signer package boundary is checked automatically; `@aws-sdk/client-kms` anywhere in product apps/packages fails CI.
- Repository secret-pattern scanning and high-severity dependency auditing run in CI.
- Docker image and GitHub Action versions are immutable or exact.

Application authentication and financial authorization controls belong to their approved later
phases; Phase 1 contains no pretend authentication or financial endpoints.

## Phase 6 — TON wallet ownership

- Wallet challenge/verify requires a valid Phase 3 application session. Client `userId` is never ownership authority.
- `ton_proof` expected domain is server-configured; Host / Origin / Telegram URL are not cryptographic domain authority.
- Challenges use CSPRNG entropy; only a hash is stored; raw nonce is never logged or audited.
- Network acceptance is separate from `ton_proof` crypto and comes from authoritative `networks` rows.
- Unknown wallet StateInit codes fail closed (`INVALID_WALLET`).
- Primary wallet change requires a fresh proof, emits `PRIMARY_WALLET_CHANGED` audit evidence, invalidates open challenges, and starts a fixed **24-hour** withdrawal cooldown for all membership tiers.
- Redis may throttle abuse but never authorizes wallet ownership.
- Private keys, seeds, and mnemonics are never accepted or stored.

See `docs/WALLETS.md`.

## Phase 7 — payout ambiguity / fake-chain trust boundary

- Possible or unknown broadcast **never** returns Reserved → Available and **never** blindly
  retries or resends. Ambiguity → `RECONCILE_REQUIRED` (or reconcile-origin `HELD`) with
  Reserved preserved until durable reconciliation evidence exists.
- `withdrawal_payout_reconciliations` is append-only; reject-from-reconcile requires
  `DEFINITIVE_NONPAYMENT` evidence (plus explicit Owner decision).
- `FakePayoutChain` is LOCAL/TEST (and local-like DEV) only. Staging/production config that
  enables the fake chain **fails closed**. Clients cannot choose fake payout outcomes.
- Phase 7 introduces **no** real signer, KMS, mnemonic, or TON broadcast path. Dispatch fencing
  tokens on hot-wallet leases prevent stale workers from broadcasting (even on the fake adapter).
- Fee/priority membership entitlements are reconstructable from frozen quote/withdrawal
  provenance; Founder status alone grants no financial bypass.

See `docs/WITHDRAWALS.md`.

## Phase 8 — Control Center / Owner action tokens

- Telegram group membership is **not** authorization. Owner allowlist + ACTIVE admin + OWNER
  binding + named permission + destination chat/topic + one-time action token are all required.
- Callback `callback_data` carries only an opaque action secret (≤64 bytes). Financial fields are
  never trusted from Telegram.
- Action tokens store `sha256(action:{raw})` only; raw secrets are never audited or published.
- Founder Owner grant / claim-code issue are zero-ledger; reassignment mutation is unavailable.
- `apps/bot` and `@alex-rewards/control-center` must not import KMS or TON sign paths; control-center
  must not import `@alex-rewards/ledger`.

See `docs/CONTROL_CENTER.md` and `docs/REVIEW_QUEUE.md`.

## Phase 9 — TON Testnet signer (self-hosted encrypted)

- Production Hot Wallet custody target: `apps/signer` + **SELF-HOSTED ENCRYPTED Ed25519 (`FALLBACK_ENCRYPTED`)**.
- AWS KMS Ed25519 compatibility is **historically PROVEN**; AWS as production custody is **OWNER REJECTED**.
- **No signer-custody migration required** (`FALLBACK_ENCRYPTED` enum + migration `0020` preserved).
- Product apps/packages must not depend on or import `@aws-sdk/client-kms`.
- Caller input is only `withdrawalAttemptId`; signer reconstructs canonical Wallet V5 R1 intent.
- Signer DB role is read-only (`alex_rewards_signer_ro`); no financial writes.
- Key material: Argon2id + XChaCha20-Poly1305 encrypted bundle at rest; unlock only in signer memory (loopback local unlock); plaintext `SIGNER_PRIVATE_KEY` / `SEED` / `MNEMONIC` / `KEY_PASSPHRASE` env forbidden.
- No TON RPC/broadcast from signer (Phase 10).
- `local_ephemeral` mode is local/test only and does **not** satisfy the production self-hosted gate.

See `docs/TON_SIGNER.md`.
