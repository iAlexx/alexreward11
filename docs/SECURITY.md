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

Phase 19 is **CLOSED / PASS / ARCHIVED**. `PHASE19_GATE=PASS`. Archive slug
`PHASE_19_SECURITY_REVIEW`. Canonical accepted source
`b5110524f90f29dc2a9235aac91ee9de731a03c0`.

`PHASE 19 SECURITY REVIEW = PASS / ARCHIVED`.

OPEN Critical = 0. OPEN High = 0. Residual OPEN Medium/Low/Info findings
(P19-SEC-004, 005, 006, 007, 008, 010, 011, 012) remain visible as accepted residual /
non-Mainnet-blocking carry-forward backlog (not silently closed; not Owner acceptance of
Critical/High). Product + dependency Mainnet blockers
P19-SEC-001/009/014/016/017/018/019/020/021/022/023 are RESOLVED in source.

At Phase 19 archive time, Phase 20 had **not** started. Mainnet / production monetary / AdsGram monetary / payout resume
remain unauthorized. The Phase 19 archive does **not** approve Mainnet or production monetary behavior.

Authoritative review artifacts:

- `docs/PHASE_19_ACCEPTANCE_REPORT.md`
- `docs/PHASE_19_SECURITY_REVIEW_ACCEPTANCE.md` (same content alias)
- `docs/PHASE_19_SECURITY_REVIEW_PLAN.md`
- `docs/PHASE_19_SECURITY_FINDINGS.md`
- `docs/PHASE_19_ATTACK_SURFACE.md`

Verified-from-code statements for Phase 19 (not aspirational):

- Founder claim **consume** stores hash only, is single-use under row lock, uses session `userId` authority, and issues zero ledger money.
- Admin Founder **grant** requires CSRF + recent reauth + consumed confirmation with target binding; reassignment is unavailable.
- Admin claim-code **issue** requires CSRF + recent reauth + consumed confirmation (`memberships.founder_claim_code_issue`) with payload binding reason / normalized expiresAt / issuedForReference / reserveFounderNumber (`P19-SEC-001` RESOLVED; route DB proofs added Step 2B).
- AdsGram production monetary remains **BLOCKED**; client completion and AdsGram webhook do not issue money.
- Policy Center refuses arbitrary code and returns `applied=false` for REWARD_RULES / PROVIDER_LIMITS / FEATURE_FLAGS / BENEFIT_RULES / WITHDRAWAL_LIMITS; sole FEATURE_FLAGS web mutation is dedicated Feature Flags route (`P19-SEC-009` RESOLVED; DB proof Step 2B).
- Review Queue is not financial source of truth; Admin HTTP `RESOLVE_AFTER_DOMAIN` removed (`P19-SEC-017` RESOLVED).
- Mission NEW claims and PENDING issuance refuse DRAFT/REVOKED mission versions (`P19-SEC-014` RESOLVED).
- Missing `PAYOUT_DISPATCH_PAUSE` fails closed in STAGING/PRODUCTION (`P19-SEC-016` RESOLVED; pipeline DB proof Step 2B). Live STAGING pause flag unchanged.
- Fastify 5.12.2; Next 16.3.6; `@nestjs/platform-fastify` 12.0.3; `@grpc/grpc-js` 1.14.5; `fast-uri` 4.1.4/3.1.7 (`P19-SEC-018..022` RESOLVED).
- `brace-expansion` pinned to 2.1.7 / 5.0.12 (`P19-SEC-023` RESOLVED). Step 2B left 2.1.4/5.0.9 including API `@fastify/static` closure; static registration and attacker-controlled glob input were not observed, but the High advisory was still patched.
  Mainnet / production monetary / AdsGram monetary / payout resume remain unauthorized.

## Phase 20 — Closed Beta / Minimal Funds

Phase 20 is **IN_PROGRESS**. Step 4C.1 preflight path fix + withdrawal pause seed plan recorded (**staging activation / flag seed not performed**). Overall `PHASE20_GATE=HOLD`. Phase 20 is **not** PASS and **not** archived.
Branch: `phase20-closed-beta`. Starting HEAD:
`240d22a6c877f2d678668ba596238f6c8b234f71`.

Authority freeze unchanged: Mainnet OFF; production monetary OFF; AdsGram production
monetary BLOCKED; payout resume unauthorized; `PHASE20_REAL_MONEY_EXECUTION_AUTHORIZED=false`.
Phase 20 archive **not** created. Phase 21 **not** started.

Owner NOTIFICATIONS_SCOPE=DRAFT_ONLY_NO_SEND (P20-GAP-007 DEFERRED). AdsGram monetary remains BLOCKED after Step 3 observation.

Step 2 (historical): disposable draft-only notification proofs; fraud/eligibility fail-closed + TEST
fixture proofs (REFERENCE ONLY — NOT APPROVED FOR STAGING); empty mission list honesty;
referral self-referral / ALREADY_ATTRIBUTED smoke.
Step 3 (complete): Owner `DRAFT_ONLY_NO_SEND`; AdsGram BLOCKED observation/no-fill/Earn UX validated on disposable DB.
`RAILWAY_DEPLOYMENT_PERFORMED=NO`. GitHub commit status reported `alex-rewards-miniapp` Vercel success for the Step 3 commit (automatic; not Railway validation).
Do **not** activate staging policies, mission/referral content, or notification send without Owner approval. Step 4 not started.

Authoritative artifacts:

- `docs/PHASE_20_CLOSED_BETA_PLAN.md`
- `docs/PHASE_20_READINESS_MATRIX.md`
- `docs/PHASE_20_GAP_REGISTER.md`
- `docs/PHASE_20_FRAUD_ELIGIBILITY_POLICY_PROPOSAL.md`
- `docs/PHASE_20_CONTROLLED_CONTENT_PROPOSAL.md`
- `docs/PHASE_20_STEP3_PROVIDER_NO_FILL_EVIDENCE.md`
- `docs/PHASE_20_STEP4_OWNER_POLICY_DECISION.md`
- `docs/PHASE_20_STEP4_OWNER_POLICY_APPROVAL.md`

Phase 19 residual OPEN findings (004–008, 010–012) are carried into the Phase 20 gap register
and must not be silently discarded. P19-SEC-010/011/012 must be reconsidered before any
provider production-money enablement.
