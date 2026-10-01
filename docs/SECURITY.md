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

## Phase 11 — advertising trust boundary

- **AdsGram production monetary issuance is BLOCKED** (`production_monetary_status = BLOCKED`,
  six OPEN clarification items). Unblocking is an Owner-reviewed data change, not a code change.
- Client evidence is **never** money. A client completion is a signal; it cannot advance a session
  past `CLIENT_COMPLETED` and cannot raise a balance.
- Session state is **derived** from append-only `ad_session_signals` and then persisted. Clients
  never assign state, and signals are never mutated or deleted.
- `v1/ads/*` requires an active Phase 3 session; the ad session id is a path locator only and
  every request is re-checked against the authenticated user. Requests carrying reward-authority
  fields (amount, bonus, verification, ledger ids) are refused `400` before any domain call.
- `GET /webhooks/adsgram/reward` is unauthenticated by provider design. It returns one uniform
  `{ accepted: true, rewardCredited: false }` body for every outcome so it cannot be used as an
  oracle, is throttled through Redis, and **fails closed** when the throttle store is unavailable.
- Providers are fixed at build time in a compile-time registry; nothing is loaded dynamically.
- The monetary gate is provider-neutral and reads only data — no provider name is branched on.
- `packages/ads` must never import `@alex-rewards/ledger` or post a ledger transaction; issuance
  goes through `issueAdReward` in the Reward Engine, asserted against source on disk.
- No production debug or fake-completion endpoint exists. The only provider that passes the gate
  in tests (`HARNESS_CERT`) lives in the test harness and is never seeded or shipped.

See `docs/ADS_SPEC.md` and `docs/ADSGRAM_CLARIFICATION_REGISTER.md`.

## Phase 13 — Owner Admin control plane

- Admin auth is **independent** of Telegram Mini App sessions (`AdminSessionGuard` refuses
  Telegram-shaped JWTs).
- **Primary:** WebAuthn/passkey (typed challenges: unpredictable, expiring, one-time; RP ID /
  origin fail closed when unset outside local/test). Production RP ID remains
  `OWNER_DECISION_REQUIRED`.
- **Fallback:** password **and** TOTP together. Password-only and TOTP-only are refused.
- **Recovery:** single-use hashed recovery codes; plaintext shown once; never logged.
- Sessions support idle/absolute timeout, revocation, rotation, and recent-reauth for
  high-impact mutations. Second-confirmation tokens bind action/resource/version/payload.
- V1 RBAC: only **OWNER** is enabled server-side; client role claims are not authority.
- Audit mutations append to append-only `audit_logs` with secrets redacted.
- Admin browser never receives signer keys, mnemonics, provider API secrets, password hashes,
  TOTP seeds after enrollment, raw recovery codes after generation, or DB credentials.
- No direct balance editor; no Admin path that posts ledger entries outside approved domain
  commands; Policy Center refuses arbitrary JS/SQL/eval; provider hard limits cannot be
  exceeded; AdsGram monetary APPROVED refused while clarification gate is open;
  `PAYOUT_DISPATCH_PAUSE` is not silently flipped.

See `docs/OWNER_ADMIN_AUTH.md`, `docs/ADMIN_POLICY_CENTER.md`, ADR-023.

## Phase 19 — Pre-Mainnet security review

Phase 19 is **IN_PROGRESS** (Step 1 discovery). `PHASE19_GATE=HOLD`.

Authoritative review artifacts:

- `docs/PHASE_19_SECURITY_REVIEW_PLAN.md`
- `docs/PHASE_19_SECURITY_FINDINGS.md`
- `docs/PHASE_19_ATTACK_SURFACE.md`

Verified-from-code statements for Phase 19 Step 1 (not aspirational):

- Founder claim **consume** stores hash only, is single-use under row lock, uses session `userId` authority, and issues zero ledger money.
- Admin Founder **grant** requires CSRF + recent reauth + consumed confirmation with target binding; reassignment is unavailable.
- Admin claim-code **issue** currently uses CSRF + recent reauth (`gateHighImpactMutation`) but does **not** consume a second confirmation (`P19-SEC-001` OPEN).
- AdsGram production monetary remains **BLOCKED**; client completion and AdsGram webhook do not issue money.
- Policy Center refuses arbitrary code and returns `applied=false` for REWARD_RULES / PROVIDER_LIMITS; FEATURE_FLAGS via Policy Center is **not** equivalent to dedicated Feature Flags security (`P19-SEC-009` OPEN).
- Review Queue is not financial source of truth; Admin `RESOLVE_AFTER_DOMAIN` currently hardcodes `domainSucceeded: true` without server domain evidence (`P19-SEC-017` OPEN).

Mainnet / production monetary / AdsGram monetary / payout resume remain unauthorized by Phase 19 Step 1.
