# Implementation decisions

## ADR-001 — Phase 1 package shells

All shared packages named by v1.1 exist from the start. Business-domain packages export no
behavior in Phase 1, preventing temporary financial logic from surviving into later phases.

## ADR-002 — Runtime health servers

API uses NestJS 12 with Fastify. Bot, Worker, and Signer use Fastify directly because they are
independent processes rather than API modules. This preserves deployable boundaries without
pretending they are microservices with business APIs.

## ADR-003 — Local Telegram mode

The Bot supports an explicit `disabled` local transport mode so a new engineer can boot the stack
without a production or test Bot token. Polling/webhook modes fail fast unless a token is supplied.

## ADR-004 — Phase 1 Signer prohibition

The Signer exposes health endpoints only. Any KMS-key environment variable is rejected, and CI
forbids KMS imports outside `apps/signer` for the later implementation.

## ADR-005 — Version 1.2 adoption as source of truth

On 2026-09-08 the Owner adopted
`docs/ALEx_Rewards_Master_Product_Financial_Security_Engineering_Specification_v1.2.md` as the
active source of truth. Version 1.2 preserves the Version 1.1 financial, security, payout,
ledger, fraud, reconciliation, signer, and provider-safety baseline and adds product/platform
expansion architecture (membership/entitlements, provider limits/adapters, policy center,
eligibility/trust, economics, review queue, mission engine, phase archives).

No `OWNER_DECISION_REQUIRED`, `PROPOSED_DEFAULT`, or otherwise undecided production economic or
policy value was invented during this adoption. Existing Phase 1 foundation code is retained;
Version 1.2 does not authorize rebuilding correct Phase 1 work. Phase 2 must not begin until
Phase 0/Phase 1 archive gates pass and the Owner explicitly approves.

## ADR-006 — Dual phase-archive review package

Every accepted phase must produce both a deterministic canonical source ZIP (`git archive` of
the exact accepted commit) and a final Owner review-package ZIP containing that source ZIP plus
acceptance report, `MANIFEST.md`, and `SHA256SUMS.txt`, with `PACKAGE_SHA256.txt` beside the
outer package. Outer ZIP entry names use forward slashes. Acceptance report Section O must not
embed the outer package hash. Changing the outer review-package format does not invalidate sealed
canonical source ZIPs. Helper: `scripts/create-phase-archive.mjs`. Docs: `docs/PHASE_ARCHIVE.md`.

## ADR-007 — V1.2 locked initial economic values vs OWNER_DECISION_REQUIRED

Version 1.2 already locks certain **initial** production values. Those values remain authoritative
and must not be treated as undefined `OWNER_DECISION_REQUIRED` placeholders. Locked examples
include: minimum withdrawal 0.20 USDT gross; initial fixed platform withdrawal fee 0.01 USDT;
maximum single withdrawal 5 USDT gross; per-user hourly withdrawal 5 USDT gross; per-user daily
withdrawal 10 USDT gross / UTC day; Hot Wallet hourly payout volume 25 USDT gross; Hot Wallet
daily payout volume 100 USDT gross / UTC day; current AdsGram provider safety request limit of
maximum 30 requests/user/day; Founder Lifetime catalogue price 50 USD one-time.

Phase 2 does not seed production reward/payout rule rows. Locked V1.2 initials are instantiated
and versioned by their owning implementation phase. The AdsGram 30-request/user/day safety limit
remains the current provider hard/safety basis until approved evidence changes it. Changing a
provider limit such as 30 → 100 later creates a new approved `provider_limit_rules` version and
does not require application-code changes. Founder catalogue price remains 50 USD one-time;
Founder reward bonus remains configurable/proposed and must not be treated as guaranteed.

Values explicitly marked `OWNER_DECISION_REQUIRED` or proposed in V1.2 (including unset final
reward economics/share/eCPM/safety-factor/budgets, Founder bonus launch value/caps, unlocked
referral/mission values, and new-provider limits without an approved contract/documentation
source) remain unset until Owner approval.

## ADR-008 — Phase 3 Bearer session transport

Phase 3 uses short-lived Bearer access JWTs plus opaque refresh tokens persisted only as
hashes in PostgreSQL. Production cookie names, domains, SameSite, and CSRF topology remain
environment-specific and are not invented here. CORS is an explicit allowlist (`CORS_ORIGINS`);
an empty list disables browser cross-origin calls.

## ADR-009 — Unresolved ledger account classifications stay blocked

V1.2 requires an explicit accounting decision before production reporting for
`TREASURY_FUNDING_CLEARING`. Phase 4 therefore supports the enum/account type in the
catalogue but refuses silent get-or-create provision (`OWNER_DECISION_REQUIRED`) unless a
later Owner decision documents production class/side. The same fail-closed stance applies to
`INVALID_TRAFFIC_RECOVERY` until recognition policy is approved. No speculative production
classification is invented in Phase 4.

## ADR-010 — Projection chronology without a posting sequence column

Phase 5 will compose multiple ledger posts inside one outer PostgreSQL transaction. Those posts
can share identical `posted_at` values, so ordering by `posted_at` then UUID/`entry_index` is not
durable financial chronology and produced false CRITICAL last-pointer mismatches.

Decision: **Option 1 — no schema migration.**

- `balance_atomic` rebuilds exactly from immutable entries.
- `version` means the count of DISTINCT ledger transactions that touched the account.
- `last_ledger_transaction_id` is validated as: null iff no history; otherwise must touch the
  account and belong to the latest `posted_at` cohort (tie-aware; UUID order is not used).

A monotonic posting sequence (`0013`) is deferred until an Owner-approved requirement needs a
total order beyond what `posted_at` cohorts + the posting engine’s stored pointer already provide.

## ADR-011 — Linked reversals only via guarded posting path

`PostLedgerCommand` no longer accepts `reversesTransactionId`. Linked reversals are created only
through `reverseLedgerTransaction` → `postLedgerTransactionWithReversalLink`, which enforces an
order-safe exact economic reversal multiset **before** insert so malformed linked attempts cannot
consume the one-reversal unique slot.

## ADR-012 — Reward rule family, immutability, and migration 0013

Phase 5 treats `reward_rules.code` as the logical rule **family**. At most one `ACTIVE` validity
window may exist per `code` (PostgreSQL `EXCLUDE` on `tstzrange(valid_from, valid_to)`). Application
`resolveRewardRule` still fails closed if zero or more than one `ACTIVE` row matches the resolution
context (source_type / provider / country / asset), because multiple families could otherwise match.

Financially authoritative fields on `reward_rules`, `membership_benefit_rule_versions`, and
`economic_exposure_limits` are immutable in place (0013 triggers). Approved lifecycle supersession
is allowed (status / `valid_to` / `effective_to` / reason / `updated_at` as applicable). Overlapping
`ACTIVE` windows fail closed via `EXCLUDE`.

Quote reconstruction requires frozen `reward_quotes.applied_economics`, plus `source_started_at`
and explicit `bonus_unavailable_policy` when bonus evaluation is in scope.

## ADR-013 — Membership bonus FLOOR formula (interim)

Until an Owner locks a different production formula, membership bonus amount is:

```text
FLOOR(base_amount_atomic * bonus_bps / 10000)
```

using the post-clamp quoted base. A zero result after `FLOOR` is treated as **no bonus** (amount 0),
not an error. Base and bonus remain separately reserved, posted, and audited.

## ADR-014 — Membership bonus unavailable policies

When membership bonus evaluation is in scope, an explicit pre-start policy is mandatory
(`BASE_REWARD_ONLY` | `BLOCK_QUOTE_BEFORE_START`). Missing policy fails closed.

- `BASE_REWARD_ONLY` — quote/issue the base reward; omit bonus reservation/issuance when bonus
  cannot be honored (pause, missing entitlement/budget, exhausted caps, zero after FLOOR).
  Only recognized economic unavailability may downgrade; arbitrary DB/internal errors must not.
- `BLOCK_QUOTE_BEFORE_START` — refuse quote creation when bonus cannot be fully reserved/honored
  before source start. Never silently drop a promised bonus after a valid start. No surviving
  quote/reservation state on failure.

## ADR-015 — Phase 5 financial correction migration 0014

Independent review found runtime gaps after the first Phase 5 archive (`a7da07d…`). Correction
requires forward migration `0014_phase5_financial_corrections.sql` (do not edit `0001`–`0013`):

1. `simulated_reward_sources` — DB-authoritative simulated PROMOTION identities (Outbox alone is
   insufficient).
2. `reward_quotes` financial snapshot trigger — reject in-place mutation of money/identity/
   `applied_economics`; allow narrow lifecycle; `source_started_at` NULL→timestamp once.
3. Multi-period membership bonus reservations — drop single-quote unique; unique
   `(reward_quote_id, budget_period_id)` so daily/monthly/plan/user/global caps reserve together.
4. `economic_exposure_periods` + `economic_exposure_reservations` — concurrency-safe, time-scoped
   exposure authorization under PostgreSQL locks. Redis has zero financial authority.

`MIN_EXPECTED_MARGIN_BPS` when ACTIVE fails closed (`MARGIN_POLICY_UNDEFINED`) until an
Owner-approved expected-margin formula exists. Do not treat `10000 - user_share_bps` as margin.

## ADR-016 — Wallet proof nonce invalidation lifecycle (migration 0016)

V1.2 §29 requires pending old-wallet challenges to be invalidated when the primary wallet changes.
`user_wallet_proof_nonces.consumed_at` alone cannot distinguish successful **CONSUMED** from
**SECURITY_INVALIDATED** without corrupting audit semantics.

Phase 6 therefore adds forward migration `0016_wallet_proof_nonce_lifecycle.sql` (do not edit
`0001`–`0015`) with:

- `invalidated_at` / `invalidation_reason` (e.g. `PRIMARY_WALLET_CHANGED`);
- exclusive terminal CHECK: not both consumed and invalidated;
- open-index predicate: `consumed_at IS NULL AND invalidated_at IS NULL`.

Domain authority for `ton_proof` remains server config (`expectedTonProofDomain`), never request
Host/Origin. Staging/production reject localhost domain inheritance.

## ADR-017 — Phase 7 Outbox → Temporal withdrawal payout (fake activities LOCAL/TEST)

Phase 7 requires Outbox-started payout work with deterministic workflow ID
`withdrawal/{withdrawalId}`.

Decision:

1. **Approval transaction** writes withdrawal APPROVED + `withdrawal.approved` Outbox row and
   commits. There is **no** Temporal call inside that DB transaction.
2. **Outbox relay** (worker) claims PENDING `withdrawal.approved` rows and starts Temporal workflow
   `withdrawalPayoutWorkflow` with `workflowId = withdrawal/{withdrawalId}`.
   `WorkflowExecutionAlreadyStarted` is treated as recovery of the original workflow (mark Outbox
   DISPATCHED); Temporal unavailable leaves Outbox PENDING/retryable with Reserved untouched.
3. **Workflow code is deterministic**; PostgreSQL/network/domain mutation lives in Activities.
4. Activities call the **FakePayoutChain** pipeline for LOCAL/TEST only
   (`WITHDRAWAL_FAKE_CHAIN_ENABLED`). Staging/production keep fake chain disabled (fail closed).
   Real TON/signer/KMS remains Phase 9/10.

In-process `runFakePayoutPipeline` remains available for unit/integration tests that do not need a
full Temporal env; official Phase 7 Temporal gates use `@temporalio/testing`.

## ADR-018 — Phase 10 Testnet payout foundation (broadcast outside signer)

Phase 10 started as a **foundation** only. Status remains
**IN PROGRESS / BLOCKED — EXTERNAL TESTNET RESOURCE REQUIRED** until Owner supplies resources.

Decisions:

1. **Jetton master is Owner-required.** Never invent a Testnet Jetton master address. When
   `WITHDRAWAL_REAL_CHAIN_ENABLED=true` and `TON_TESTNET_JETTON_MASTER` is empty, config fails closed.
2. **Broadcast is outside `apps/signer`.** Signer may return signed external-message BOC; worker
   persists pre-broadcast evidence then submits via `@alex-rewards/ton` providers. Signer never
   calls TON RPC.
3. **No blind resend** after `broadcast_submitted_at` or ambiguity classification.
4. **No Mainnet / no AWS KMS / no plaintext keys.** Fake chain remains for Phase 7 local tests.
5. Migration `0021` is additive only; `0001`–`0020` immutable. Phase 9 signer custody not weakened.
6. Do not claim real Testnet 100+ payout PASS; do not start Phase 11; do not seal a Phase 10 PASS archive yet.

## ADR-019 — Owner admin password+TOTP session issuer (Recovery prerequisite)

Phase 10 Recovery requires an authenticated Owner `admin_sessions` row with same-session
`reauthenticated_at` ≤ 15 minutes. Control Center sessions are not `admin_sessions`.

Decisions:

1. **Interim local factor set:** password (Argon2id verifier) + TOTP (RFC 6238), matching the
   schema’s `PASSWORD` + `TOTP` credential types. Spec primary WebAuthn/Passkeys remain required
   for production Admin Control Plane; this CLI is the Recovery-compatible issuer until that
   Control Plane ships.
2. **TOTP at rest:** secrets are XChaCha20-Poly1305 sealed under a password-derived Argon2id key
   (`local-totp-seal-v1$…` in `totp_secret_reference`). Plaintext TOTP never rests in PostgreSQL.
   Format is local-only; production KMS/HSM references are out of scope for this CLI.
3. **Session tokens:** cryptographically random opaque tokens; only
   `sha256Hex("admin-session:" + token)` is stored (`hashAdminSessionToken`), shared with
   Recovery’s `hashPhase10CanaryOwnerSessionToken`.
4. **Secrets transport:** password, TOTP codes, and session tokens are interactive TTY-only
   (non-echoing). Forbidden on argv, env, and structured success JSON (session token may be
   printed once to stderr for Owner paste into Recovery’s hidden TTY prompt).
5. **DB write gate:** requires `--expected-database` / `expectedDatabase` matching
   `current_database()`. Operational `alex_rewards` additionally requires Owner-controlled
   `expectedClusterSystemIdentifier` matching `pg_control_system().system_identifier` and
   `OWNER_ADMIN_AUTH_ALLOW_OPERATIONAL_DB=I_CONFIRM_OWNER_ADMIN_AUTH_ON_ALEX_REWARDS` (intent
   only). Isolated tests use approved `*_test` / `*_phaseN` databases only.
6. **Not sufficient alone:** Owner UUID, DB credentials, Telegram user id, Recovery
   confirmation phrase, database name alone, or URL alone never create or authenticate an
   admin session or prove cluster identity.
7. **Operational first enrollment is refused** until a separately approved bootstrap
   ceremony exists (`docs/OWNER_ADMIN_BOOTSTRAP_DESIGN.md`). Ops confirm remains
   intent-only.
8. **Forward migration `0024`:** additive `totp_last_accepted_step` +
   `admin_auth_throttle` for replay protection and persistent attempt controls.
9. **Mixed ACTIVE unsupported credentials:** refuse enroll/replace for unknown types
   (fail-closed). **Superseded for WEBAUTHN by ADR-023** — WebAuthn is a supported primary
   factor as of Phase 13 (`docs/OWNER_ADMIN_AUTH.md`).
10. **Auth failure accounting:** invalid-credential outcomes COMMIT throttle/audit under
    the pool-owned transaction before throwing (AuthOutcome), closing the post-rollback
    race.

## ADR-020 — Single-OWNER authority invariant (M0)

**Status:** Accepted for implementation on isolated test DBs; operational apply requires
separate Owner authorization. Does **not** implement bootstrap, CO_OWNER, or ownership
transfer.

### Problem

`admin_role_bindings` only enforced `UNIQUE (admin_user_id, role_id)`. Multiple distinct
`admin_users` could each hold an unrevoked `OWNER` binding. Spec/comment intent (“exactly
one Owner”) was not database-enforced. A partial unique index **cannot** use a JOIN to
`admin_roles` in its predicate.

### Decisions

1. **Singleton seat table `admin_owner_authority`** with `PRIMARY KEY (seat)` and
   `CHECK (seat = 1)`. Exactly one row. `holder_admin_user_id IS NULL` means
   **pre-bootstrap** (zero Owners is valid and fail-closed for product auth that requires
   an OWNER binding).
2. **Trigger `app_enforce_single_owner_authority`** on `admin_role_bindings` locks the
   seat (`FOR UPDATE`) and:
   - allows the **first** unrevoked OWNER binding to claim a vacant seat;
   - allows the **same** `admin_user_id` to restore (`revoked_at = NULL`) their binding;
   - refuses any other admin claiming OWNER while the seat is held;
   - on revoke/delete of the OWNER binding: clears `active_binding_id` but **does not**
     clear `holder_admin_user_id` (informal transfer via revoke-then-grant-other is refused).
3. **Partial unique index** `admin_role_bindings_one_unrevoked_owner` on `(role_id)`
   `WHERE revoked_at IS NULL AND role_id = <OWNER uuid baked at migrate time>` — uses only
   local table columns; OWNER id is resolved once in a `DO` block (not a subquery in the
   index predicate).
4. **Policy distinction:** Application “effective OWNER” remains
   `admin_users.status = ACTIVE` **and** unrevoked OWNER binding (existing
   `requireActiveOwner` / Recovery / Control Center). The seat may remain held if the
   holder is later `DISABLED`/`LOCKED` — disabling does not free ownership for another
   admin.
5. **Migration refuse-on-conflict:** If >1 unrevoked OWNER binding **or** >1 distinct
   `admin_user_id` with any OWNER binding history exists, migration `0025` **raises** and
   does not pick a winner.
6. **OWNER binding transitions (M0):** Changing `role_id` from OWNER to a non-OWNER role,
   or changing `admin_user_id` on an OWNER binding, is **refused**. Authorized ownership
   transfer remains a future procedure. This keeps `active_binding_id` from pointing at a
   binding that no longer represents OWNER.
7. **0024 bookkeeping:** Before inserting `0024_owner_admin_auth_hardening` into
   `schema_migrations`, `0025` verifies the 0024 **schema contract** via catalog
   introspection: TOTP `BIGINT NULL` + normalized nonnegative CHECK (rejects `OR TRUE`);
   throttle `admin_user_id UUID NOT NULL` with `PRIMARY KEY (admin_user_id)` and FK
   `confkey`→`admin_users.id` ON DELETE CASCADE; `failed_attempts` /
   `window_started_at` / `locked_until` / `updated_at` types+nullability+exact
   defaults (`0` / `now()`); exact nonnegative `failed_attempts` CHECK; trigger
   `tgenabled IN ('O','A')`, `BEFORE UPDATE` only, `FOR EACH ROW`, unrestricted
   (`tgqual IS NULL`, empty `tgattr`), `tgfoid = public.app_set_updated_at()`. Names,
   arbitrary PKs, substring CHECKs, and trigger names alone are insufficient.
   Missing/partial/incompatible → refuse; never mark unapplied 0024 as applied.
   Migration `0024` SQL remains immutable.
8. **Out of scope for M0:** bootstrap ceremony, CO_OWNER, Team UI, authorized ownership
   transfer procedure, Recovery CLI execution, operational apply.
9. **Forward migration `0025`:** additive; `0001`–`0024` immutable.

## ADR-021 — M1-A.1 first-Owner trust design (Option C + endpoint trust)

**Status:** Design for independent review (incl. final credential-request binding).
**Local Stage B:** Owner-authorized and implemented for isolated tests (ephemeral
test keys only) — see Stage B clarification below and checklist §C. **Does not**
complete Checklist **B** or **D**.
**Operational label:** `DESIGN READY — TRUST ESTABLISHMENT BLOCKED`.
**Historical note:** Earlier ADR text said “not implemented” in the sense of
production trust establishment / ops redeem go-live; that must not be conflated
with absence of local Stage B after the 2026-09-21 clarification.

### Problem

M0 enforces at most one OWNER seat but does not establish who the rightful first
Owner is. UUID/Telegram/DB identity/confirm literals are not proof. Stage A found
no independently established trust anchor. Grant possession alone is not claimant
authentication.

### Decisions

1. **Provisional ceremony direction:** Option C — Owner-held offline, one-time,
   expiring enrollment grant, purpose `FIRST_OWNER_ENROLLMENT` only.
2. **Canonicalization (F2):** RFC 8785 (JCS) + strict schema; reject duplicate keys,
   unexpected fields, invalid types, unsupported versions; hard `exp` (no positive
   skew); `iat` early skew ≤60s only.
3. **Stolen grant (F1):** Redeem requires Owner-bound Ed25519 proof-of-possession
   over a verifier challenge using the ceremony-registered key; grant file alone
   fails closed. Expiry/nonce/seat/email/labels are not claimant authentication.
4. **Challenge lifecycle (P1):** Verifier uses **securely stored challenge state**
   (optional authenticated challenge token for transport) bound to
   `grant_id` / `key_id` / `endpoint_profile_id` / single `attempt_id` with exact
   `issued_at`, plus an **ephemeral enrollment-channel Ed25519 keypair** generated
   in the legitimate CLI/process. `channel_fp` is registered at attempt creation,
   bound into stored state and Owner-signed `challenge_bytes`, and proven again
   via `sig_channel_pop` (PoP submit) and `sig_channel_cred` over the **complete
   final credential request** (JCS public header including `intended_subject` +
   length-prefixed password/TOTP tails; domain
   `ALEx-OwnerBootstrap-FinalCredReq-v1`). Tickets are bound to the same
   `channel_fp`. Credential substitution fails closed. Stolen grant / PoP /
   ticket from another channel fails closed. Interactive credentials are
   collected **outside** any DB transaction in the same process that holds
   `channel_sk`; a short final TX revalidates all authoritative conditions
   (including reconstructed final-request signature) and atomically creates
   credentials, binds the OWNER seat, and consumes the grant. Interrupted
   enrollment requires a **new** attempt — no silent channel reassignment.
   `channel_sk` and credential tails never enter logs or archives. First-use
   race of a stolen **complete** PoP is attempt DoS, not activation; first-use
   of a stolen **complete** final request remains a residual capture risk —
   client nonce uniqueness does not prevent that race.
5. **Endpoint trust (F3/P2):** Mandatory TLS certificate-chain verification to an
   Owner-approved trust anchor **and** mandatory hostname verification. Optional
   additional SPKI pinning only if securely supported — never a substitute for
   chain or hostname. Fail closed if a selected verify feature is unavailable.
   No downgrade. DB name / cluster id supplementary only.
6. **Provenance (F3):** External root is the Owner ceremony seal; deploy trust stores
   are derivatives matched via dual-channel policy; DB is not the pin authority.
7. **Honest DBA boundary:** grants cannot stop a fully privileged DBA on an
   uncontrolled database; privileged access is infrastructure-controlled.
8. **Narrow redeem path:** future `redeemOwnerBootstrapGrant` is stricter than a
   FS-01 bypass; existing Owner-auth APIs remain default-denied; no public OWNER
   self-registration.
9. **State machine:** `UNINITIALIZED → AUTHORIZED → CREDENTIAL_SETUP → ACTIVE`
   with channel-bound PoP before `AUTHORIZED`, credentials outside TX on the
   same channel key, atomic final consume, M0 seat respect, no silent transfer.
10. **Readiness states must not be conflated:** (A) design, (B) production trust
    anchor, (C) local implementation (ephemeral test keys OK without completing B/D),
    (D) operational enrollment.
11. **Documents:** `docs/OWNER_ADMIN_BOOTSTRAP_DESIGN.md`,
    `docs/OWNER_ADMIN_DB_IDENTITY_DESIGN.md`, `docs/M1_A1_THREAT_MODEL.md`,
    `docs/M1_A1_TRUST_ESTABLISHMENT_CHECKLIST.md`, `docs/M1_A1_IMPLEMENTATION_PLAN.md`.

### Non-decisions (Owner still required)

Witness identities (concrete names), production key ceremony execution, Owner CA
trust-anchor material + `tls_server_name`, operational go-live (**D**).
**SPKI add-on:** Owner decided **NO for v1** (2026-09-22); mandatory CA+hostname
verify-full remains. Dual-channel v1 pair and profile digest method were
Owner-accepted at design-contract level (BD-1…BD-6). Ceremony execution still pending.
Stage B **local** authorization was recorded 2026-09-21 (clarification below).

### Stage B local clarification (2026-09-21)

Owner authorized **local** Stage B implementation/testing only. Ephemeral
test-only Ed25519 keys and `deployment_env=isolated_test` with explicit
`tls.mode=isolated_test_loopback_plaintext` (loopback + approved `*_test` DB)
are permitted for harnesses. This does **not** establish Checklist **B** or
authorize **D**. Production/staging profiles still require verify-full TLS
(chain + hostname + Owner CA; optional SPKI add-on only). FS-01 remains.

## ADR-021 — Isolated Testnet aalex Phase 10 provision allowlist

Date: 2026-09-22

Phase 10 Testnet Available provisioning may credit **USDT** (unchanged fixture path) or
**aalex** under an explicit allowlist. aalex requires:

1. `DEPLOYMENT_ENV` local/test and `WITHDRAWAL_NETWORK_CODE=TON_TESTNET` only.
2. Exact Jetton master `0:e6e40e4e445c86c07df96a3129b67a74a411abbf1cd476607860978b7d5f1831`
   and decimals `9` on the ACTIVE assets row.
3. `PHASE10_TESTNET_PROVISION_REQUIRED_DATABASE_NAME` matching `current_database()`, never
   operational `alex_rewards` / `alex_rewards@55432`.
4. Configured max ≤ absolute ceiling of `10000000000` (10 aalex); isolated prep uses
   `1000000000` (1 aalex).

Proposed isolated fee/limit rules for a future 1 aalex withdrawal live in
`PROPOSED_ISOLATED_AALEX_WITHDRAWAL` (min 1 aalex, fixed fee 0.01 aalex,
`max_auto_payout_atomic` NULL per schema CHECK — matches locked USDT fixture).
They are not activated on operational or isolated DBs without a separate Owner authorization.
Owner admin enrollment remains the Option C bootstrap ceremony; no SQL/admin forge path.
Settlement uses asset-aware Hot Wallet inventory: USDT → `HOT_WALLET_USDT_ASSET`;
allowlisted aalex → `HOT_WALLET_JETTON_ASSET` (migration `0029`). USDT production path unchanged.

### Isolated Option C ceremony CLI (2026-09-22)

Owner authorized a local Owner-operated Option C ceremony CLI for **ephemeral
TEST trust keys only** on isolated `*_test` databases. The CLI prepares
keypair / endpoint profile / seal / Channel B Owner TTY digest recording and
gates enrollment on concrete witnesses + dual-channel evidence. Completing
this CLI does **not** complete Checklist **B** or **D**, does not authorize
operational enrollment, and must never reuse ephemeral keys for production.

## ADR-022 — Phase 10 isolated Telegram first-Owner bootstrap (practical)

Date: 2026-09-22

**Supersedes (isolated Testnet only):** Option C witness/paper ceremony as the
required first-Owner path for `alex_rewards_isolated_payout_test` @ `127.0.0.1:55440`.

**Does not change:** product roadmap, multi-provider architecture, Founder /
membership / referral / mission rules, withdrawal financial protections, or
self-hosted encrypted signer custody (AWS KMS remains rejected).

**Isolated trust model (explicit):**

1. Configured Owner Telegram numeric user id
2. Verified Telegram Mini App `initData` (bot-token HMAC)
3. Password + TOTP Owner admin factors
4. Single M0 Owner seat + audit log + replay refuse when seat held

Telegram username is display-only and never authorizes. Independent witnesses
and paper Channel B are not part of this isolated path. Operational
`alex_rewards` / port `55432` / `DEPLOYMENT_ENV=production` remain refused.
Option C library/CLI remains available but is not required to activate the
isolated Testnet Owner.

**Isolated activation status (2026-09-23):** first Owner enrolled and TOTP rotated after
compromise; NEW TOTP login verified and OLD TOTP rejected. Owner authentication is
**complete** for this isolated DB. Remaining Phase 10 live work is ledger provision,
fee/limit activation, isolated signer unlock, and controlled 1 aalex payout — not a new
Owner bootstrap.

## Clarification — Phase 10 payout activity diagnostics + FAILED_PRE reuse (2026-09-23)

Implementation clarification (does not change financial rules):

1. Temporal withdrawal payout activities/workflows **must preserve** pipeline
   `reason` and `stagesCompleted` on the activity result (previously dropped).
2. `FAILED_PRE_BROADCAST` with **zero** attempts **or** only clean
   `FAILED_PRE_BROADCAST` attempts (no signature Boc/hashes, no
   `broadcast_submitted_at`, no `chain_reference`, no ambiguous states),
   released dispatch lease, held reservation, and null release/settlement is
   **domain-safe to reuse** the same withdrawal id (no second mint). Evaluation
   is read-only via `evaluateFailedPreBroadcastReuse`; enqueue via
   `enqueueFailedPreBroadcastRetry`. Attempt #N+1 is created only by the
   payout pipeline after redispatch — prior clean attempts are never mutated
   or re-signed.
3. First-start Outbox `withdrawal.approved` keeps `workflowIdReusePolicy:
REJECT_DUPLICATE` (ADR-017).
4. Owner-gated redispatch uses Outbox event `withdrawal.failed_pre_retry` and
   starts the **same** `withdrawal/{id}` with `ALLOW_DUPLICATE` +
   `workflowIdConflictPolicy: FAIL`, only after re-verifying reuse safety and
   refusing a still-RUNNING prior execution. Unsafe events go to `DEAD_LETTER`.
   Idempotent while a PENDING retry outbox already exists.

## Clarification — Phase 10 seqno readmission RATE_LIMITED recovery (2026-09-23)

Implementation clarification (does not change dual-provider or financial rules):

1. Proven WD-000002 failure: post-lease `admitWalletSeqno` hit TonCenter
   `getAddressInformation` HTTP 429 immediately after a successful initial
   dual-provider admission. No attempt/signing/broadcast occurred.
2. Remedy: `admitWalletSeqnoWithRateLimitRetry` — bounded backoff retries **only**
   for `RATE_LIMITED`, always re-running full dual TonAPI+TonCenter admission.
   Post-lease readmission adds ~1.1s pace and re-validates dispatch lease
   fencing before each retry; lease expiry/mismatch fail-closes as
   `LEASE_FENCE_INVALID` with attempt still null.
3. Does **not** bypass TonCenter, substitute TonAPI twice, suppress 429, or
   assume seqno unchanged. Empty TonCenter API key remains a capacity risk;
   code retry is configuration-independent mitigation within lease TTL.

## Clarification — Phase 10 isolated USDT Z hot-wallet ledger funding (2026-09-23)

Owner-authorized isolated Testnet reconciliation only:

1. On-chain 25.000000 USDT Z was deposited to the hot JW without a ledger
   inventory post. Settlement of WD-000002 credited `HOT_WALLET_USDT_ASSET`
   190000 → ledger inventory `-190000` while on-chain JW remained `24810000`.
2. Owner acknowledged one `HOT_WALLET_FUNDING` of **25000000** atomic via
   `postOwnerAcknowledgedHotWalletUsdtFunding` (`ownerAcknowledgesUnresolvedTreasuryClearing=true`):
   DEBIT `HOT_WALLET_USDT_ASSET` / CREDIT `TREASURY_FUNDING_CLEARING`.
   Resulting inventory `24810000` matches on-chain JW. Duplicate funding for
   the same hot wallet+asset is refused.
3. Does not move chain funds, raise limits, or provision user Available.

## Clarification — Real-chain DEFINITIVE_NONPAYMENT via V5R1 expired unconsumed seqno (2026-09-24)

Phase 10 real-chain reconcile-only (`reconcileRealWithdrawalAttemptOnly`) now supports one
narrow durable nonpayment criterion:

- Reason code: `WALLET_V5R1_EXPIRED_UNCONSUMED_SEQNO`
- Requires verified Wallet V5R1 signed-external identity + dual-provider seqno agreement that
  the attempt’s expected seqno remains unconsumed after the request’s own `valid_until`.
- Provider absence / HTTP 404 alone remains insufficient.
- Classification persists reconciliation evidence only — no Reserved release, REJECTED,
  QUEUED retry, sign, or broadcast in this path.

## Clarification — Real-chain DNP hold bridge (2026-09-24)

Authoritative command `holdReconciledWithdrawalAfterDefinitiveNonpayment` is the only
real-chain path that transitions `RECONCILE_REQUIRED → HELD` with `held_from_reconcile=true`,
and only when durable `DEFINITIVE_NONPAYMENT` evidence for the current attempt carries reason
`WALLET_V5R1_EXPIRED_UNCONSUMED_SEQNO`. The bridge does not release Reserved or REJECT;
those remain a separate Owner `decideWithdrawal(REJECT, definitiveNonpayment:true)` step
via `releaseWithdrawalReservation`. Fake-chain `applyObservation` auto-HOLD must not be
reused against real-chain withdrawals.

## Clarification — Phase 10 USDT-Z pre-manifest canary binding (B3 Option C, 2026-09-25)

Owner-authorized narrow exemption only. Campaign tooling initialized
`phase10-usdt-z-acceptance` **after** the already-CONFIRMED USDT-Z canary
`01a0cc13-cdec-77ea-8561-2a79690e2a47` (WD-000002) and attached it as ordinal 1.
`campaign.createdAt` remains the independently recorded manifest bootstrap time and must
**not** be backdated.

Shared predicate `isAuthorizedPhase10PreManifestCanary` (constant
`PHASE10_USDT_Z_CANARY_WITHDRAWAL_ID`) may bypass solely
`requested_at >= campaign.createdAt` in:

1. `evaluatePhase10AcceptanceFromEvidence` campaign temporal binding
2. `loadPhase10ExpectedCampaignPayouts` expected-payout inclusion

and only when UUID match + campaign membership + ordinal 1 + CONFIRMED + settlement +
IPP + final attempt ∈ `baselineIsolatedHistoricalAttemptIds` + evidence invariant PASS
all hold. Fail closed otherwise. Not keyed by publicId. Does not flip chain-history
collector availability (B1) or capture live readiness (B2).

## Clarification — Phase 10 chain-history collector availability (B1, 2026-09-25)

Owner authorized flipping `PHASE10_CHAIN_HISTORY_PROVIDER_COLLECTOR_AVAILABLE` from
`false` to `true` because `collectPhase10LiveProviderBackedChainHistory` is implemented
and wired (TonCenter primary + TonAPI secondary, independent fingerprints, Testnet
health, DB-loaded expected payouts, `toPhase10ChainHistoryEvidenceArtifact`).

Acceptance still fail-closes unless evidence is `PROVIDER_BACKED`,
`independenceProven=true`, `ZERO_UNEXPECTED`, schema-valid, and Hot Wallet / Jetton /
fingerprint / window bindings hold. No env override. No FAKE/SIMULATED history as
PROVIDER_BACKED. No chain or financial mutation. B2 schema-v2 live readiness remains
separate and unresolved.

## Clarification — Phase 10 acceptance provider-role + acceptanceCutoff contract (2026-09-25)

Owner authorized a narrow acceptance-contract fix only:

1. **One authoritative provider-role source:** `resolvePhase10LiveProviderRoles` (in
   `phase10-live-probes.ts`, re-exported via `phase10-provider-roles.ts`). Live readiness
   probes, the provider-backed chain-history collector, and acceptance fingerprint binding
   derive primary/secondary kind + endpoint + fingerprint from the same configured
   `TON_PRIMARY_*` / `TON_SECONDARY_*` mapping. Isolated env canonical roles remain
   primary=TonAPI, secondary=TonCenter. Role order must not be hardcoded independently in
   orchestration scripts. Unordered fingerprint-set matching is not used — explicit
   primary/secondary semantics are preserved. Independence, distinct fingerprints, and
   Testnet `networkGlobalId` checks remain fail-closed.

2. **Stable `acceptanceCutoff`:** Captured once (UTC ISO) **before** fresh full-campaign
   chain-history collection. `evaluatePhase10AcceptanceFromEvidence` requires it and uses
   it as `campaignWindowEnd` for observation-window coverage. It must not call evaluator-time
   `new Date()` for that coverage check. Missing/malformed cutoff fails closed. No clock
   tolerance/skew. Canonical B2 readiness artifact is not edited. No economic mutation,
   archive, or Phase 10 close under this authorization.

## Clarification — Phase 10 Owner review approval recorded (2026-09-25)

Owner explicitly approved the current technical evidence package and authorized recording
`ownerReviewApproved=true` only, via the authoritative
`evidence/acceptance/owner-review-package.json` (`schemaVersion: 1`,
`packageKind: PHASE10_OWNER_REVIEW_SUMMARY`). Approval binds to the exact evidence SHA-256
hashes / chain-history `evidenceDigest` / `acceptanceCutoff` of that package. Owner accepted
21 known unrelated failures in `phase10-canary-signing-recovery.test.ts` without marking
them PASS or claiming the full repository suite is green. Final archive creation and Phase
10 close remain **not** authorized by this decision.

## Clarification — Phase 10 final evidence archive created without closure (2026-09-25)

Owner authorized creation of the Phase 10 **final evidence archive** only
(`PHASE10_FINAL_EVIDENCE_ARCHIVE` under `phase-archives/PHASE_10_TON_TESTNET_PAYOUT/`),
bound to the exact SHA-256 hashes / chain `evidenceDigest` recorded in
`owner-review-package.json` `ownerApproval.evidenceBinding`. Archive packaging reuses
`scripts/create-phase-archive.mjs` ZIP/checksum primitives and does **not** set
`phase10Closed` or campaign `CLOSED`. Repository dual git-archive of an accepted commit
remains a separate gate if/when Owner authorizes Phase 10 closure with a sealed tip.

## Clarification — Phase 10 closure gate missing (2026-09-25)

Owner authorized Phase 10 closure **only if** an authoritative closure gate independently
becomes eligible. Inspection found:

1. `evaluatePhase10AcceptanceFromEvidence` hard-codes `mayMarkPhase10Closed=false` on every
   path (including PASS). Owner review / final archive are not inputs to that boolean.
2. No exported `closePhase10` / `markPhase10Closed` / equivalent exists in
   `@alex-rewards/withdrawals`.
3. Campaign `generateFinalCampaignEvidence` cannot promote to `COMPLETED` while
   `status=AWAITING_OWNER_APPROVAL` or `realModeCheckpoint` is set; there is no official
   checkpoint-clearance API after technical Owner review.
4. Sealed `git archive` packaging cannot safely proceed from the current dirty working tree
   without inventing a tip commit.

Therefore closure was **not** executed. Force-setting `PHASE10_CLOSED` remains forbidden.

## Clarification — Phase 10 closure eligibility gate implemented (2026-09-25)

Owner authorized **implementation + read-only evaluation** of a separate Phase 10 closure
stage (not closure mutation). Technical acceptance continues to hard-code
`mayMarkPhase10Closed=false`. Closure eligibility is now
`evaluatePhase10ClosureEligibility` in `packages/withdrawals/src/phase10-closure-gate.ts`:

1. Historical live readiness = approved schema-v2 B2 readiness artifact (UNLOCKED/REAL
   during the controlled window). Campaign `realExecutionGates` remain historical and
   are not rewritten for closure.
2. Post-run closure safety = current pause=true, signer LOCKED, signingReady=false,
   REAL=false, FAKE=false, unresolved=0, leases=0, duplicates=0, reserved=0.
3. Only the closure gate may return `mayMarkPhase10Closed=true` when blockers are empty.
4. Canonical campaign final status remains `COMPLETED` (existing enum). Transition helper
   `transitionCampaignToPhase10FinalState` clears `realModeCheckpoint` only; it was not
   executed against the live campaign under this authorization.
5. `closePhase10` requires `executeMutation=true` and revalidates eligibility; default is
   refuse-to-mutate. Live Phase 10 remains OPEN until a separate Owner closure
   authorization.
6. Known 21 failures in `phase10-canary-signing-recovery.test.ts` remain a documented
   Owner-accepted non-blocking condition; the gate never claims full-suite green.

## Clarification — Phase 10 officially CLOSED (2026-09-25)

Owner authorized the actual final closure mutation via
`closePhase10({ executeMutation: true })` only after a fresh
`evaluatePhase10ClosureEligibility` PASS (`eligible=true`,
`mayMarkPhase10Closed=true`, `blockers=[]`).

Executed at `closedAt=2026-09-25T04:11:55.237Z` against campaign
`2fdf9a3b-dee5-46e6-a2a4-4a0a10236093`:

1. Campaign `AWAITING_OWNER_APPROVAL` → `COMPLETED`; `realModeCheckpoint` cleared to
   `null`; historical `realExecutionGates` preserved unchanged.
2. Owner package `phase10Closed=true` with closure audit at
   `evidence/acceptance/phase10-closure-audit.json`.
3. Final evidence archive ZIP / MANIFEST SHA-256 unchanged
   (`b3f269e0…0354` / `bf7d631e…62da`). Non-campaign approved evidence hashes unchanged.
   Campaign file hash changed only as authorized control-metadata transition.
4. No economic ledger / chain / signature / broadcast / payout #101 mutation. Safety
   remained pause=true, signer LOCKED, REAL=false, FAKE=false.
5. Second `closePhase10({ executeMutation: true })` returned `ALREADY_CLOSED` (no-op).
6. Known 21 canary-signing-recovery failures remain documented; full suite not green.

## Clarification — Phase 10 dual-archive packaging (2026-09-25)

Owner authorized mandatory dual-archive packaging only (no Phase 11). Accepted packaging
commit `7c57ce2000ca0e0c8abcc9761a7ba2af61974b3a` (implementation seal
`58d5c81c4ab898f2fd9b16545e967e47bc1ce093` + acceptance-report SHA record). Helper
`scripts/create-phase-archive.mjs` v2.1.0 produced:

- Source: `ALEx_Rewards_PHASE_10_TON_TESTNET_PAYOUT_20260925-042556_7c57ce2.zip`
  SHA-256 `4e6785db107a5fd6db7f9e55b3da2242201c4a9ef9d2ff4b397c9cf27fc69814`
- Package: `PHASE_10_TON_TESTNET_PAYOUT_PACKAGE_20260925-042556_7c57ce2.zip`
  SHA-256 `cd9b3c4a159ea288efc2d9068a7ecc3f93cdf78a7212b3ee1bb47f59a65ea722`
  (external `PACKAGE_SHA256.txt`)

Prior final evidence archive preserved under
`phase-archives/PHASE_10_TON_TESTNET_PAYOUT/evidence-archive-preserved-20260925-034434/`
(SHA-256 unchanged `b3f269e0…0354`). Phase 11 not started.

## Clarification - Phase 11 packages/ads implementation (2026-09-25)

Implementation clarifications recorded while building `packages/ads` (no approved product or
financial rule was changed):

1. `packages/ads` composes transactions through `@alex-rewards/rewards` only. It never
   imports `@alex-rewards/ledger` and never posts a ledger transaction; `src/db.ts`
   re-exports `withLedgerTransaction` from the Reward Engine for that reason.
2. Effective provider limits are resolved PER DIMENSION (`limit_metric` + `limit_window`)
   by taking the MINIMUM `max_count` across every applicable ACTIVE rule version, so a
   platform/user/country rule can only be stricter than a provider or contract hard limit.
   No numeric limit (30 / 25) exists as a code constant; both come from
   `provider_limit_rules` data seeded by migration 0030.
3. A provider with no `provider_health_snapshots` observation is treated as UNAVAILABLE for
   NEW session authorization, not as implicitly healthy.
4. `ad_sessions.correlation_nonce_hash` is left NULL for AdsGram because the provider does
   not support a custom nonce echo (`custom_nonce_supported = false`). A stored nonce that
   the provider cannot return would be correlation theatre.
5. The monetary gate `evaluateProviderMonetaryEligibility` is provider-neutral and reads
   only data (production monetary status, cash-reward policy approval, server signal
   authentication, session correlation capability, health, open clarification count, hard
   limit flags, plus per-signal authenticity/correlation). AdsGram is refused today because
   its seeded data says BLOCKED with six OPEN clarification items, not because any AdsGram
   name is branched on in code.
6. Terminal non-reward outcomes (NO_FILL / FAILED / SKIPPED / EXPIRED) release the quote's
   budget, membership-bonus and exposure reservations through Reward Engine primitives and
   set the quote to CANCELLED, but only while the quote is still OPEN and
   `reward_quotes.source_started_at IS NULL` (protected start is left untouched).
7. `verifyServerSignal` for AdsGram reports `authenticity: UNVERIFIED`,
   `authenticationMethod: NONE`, `authenticationStrength: NONE` and
   `monetaryAuthority: false`. The Reward URL ingestion path stores evidence and correlates
   best-effort (more than one candidate session yields AMBIGUOUS) and can never credit money.
8. The official `@adsgram/react` 1.0.2 SDK stays in `apps/miniapp`. `packages/ads` declares
   no React dependency and exports only the `ClientCompletionSignalPayload` data contract
   (`src/providers/adsgram/client-boundary.ts`).
9. `attemptVerifyAndIssueAdReward` calls `issueAdReward` from `@alex-rewards/rewards`; that
   export is delivered by the Reward Engine work item and is the only path that posts money.

## Clarification - Phase 11 wiring, correction and certification (2026-09-25)

10. **Quote/session FK direction correction.** Earlier Phase 11 drafts described retaining
    `ad_sessions.reward_quote_id` as authority. Spec V1.3 requires the opposite and that is
    what is implemented: `reward_quotes.ad_session_id` is the single authoritative pointer, it
    is unique (`reward_quotes_ad_session_uidx`), and for `source_type = 'AD'` the database
    requires `source_id = ad_session_id`. `ad_sessions.reward_quote_id` remains only as a
    **compatibility mirror** dual-written on authorize/issue; Phase 11 domain reads must use
    `reward_quotes.ad_session_id`. Authorization creates both rows in one transaction using
    pre-generated UUIDs.
11. **Migration 0030 UUID defect fixed before first apply.** The drafted seed rows used
    identifiers containing non-hexadecimal characters (`…00000000ads1`, `…mf01`, `…mf02`,
    `…unit`, `…lim1`, `…lim2`), which PostgreSQL rejects outright, so the migration could never
    have applied. They were replaced with valid hex identifiers (provider `…00000000ad51`,
    manifests `…000000000f01` / `…000000000f02`, ad unit `…000000000a11`, limit rules
    `…0000000011a1` / `…0000000011a2`) and `ADSGRAM_PROVIDER_ID` in `packages/ads/src/constants.ts`
    was updated to match. No seeded value, limit, status or clarification count changed.
12. **Session state persistence bound parameters positionally.** `persistSessionState` passed
    four parameters regardless of which assignments were built, so any state without a
    timestamp column (or with no failure code) left a placeholder unused and PostgreSQL could
    not infer its type. Parameters are now numbered as they are bound. This was a defect, not a
    rule change.
13. **API surface.** `v1/ads/*` requires an active Phase 3 access session; the ad session id is
    a path locator and every request is re-checked against the authenticated user server-side.
    Requests carrying reward-authority fields (any amount, bonus, verification or ledger field)
    are refused with `400` before any domain call. The AdsGram Reward URL endpoint
    (`GET /webhooks/adsgram/reward`) is unauthenticated by provider design, returns one uniform
    `{ accepted: true, rewardCredited: false }` body for every outcome so it cannot be used as
    an oracle, and fails closed if its Redis throttle is unavailable. It reuses
    `AUTH_RATE_LIMIT_WINDOW_SECONDS` / `AUTH_RATE_LIMIT_MAX`; a dedicated webhook limit remains
    OWNER_DECISION_REQUIRED.
14. **Certification uses a test-only approved provider.** Proving that the monetary gate is
    provider-neutral requires at least one provider that passes it, but AdsGram must stay
    BLOCKED in all production data. The `HARNESS_CERT` provider therefore exists only inside
    `packages/ads/test/harness.ts` and is registered in the compile-time registry only for the
    duration of a test run. No migration, seed or runtime path ships it.
15. **AMBIGUOUS correlation is tested directly.** The partial unique index
    `ad_sessions_one_active_per_user_provider_idx` covers exactly the live states that
    correlation candidate lookup searches, so ingestion can never find two candidates. The
    ambiguity refusal is therefore asserted at the gate itself: an `AMBIGUOUS` provider signal
    against the APPROVED `HARNESS_CERT` provider still refuses money.

## Clarification - Phase 12 Mini App read APIs (2026-09-25)

16. **A missing ledger account is an authoritative zero, not an unknown.** `GET /v1/me/balances`
    reads `ledger_accounts` / `ledger_account_balances` with SELECT only and never calls
    `getOrCreateLedgerAccount`: asking for a balance is not a financial event. A user with no
    account for a bucket is reported as `READY` with `amountAtomic: '0'`, because the ledger has
    genuinely never credited it. A bucket that could not be read is `UNAVAILABLE`, which is a
    different statement the client must not render as a balance.
17. **Lifetime earned comes from matured reward events.** `readUserLifetimeEarned` sums
    `reward_events.amount_atomic` where `state = 'AVAILABLE'` for the asset, so CREATED/PENDING
    and REVERSED rewards are excluded. It is read separately from the three spendable buckets
    and may be `UNAVAILABLE` on its own; an unreadable history never degrades a readable balance.
18. **Home is partially statused.** Every `GET /v1/me/home` domain carries its own
    `{ status, data, errorCode }`. A domain that throws becomes `UNAVAILABLE` / `READ_FAILED`,
    a domain that legitimately has nothing becomes `EMPTY` / `NO_DATA`, and the response still
    returns 200 with the domains that could be read honestly.
19. **Tasks and referrals report `ENGINE_NOT_ENABLED`.** `packages/tasks` and
    `packages/referrals` remain Phase 1 boundary shells, and no approved phase writes
    `user_task_progress`, `referral_codes` or `referral_edges`. `GET /v1/tasks` and
    `GET /v1/referrals/summary` therefore answer `UNAVAILABLE` with `ENGINE_NOT_ENABLED` rather
    than an empty `READY` list, which would assert that a working engine simply has nothing to
    offer. No mission engine behaviour is implemented in this phase.
20. **AdsGram stays BLOCKED on the user-facing surface.** `GET /v1/ads/earn-summary` reuses the
    provider-neutral monetary gate and reports `productionMonetaryStatus` and the refusal reason
    codes unchanged. The card is assembled field by field from
    `getEarnSummaryForUser`, exposes only `ad_units.client_config.blockId` (never
    `server_config`, credentials, revenue or clarification detail), and reading it never
    authorizes a session or moves money. Remaining opportunities are computed from the
    authoritative `ad_daily_counters` against ACTIVE `provider_limit_rules` versions; a
    dimension with no ACTIVE rule is reported as `configured: false` rather than given an
    invented cap.
21. **Wallet ownership config keys added to the API.** `WALLET_TON_PROOF_DOMAIN`,
    `WALLET_CHALLENGE_TTL_SECONDS`, `WALLET_PROOF_MAX_AGE_SECONDS`,
    `WALLET_PROOF_MAX_FUTURE_SKEW_SECONDS`, `WALLET_PROOF_RATE_LIMIT_WINDOW_SECONDS` and
    `WALLET_PROOF_RATE_LIMIT_MAX` have local/test fixture defaults only and must be set
    explicitly outside local/test; local ton_proof domains are rejected for staging/production.
    The accepted wallet network is `WITHDRAWAL_NETWORK_CODE` — a wallet may only be bound on the
    chain payouts use — and the 24h post-change withdrawal cooldown stays the fixed V1.2 value
    rather than becoming configurable.
22. **Locale and payout privacy are written through PATCH /v1/me/settings.** Locale updates
    `users.preferred_locale` and `user_settings.locale` in one transaction so the login-time
    projection and the settings row cannot disagree. `publicPayoutIdentityMode` accepts only
    `SHOW_USERNAME` | `HIDE_IDENTITY`. Marketing notification preferences remain read-only on
    this surface in Phase 12, and `security_notifications_enabled` is reported as always true
    because the schema forbids disabling it. Terms/Privacy links are optional public config
    (`NEXT_PUBLIC_TERMS_URL` / `NEXT_PUBLIC_PRIVACY_URL`) and degrade honestly when unset.
    Support tickets and account deletion requests use migration 0010 tables with ownership
    isolation; deletion is a review request (ticket + append-only event) only — never immediate
    anonymization, balance mutation, or ledger/audit deletion.

## ADR-023 — Phase 13 Owner Admin WebAuthn primary + recovery + Admin API

**Status:** Implemented on packages/auth + packages/contracts + packages/ads + apps/api
Admin HTTP surface under `v1/admin/*`. Operational WebAuthn RP ID remains
`OWNER_DECISION_REQUIRED`. Does not unlock AdsGram monetary APPROVED while clarifications
are open, does not silently flip `PAYOUT_DISPATCH_PAUSE`, and does not start Phase 14.
Historical Phase 13 high-impact confirmation / cookie-token / economics semantics are subject
to independent remediation (see `docs/PHASE_13_INDEPENDENT_REVIEW_REMEDIATION.md` when present).

### Decisions

1. **Factor hierarchy:** WebAuthn/Passkey is primary; password+TOTP is fallback (both
   factors required together); recovery codes are single-use emergency login. TOTP alone
   never authenticates.
2. **Independence:** Owner Admin sessions (`admin_sessions`) are independent of Telegram
   Mini App user `AccessSession` / access JWTs. `AdminSessionGuard` refuses Telegram-shaped
   tokens.
3. **WEBAUTHN is supported:** `assertNoUnsupportedActiveCredentials` no longer treats
   `WEBAUTHN` as blocking. Unknown ACTIVE types still fail closed.
4. **Challenges:** Migration `0031_phase13_admin_webauthn_challenges.sql` stores one-time,
   expiring challenges (REGISTRATION / AUTHENTICATION / REAUTH). No production RP ID is
   seeded in SQL.
5. **RP config:** `ADMIN_WEBAUTHN_RP_ID` / `ADMIN_WEBAUTHN_ORIGIN` / `ADMIN_WEBAUTHN_RP_NAME`
   have LOCAL/test fixture defaults only; staging/production fail closed when unset or when
   local fixture hosts are inherited.
6. **CSRF:** Cookie mode (`admin_session`, HttpOnly, SameSite=Strict) requires Origin match
   against configured admin/CORS origins. Bearer Authorization is allowed for tests and
   skips cookie CSRF.
7. **Recovery:** codes are cryptographic, hashed (`sha256Hex("admin-recovery:" + normalized)`),
   never logged in plaintext; rotate soft-consumes unused rows with `consumed_source=SYSTEM`.
8. **Libraries:** `@simplewebauthn/server@13.2.2` in `@alex-rewards/auth`;
   `@simplewebauthn/browser@13.2.2` pinned for `@alex-rewards/admin` (Phase 13 Admin Web UI).
9. **Admin HTTP APIs (Phase 13):** Control/read surface under `v1/admin/*` (OWNER-only via
   `AdminSessionGuard`). No direct balance editor. Review Queue actions call control-center /
   domain wrappers and never ledger-write alone. Policy Center accepts typed families only
   (arbitrary JS/SQL/eval refused). Provider limit changes are versioned and cannot set
   non-hard scopes above `PROVIDER_HARD`. AdsGram monetary `APPROVED` requires closed
   clarification register (`refuseProviderMonetaryApprovalWithoutClarification`). Founder
   grant remains membership-only (zero money). Economics separates ESTIMATED vs SETTLED;
   unconfigured exposure is `UNAVAILABLE`. High-impact mutations require reason +
   `expectedVersion` + recent reauth; confirmation bindings invalidate on payload change.
   `PAYOUT_DISPATCH_PAUSE` may be displayed and Owner-changed with full ceremony, but silent
   flip is refused; Phase 10 baseline is not auto-changed.

## ADR-024 — Phase 16 post-grant AD reversal for Mission rewards

**Status:** OWNER_POLICY_REQUIRED

When a contributing AVAILABLE AD reward is later reversed **after** a Mission claim has already
been GRANTED and Mission money issued, Phase 16 does **not** automatically cascade-reverse the
Mission reward. Production activation of monetary `VALID_AD_COUNT` missions remains blocked until
the Owner approves a cascade / non-cascade policy. Non-AD monetary missions (e.g. DAILY_LOGIN)
may still be issued in synthetic LOCAL/STAGING tests.

## Clarification — Phase 20 Step 4B Owner-approved Closed Beta policy (2026-10-02)

Owner approved the Closed Beta Risk / Trust / Eligibility profile recorded in
`packages/fraud/policy/phase20-closed-beta-owner-approved.json` (`activationAuthorized=false`).

Key approved values: Risk thresholds 20/50/75; weights OPEN_HIGH=55, OPEN_CRITICAL=80,
CONFIRMED=60, SHARED_PAYOUT=35, SHARED_DEVICE=25, SHARED_NETWORK=20, COUNTRY_CHANGED=15;
actions LOW/MEDIUM=MANUAL_REVIEW, HIGH=HELD, CRITICAL=WITHDRAWAL_BLOCKED; history signals
omitted (`signal_params={}`). Trust equal weights 25/25/25/25 with minDays 1/1 and minCount 1/1;
state thresholds 25/50/75. Eligibility: WITHDRAWAL=ACCOUNT_STATE+RISK+FEATURE_FLAG;
AD=ACCOUNT_STATE+RISK; MISSION=ACCOUNT_STATE+FEATURE_FLAG; TASK=ACCOUNT_STATE;
REFERRAL_ACTIVATION/MEMBERSHIP_CLAIM omitted.

This clarification does **not** authorize staging/ops ACTIVE policy activation, Railway deploy,
production monetary, AdsGram monetary, payout resume, TON broadcast, signer, or Mainnet.
`P20-GAP-009` remains OPEN / OWNER_APPROVED / READY_FOR_STAGING_ACTIVATION and still blocks
Closed Beta until a separate staging activation ceremony.

## Clarification — Phase 20 Step 4B.1 runtime decoupling (2026-10-02)

The Owner-approved Closed Beta policy JSON remains canonical at
`packages/fraud/policy/phase20-closed-beta-owner-approved.json` with
`activationAuthorized=false`. Step 4B.1 removes it from the `@alex-rewards/fraud` runtime
export graph: no `readFileSync` / Phase20 artifact load on normal package import. Tests and
`pnpm phase20:step4b:policy-check` load the JSON explicitly. Staging activation remains
unauthorized.

## Clarification — Phase 20 Step 4C staging activation preflight (2026-10-02)

Read-only discovery of staging `risk_rule_versions` / `trust_rule_versions` /
`eligibility_policy_versions` completed via Railway SSH tunnel with
`default_transaction_read_only=on`. All three tables were empty; proposed next versions
are 1/1/1. Canonical approved artifact remains `activationAuthorized=false`. No staging
mutation, Railway change, or policy activation occurred. See
`docs/PHASE_20_STEP4C_STAGING_POLICY_ACTIVATION_PREFLIGHT.md`.

## Clarification — Phase 20 Step 4C.1 preflight path + withdrawal pause seed plan (2026-10-02)

Fixed Step 4C preflight path resolution so artifact/snapshot/git resolve from
`packages/fraud` vs repo root correctly. Fresh read-only staging discovery again
showed empty Risk/Trust/Eligibility tables (proposed versions 1/1/1). Documented
engine mismatch: Withdrawal Engine treats missing `WITHDRAWAL_REQUESTS_PAUSE` as
not-paused; Eligibility fails closed. Recommended separate Owner-authorized STAGING
seed `enabled=true` + `feature_flag_versions` v1 — **not executed** in 4C.1.

## Clarification — Phase 20 Step 4C.2 two-commit preflight evidence seal (2026-10-02)

Preflight evidence uses a two-commit ceremony:

1. **TOOLING_HEAD** — seals path hygiene, repository-relative snapshot serialization, and
   clean-tracked-source enforcement before live discovery.
2. **EVIDENCE_HEAD** — later commit storing the regenerated snapshot/docs.

The snapshot `sourceCommit` equals TOOLING_HEAD only (never self-referential EVIDENCE_HEAD).
Absolute personal filesystem paths and credentials must not appear in committed snapshots.

## Clarification — Phase 20 canonical runtime cutover + Step 4C activation (2026-10-02)

Owner authorized promoting LOOTRA to the canonical Railway application runtime via stable
branch `production-runtime` at RUNTIME_HEAD `b9dd700de428498493fb6e497ec16901684532c0`,
while keeping application `DEPLOYMENT_ENV=staging` and all monetary safety gates closed.

After runtime deploy proof and fresh empty-table preconditions, Owner-authorized staging DB
ceremony COMMITTED:

- `WITHDRAWAL_REQUESTS_PAUSE/STAGING=true` + `feature_flag_versions` v1 (admin/audit NULL bootstrap)
- ACTIVE Risk/Trust/Eligibility v1 from `packages/fraud/policy/phase20-closed-beta-owner-approved.json`

Controlled post-validation passed. `P20-GAP-009` closed as REMEDIATED /
OWNER_APPROVED / STAGING_ACTIVE / CONTROLLED_VALIDATION_PASS.
`P20-GAP-017` was OPEN at Step 4C closure. Production money, payout resume, signer, TON,
Mainnet, and AdsGram monetary enablement remain unauthorized.

See `docs/PHASE_20_CANONICAL_RUNTIME_CUTOVER_AND_STEP4C_ACTIVATION.md`.

## Clarification — Phase 20 Step 5 mission/referral Owner content scope (2026-10-02)

Owner decision:

`PHASE20_CONTENT_SCOPE = FRIENDS_EXISTING_STAGING_NON_MONETARY_ACCEPTED__MISSIONS_DEFERRED_NO_LIVE_CONTENT`

**Friends / Referral:** Accept pre-existing staging Referral rule v1 + code policy v1 for
**non-monetary** Closed-Beta validation only. Referral edge activation is a state transition;
Referral money remains blocked by `REFERRAL_REWARD_PAUSE/STAGING=true`.

**500 bps:** `base_rate_bps=500` on the pre-existing staging rule is a **staging placeholder**,
not production, real-money beta, Phase 21, or public monetary launch rate approval.

**Missions / Tasks:** `MISSIONS_SCOPE = DEFERRED_NO_LIVE_CONTENT`. No ACTIVE mission publish in
Phase 20. Mission producers lack a Phase 20 approved-tester cohort filter; global publish would
exceed Closed-Beta scope. `MISSION_REWARD_PAUSE/STAGING` remains **MISSING** (not seeded).

`P20-GAP-017` status: **DEFERRED / OWNER_SCOPED_FOR_PHASE20** — blocks Closed Beta **NO**,
real-money **NO**, archive **NO**. Phase 20 gate: `HOLD_FOR_FINAL_ACCEPTANCE_REVIEW`.

See `docs/PHASE_20_STEP5_MISSION_REFERRAL_SCOPE_DECISION.md` and updated
`docs/PHASE_20_CONTROLLED_CONTENT_PROPOSAL.md`.

## Clarification — Phase 20 final acceptance + CLOSED_BETA archive (2026-10-02)

`PHASE 20 CLOSED BETA = PASS / ARCHIVED`.

- **CANONICAL_ACCEPTED_SOURCE_COMMIT:** `b8135c2a94cf5939371100cdbbf2316ba2eeb5e8`
- **CANONICAL_RUNTIME_HEAD:** `production-runtime @ b9dd700de428498493fb6e497ec16901684532c0` (unchanged by archive)
- **Archive:** `PHASE_20_CLOSED_BETA` stamp `20261002-053037`
- **Meaning:** Closed Beta / non-monetary controlled validation PASS — **not** real-money, AdsGram monetary, Mainnet, payout, or Phase 21 readiness
- **Real-money blockers remaining OPEN:** P20-GAP-001..006, P20-GAP-011 (count = 7)
- **Phase 21:** NOT STARTED / NOT AUTHORIZED

Final acceptance/archive ceremony performed no operational Railway/DB mutation.

See `docs/PHASE_20_ACCEPTANCE_REPORT.md`.

## Clarification — Phase 21 Step 1 Mainnet micro-launch foundation (2026-10-02)

Owner authorized Phase 21 **engineering** start on branch `phase21-mainnet-micro-launch`
(base `547117e`). Step 1 is SOURCE/TEST/READINESS only.

- `PHASE21_STATUS=IN_PROGRESS`
- `PHASE21_GATE=BLOCKED_FOR_MAINNET_PROVISIONING`
- `PHASE21_MAINNET_ENABLED=NO` (default; never inferred from NODE_ENV/Railway/branch)
- Phase 10 Testnet gates preserved; Phase 21 is an explicit Mainnet authority layer
- Production signer / Hot Wallet / funding / live payout / archive **not** authorized
- `CONTROLLED_MAINNET_WITHDRAWABLE_BALANCE_SOURCE=BLOCKED_OWNER_DECISION`
- Phase 20 real-money gaps remain OPEN; mapping in `docs/PHASE_21_REAL_MONEY_BLOCKER_MAPPING.md`

See `docs/PHASE_21_MAINNET_MICRO_LAUNCH_PLAN.md`.

