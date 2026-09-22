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
9. **Mixed ACTIVE unsupported credentials (e.g. WEBAUTHN):** refuse enroll/replace
   (fail-closed); do not remove or simulate WebAuthn (`docs/OWNER_ADMIN_AUTH.md`).
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
