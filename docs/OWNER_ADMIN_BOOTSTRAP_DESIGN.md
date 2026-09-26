# Owner admin bootstrap design — M1-A.1 (Option C)

**Status (current):** Design complete for independent review; **local Stage B
implementation exists** (isolated tests / ephemeral test keys). **Operational
first-Owner trust establishment remains BLOCKED** (Checklist **B** / **D**).
**Historical note:** Earlier revisions of this document said “not implemented”
while Stage B local work was still unauthorized; that referred to production
trust establishment and pre-authorization code landing — **not** a claim that
local Stage B remains absent after Owner authorization (ADR-021 Stage B
clarification 2026-09-21; checklist §C).
**Provisional direction:** Option C — Owner-held offline, one-time, expiring enrollment grant.
**Operational readiness:** **DESIGN READY — TRUST ESTABLISHMENT BLOCKED**.
**Remediation:** M1-A.1 F1–F3, P2, P1 channel-binding, and final credential-request binding addressed.
**Related:** ADR-019, ADR-020, ADR-021, `docs/OWNER_ADMIN_DB_IDENTITY_DESIGN.md`,
`docs/M1_A1_THREAT_MODEL.md`, `docs/M1_A1_TRUST_ESTABLISHMENT_CHECKLIST.md`,
`docs/M1_A1_IMPLEMENTATION_PLAN.md`.

Option C is a **provisional design direction**. It is **not** an assertion that the
required trust anchor already exists. Until the Owner independently establishes and
pins the bootstrap verification public key under a witnessed ceremony, operational
first-Owner enrollment remains refused.

---

## 1. Trust boundary

### 1.1 Who independently establishes Alex as the legitimate initial Owner?

**Outside the application.** The application never decides that Alex is Owner by
inspecting UUIDs, Telegram IDs, DB names, or env vars.

The legitimate initial Owner is established by a **human, out-of-band ceremony** that:

1. Identifies Alex as the sole rightful control-plane Owner for this deployment.
2. Creates or designates an Owner-held **bootstrap signing keypair** (Option C).
3. Records a **witnessed** public-key registration into a **trusted configuration
   provenance** store whose **external root of trust** is defined in §1.4 and
   `docs/OWNER_ADMIN_DB_IDENTITY_DESIGN.md`.

Until that ceremony completes and the pinned public key is provisioned under
Owner-approved procedures, the trust anchor is **absent**.

### 1.2 What evidence establishes that authority?

| Evidence | Role |
| --- | --- |
| Witnessed ceremony record (who, when, what was sealed) | Human establishment of Alex as initial Owner |
| Bootstrap public key fingerprint + algorithm + `key_id` | Verifier for grant signatures **and** redemption PoP (§2.9) |
| Trusted configuration provenance under external root (§1.4) | Where pubkey + endpoint profile are bound |
| Endpoint trust profile | Where redemption may occur |

**Insufficient alone (not claimant authentication):** Owner UUID, Telegram id,
database name, `system_identifier`, DB password, Recovery phrase, ops confirm
literal, vacant M0 seat, grant expiry, nonce uniqueness, email address,
`subject_display` / identity labels, possession of a grant file alone.

### 1.3 Who authorizes and witnesses initial public-key registration?

- **Authorizer:** Alex (human Owner), offline.
- **Witness(es):** at least one additional independent witness recorded in the
  ceremony log (exact set = Owner decision).
- **Registration:** publish only **public** key material + `key_id` + fingerprint
  into trusted provenance. Private key never enters the application, git, CI, or
  review archives.

### 1.4 External root of trust for provenance (F3 summary)

**Root:** the Owner-held **ceremony seal** — an offline, witnessed record that
commits to:

1. Bootstrap Ed25519 public key (`key_id`, raw pubkey, SHA-256 fingerprint).
2. Endpoint profile identifier and content digest.
3. Ceremony id + witness identities + timestamp.

That seal is the **external root**. Runtime trust stores and deploy artifacts are
**derivatives** that must match the seal. See
`docs/OWNER_ADMIN_DB_IDENTITY_DESIGN.md` for establishment, replacement detection,
operator capabilities, and TLS rules.

### 1.5 Can operators replace the pin?

| Actor | Replace pin / profile undetected? |
| --- | --- |
| Deploy operator | Only by also defeating seal-matching / dual-channel check → infra compromise |
| DB operator | **No** for the pin (not DB-authoritative); **yes** for raw SQL on superuser DB (§1.6) |
| App-only attacker | No |

Application **fail-closes** if provenance missing, seal mismatch, or unknown `key_id`.
No fallback to DB-stored keys.

### 1.6 Privileged DBA boundary

Cryptographic grants **cannot** prevent a fully privileged DBA from modifying an
uncontrolled database. M1 requires least-privilege roles + TLS pinning for the
application path, and treats superuser access as an **infrastructure** control.
If those controls are absent, operational bootstrap stays **BLOCKED**.

### 1.7 Infrastructure-level threats

Superuser bypass; silent dual replacement of artifact **and** checksum channel;
theft of offline private key; cloned DB without TLS pin; cloud IAM takeover.

---

## 2. Offline grant (Option C) — exact contract

### 2.1 Purpose

`purpose` MUST be exactly `FIRST_OWNER_ENROLLMENT`.
Any other purpose → refuse. Grants MUST NOT authorize replace, transfer,
Recovery, or general Owner-auth writes.

**Possession of a valid unconsumed grant is NOT sufficient to redeem.**
Redemption additionally requires Owner-bound proof of possession (§2.9).

### 2.2 Signed payload fields (strict schema)

Allowed keys **only** (unexpected fields → reject):

| Field | JSON type | Constraints |
| --- | --- | --- |
| `v` | number | Integer `1` only for M1; no floats; reject other versions |
| `purpose` | string | Exactly `FIRST_OWNER_ENROLLMENT` |
| `grant_id` | string | UUID canonical lowercase 8-4-4-4-12 hex |
| `deployment_env` | string | One of `production` \| `staging` \| `isolated_test` |
| `endpoint_profile_id` | string | Non-empty; max 128 chars; `[A-Za-z0-9._:-]+` |
| `owner_identity_ref` | object | See §2.3; no extra keys |
| `iat` | number | Integer Unix seconds (UTC); no exponent notation in JCS input |
| `exp` | number | Integer Unix seconds; must satisfy `exp > iat` and `exp - iat ≤ 3600` |
| `key_id` | string | Non-empty; max 128 chars; matches pinned key |
| `nonce` | string | Exactly 64 lowercase hex chars (256-bit) |

**Reject:** duplicate keys (parser must use a duplicate-key-rejecting JSON parse),
unexpected fields at any object level, wrong types, `null` where forbidden,
unsupported `v`, empty strings where non-empty required.

### 2.3 `owner_identity_ref` (strict)

Allowed keys only:

| Field | Type | Notes |
| --- | --- | --- |
| `kind` | string | Exactly `human_owner_ceremony` |
| `subject_display` | string | Display only — **not** authentication |
| `ceremony_id` | string | UUID lowercase |
| `evidence_fingerprint` | string | 64 lowercase hex (SHA-256 of sealed ceremony record) |

Optional single extra allowed key (still not authentication):

| Field | Type | Notes |
| --- | --- | --- |
| `intended_admin_email` | string | Must equal email on `admin_users` row created in the redeem TX |

### 2.4 Canonicalization — RFC 8785 (JCS) (F2)

1. Parse grant `payload` with a JSON parser that **rejects duplicate keys**.
2. Validate against the strict schema (§2.2–2.3); reject unknown fields.
3. Canonicalize the validated payload with **RFC 8785 JSON Canonicalization Scheme
   (JCS)**.
4. `payload_hash = SHA-256(JCS_UTF8_bytes)`.
5. Signature message:
   `ALEx-OwnerBootstrap-v1` || `0x00` || `payload_hash`
   (ASCII prefix + NUL + 32 raw hash bytes).

**Numeric policy:** `v`, `iat`, and `exp` MUST be JSON numbers that JCS encodes as
integers without fraction or exponent (e.g. `1710000000`, not `1.71e9`).
Implementations MUST reject non-integer numbers for these fields at schema
validation **before** JCS.

### 2.5 Signature envelope

Envelope allowed keys only: `payload`, `alg`, `key_id`, `sig`.

| Field | Constraint |
| --- | --- |
| `alg` | Exactly `Ed25519` |
| `key_id` | MUST equal `payload.key_id` |
| `sig` | base64url (no padding) encoding of raw 64-byte Ed25519 signature |
| `payload` | object per §2.2 |

Verification order:

1. Duplicate-key-rejecting parse of envelope; strict schema; no extra fields.
2. Load pinned public key for `key_id` from seal-matched provenance (fail if unknown/revoked).
3. JCS + hash + Ed25519 verify.
4. Time rules (§2.6), purpose/env/profile checks.
5. **Redemption PoP** (§2.9) — required before any mutation.
6. Replay / seat checks (§2.7, §4).

### 2.6 Time and expiry (F2)

Verifier clock: UTC.

| Field | Rule |
| --- | --- |
| `exp` | **Hard boundary.** Reject if `now > exp`. **No positive skew** on `exp`. |
| `iat` | Reject if `now < iat - 60` seconds (allow ≤60s early skew only). Reject if `iat > exp`. |
| Lifetime | Reject if `exp - iat > 3600`. Recommended `exp - iat ≤ 900` (15 minutes). |

Grant expiry alone is **not** claimant authentication.

### 2.7 Replay protections

1. `UNIQUE (grant_id)` consumption row; state `CONSUMED` only on successful commit.
2. Unique `nonce` (or `nonce_hash`) among accepted grants.
3. Reject `CONSUMED` / `REVOKED`; treat `now > exp` as expired.
4. M0 seat / history rules (§4).

Expiry, nonce uniqueness, and seat locks **do not** replace §2.9 PoP.

### 2.8 Private-key custody

Offline by Alex (air-gapped or HSM). Never in git, CI, app secrets, or review ZIPs.
Loss → new keypair + re-ceremony + revoke old `key_id`.
Revocation → remove pin; refuse that `key_id`; mark outstanding grants `REVOKED`.

### 2.9 Owner-bound redemption proof of possession (F1)

#### Problem

An attacker who steals a **valid, unconsumed** grant file could race the Owner to
redeem it if possession alone were enough.

#### Required defense

Redemption MUST prove control of the **Owner-held private key** registered at the
ceremony (same `key_id` as the grant, unless a distinct `redeem_key_id` was
registered in the seal — M1 default: **same key**).

#### Registration (ceremony)

Seal records:

- `key_id`, Ed25519 public key, fingerprint.
- Statement that this key authorizes **both** grant signatures and redemption
  challenge signatures for `FIRST_OWNER_ENROLLMENT`.

Substitution protection: pubkey only accepted from seal-matched provenance (§1.4);
DB cannot introduce an alternate redeem key.

#### Chosen approach (explicit)

**Securely stored verifier challenge state** + **ephemeral enrollment-channel
keypair** (cryptographic channel continuity) + atomic grant-consumption
tracking.

- Challenge records live in verifier-controlled durable storage (isolated DB
  table or sealed verifier store), never reconstructed from client-supplied
  fields alone.
- An **authenticated challenge token** (HMAC or AEAD over the same fields,
  keyed by verifier secret) MAY accompany the record for transport convenience,
  but acceptance still requires matching stored state and atomic one-time marks.
- M1 does **not** use a stateless-only challenge (client-held fields without
  server state) for first-Owner enrollment.
- Possession of a grant file, a stolen Owner `sig_redeem`, or a stolen
  `enrollment_ticket` is **insufficient** without continuous proof of the
  **same** enrollment-channel private key registered at attempt creation.

#### Enrollment-channel key (cryptographic continuity)

Before creating an attempt, the legitimate CLI/process:

1. Generates a fresh ephemeral **Ed25519** keypair `channel_sk` / `channel_pk`
   in process memory only.
2. Computes `channel_fp = SHA-256(channel_pk)` (32-byte digest, hex-encoded in
   APIs as lowercase hex).
3. **Never** writes `channel_sk` to disk, argv, env, logs, JSON stdout, review
   ZIPs, or git. Process exit / abort MUST zeroize `channel_sk` when feasible.
4. Registers `channel_pk` (and thus `channel_fp`) with the verifier as part of
   attempt creation. The verifier stores only `channel_pk` / `channel_fp` —
   never any channel private key.

All subsequent PoP and credential submissions for that attempt MUST prove
possession of the **same** `channel_sk`. A different process that only has the
grant, a captured Owner signature, or a captured ticket **cannot** complete
enrollment.

#### Challenge issuance (create + authenticate)

1. Redeemer authenticates endpoint trust (§3) and presents the grant envelope
   **plus** `channel_pk`.
2. Verifier checks grant signature + schema + time + env/profile (**no OWNER
   mutation yet**); validates `channel_pk` is 32 raw Ed25519 bytes (reject
   compressed/alternate encodings).
3. Verifier creates one **enrollment attempt**:
   - `attempt_id` — UUID v4
   - `challenge_id` — UUID v4
   - `issued_at` — verifier wall-clock **Unix seconds** (`uint64`), recorded
     exactly as used below (not client-supplied)
   - Bindings (immutable for this attempt): `grant_id`, `key_id` (from grant +
     seal pin), `endpoint_profile_id`, `deployment_env`, expected claimant
     subject (`admin_email` / ceremony subject from grant payload),
     **`channel_fp` / `channel_pk`**
4. Persist challenge state (status `OPEN`):

   | Field | Value |
   | --- | --- |
   | `challenge_id`, `attempt_id` | As above |
   | `grant_id`, `key_id`, `endpoint_profile_id` | Bound |
   | `channel_fp`, `channel_pk` | Bound at creation; immutable |
   | `issued_at` | Exact verifier Unix seconds |
   | `expires_at` | `issued_at + 300` (5 minutes hard for Owner PoP) |
   | `pop_status` | `PENDING` |
   | `enrollment_ticket_hash` | null until PoP succeeds |
   | `ticket_expires_at` | null until PoP succeeds |
   | `consumed_at` | null |

5. Reconstruct **exact** bytes the Owner must sign (verifier recomputes from
   **stored** fields only — includes channel fingerprint):

   ```text
   challenge_bytes = SHA-256(
     "ALEx-OwnerBootstrap-Redeem-v1" || 0x00 ||
     grant_id_utf8 || 0x00 ||
     challenge_id_utf8 || 0x00 ||
     attempt_id_utf8 || 0x00 ||
     key_id_utf8 || 0x00 ||
     endpoint_profile_id_utf8 || 0x00 ||
     channel_fp_hex_utf8 || 0x00 ||
     uint64_be(issued_at)
   )
   ```

6. Return to redeemer: `{ challenge_id, attempt_id, issued_at, key_id,
   endpoint_profile_id, channel_fp, challenge_bytes_hex }` (and optional
   authenticated challenge token). Client-supplied alterations of these fields
   are ignored on verify — only stored state is authoritative. `channel_sk`
   never leaves the CLI process.

#### Precise channel-signed messages

Define two channel proofs (Ed25519 over SHA-256 preimage, same encoding style):

**A. PoP-submit channel proof** (required with Owner `sig_redeem`):

```text
channel_pop_bytes = SHA-256(
  "ALEx-OwnerBootstrap-ChannelPop-v1" || 0x00 ||
  attempt_id_utf8 || 0x00 ||
  challenge_id_utf8 || 0x00 ||
  grant_id_utf8 || 0x00 ||
  channel_fp_hex_utf8 || 0x00 ||
  uint64_be(client_unix_time) || 0x00 ||
  nonce32_bytes
)
sig_channel_pop = Ed25519.Sign(channel_sk, channel_pop_bytes)
```

Freshness: verifier requires `|now - client_unix_time| ≤ 60` seconds **and**
`nonce32` unique per attempt (store seen nonces for the attempt; reject reuse).
`client_unix_time` and `nonce32` are submitted in the clear with the signature.

**B. Final credential-request signature** (binds the **complete** enrollment
request — not identifiers alone):

The channel key signs a domain-separated digest of the **entire** final
enrollment request. Identifier-only signatures are **rejected** by design.

**Public header** (RFC 8785 JCS of a strict object; reject duplicate keys,
unexpected fields, invalid types, `v ≠ 1`):

```json
{
  "v": 1,
  "purpose": "FIRST_OWNER_CREDENTIAL_SETUP",
  "grant_id": "<uuid>",
  "attempt_id": "<uuid>",
  "challenge_id": "<uuid>",
  "ticket_id": "<uuid>",
  "channel_fp": "<64 lowercase hex>",
  "intended_subject": "<exact claimant subject string bound at attempt create>",
  "credential_setup": {
    "password_encoding": "utf8",
    "totp_secret_encoding": "base32_nopad_uppercase",
    "totp_digits": 6,
    "totp_period_seconds": 30,
    "totp_algorithm": "SHA1"
  },
  "client_unix_time": 0,
  "nonce32": "<64 lowercase hex>"
}
```

`intended_subject` MUST equal the stored attempt claimant subject (grant /
ceremony binding). It is part of the signed request so identity substitution
breaks the signature.

**Secret tails** (length-prefixed; included in the signature preimage only;
**never** written to logs, audit rows, JSON diagnostics, or review archives):

```text
pwd_tail  = "pwd"  || 0x00 || uint32_be(len(password_utf8)) || password_utf8
totp_tail = "totp" || 0x00 || uint32_be(len(totp_secret_bytes)) || totp_secret_bytes
```

where `totp_secret_bytes` are the raw decoded secret bytes (not the display
string). Password and TOTP material travel only on the authenticated verifier
channel for this request; durable storage uses existing password-hash / TOTP
seal constructions — audit may record only non-reusable status codes.

**Exact signed message:**

```text
public_jcs = RFC8785_JCS(public_header_object)   // UTF-8 bytes
final_cred_preimage =
  "ALEx-OwnerBootstrap-FinalCredReq-v1" || 0x00 ||
  public_jcs || 0x00 ||
  pwd_tail || 0x00 ||
  totp_tail
final_cred_bytes = SHA-256(final_cred_preimage)
sig_channel_cred = Ed25519.Sign(channel_sk, final_cred_bytes)
```

Freshness: `|now - client_unix_time| ≤ 60` seconds; `nonce32` unique per
attempt and distinct from PoP nonces. Replaying `sig_channel_pop` is rejected
(wrong domain string). Verifier **reconstructs** `final_cred_preimage` from the
**actual received** public fields + password + TOTP bytes and verifies
`sig_channel_cred` under stored `channel_pk`. Any modification of identity,
ids, ticket, credential material, time, or nonce → signature failure → refuse.

#### PoP response verification

7. Owner signs `challenge_bytes` offline with the private key for `key_id`.
8. Redeemer submits:

   ```text
   {
     challenge_id, attempt_id, key_id,
     sig_redeem,
     client_unix_time, nonce32, sig_channel_pop
   }
   ```

9. Verifier loads stored state by `(challenge_id, attempt_id)` and **rejects** if:
   - unknown / mismatched pair
   - `now > expires_at` (hard; no positive skew on challenge expiry)
   - `pop_status ≠ PENDING` (already used, aborted, or superseded)
   - `grant_id` / `key_id` / `endpoint_profile_id` / `channel_fp` do not match
     stored bindings
   - grant already `CONSUMED` / `REVOKED` or seat no longer vacant (pre-check)
   - Ed25519 verify of `sig_redeem` over recomputed `challenge_bytes` fails
   - Ed25519 verify of `sig_channel_pop` over recomputed `channel_pop_bytes`
     with **stored** `channel_pk` fails, or freshness/nonce rules fail
10. On success, **atomically** transition:
    - `pop_status`: `PENDING` → `VERIFIED`
    - mint `ticket_id` (UUID) + `enrollment_ticket` (≥256-bit random; store
      only `SHA-256(ticket)` as `enrollment_ticket_hash`; plaintext returned
      once to this process)
    - bind ticket to `(attempt_id, grant_id, key_id, claimant_subject,
      endpoint_profile_id, channel_fp)`
    - set `ticket_expires_at` = `verified_at + 900` (15 minutes hard
      recommended; profile constant)
    - record PoP nonce as used
    - enter design state `AUTHORIZED` (**no** open DB enrollment transaction)

#### One-time use, replay, concurrency, cross-channel

| Attack | Required reject |
| --- | --- |
| Replay same `sig_redeem` | `pop_status` already `VERIFIED`/`CONSUMED` → refuse |
| Stolen `sig_redeem` submitted from **another** channel (no `channel_sk`) | `sig_channel_pop` missing/invalid → refuse; no ticket |
| Stolen ticket used from another channel | `sig_channel_cred` fails vs stored `channel_pk` → refuse |
| Legitimate Owner signature + grant presented on a different CLI process | Different/missing channel key → refuse (must start **new** attempt) |
| Substitute `channel_pk` after attempt creation | Immutable stored `channel_fp`; Owner bytes include original fp → refuse |
| Substitute `challenge_id` / `attempt_id` / `key_id` / profile | Stored binding mismatch → refuse |
| Concurrent attempts on same grant | At most **one** `OPEN`/`VERIFIED` attempt per `grant_id`; new attempt supersedes prior `OPEN` → `SUPERSEDED` (does **not** reassign channel); `VERIFIED` blocks siblings until abort/timeout |
| Cross-attempt: sign attempt A, submit under attempt B | Binding / bytes mismatch → refuse |
| Cross-grant: PoP for grant A used with grant B | Stored `grant_id` mismatch → refuse |

#### Credential submission (after PoP)

11. Password + TOTP are collected **interactively after** PoP success and
    **outside** any database transaction (TTY; same pattern as existing enroll)
    in the **same** process that holds `channel_sk`.
12. Credential submission MUST present the complete request:

    ```text
    {
      public_header,          // as signed; includes intended_subject + ids
      enrollment_ticket,      // plaintext ticket (not logged)
      password_material,      // TTY-sourced; not logged
      totp_material,          // TTY-sourced; not logged
      sig_channel_cred
    }
    ```

    Verifier checks, in order: ticket hash match; `pop_status = VERIFIED`;
    `now ≤ ticket_expires_at`; bindings unchanged including **`channel_fp`** and
    **`intended_subject`**; reconstruct `final_cred_bytes` from **received**
    fields and verify `sig_channel_cred`; freshness/nonce rules; then enter the
    short final TX. Failure at any step → no Owner row, grant unconsumed, no
    partial credentials.
13. Captured Owner `sig_redeem` alone cannot obtain a ticket (needs channel PoP).
    Captured ticket alone cannot register credentials (needs
    `sig_channel_cred` over the **full** request including credential tails).
    Identifier-only or credential-substituted requests fail closed.

#### First-use PoP replay vs unauthorized activation (residual risk)

| Event | Effect | Is unauthorized Owner activation? |
| --- | --- | --- |
| Replay of a **complete PoP submission** (`sig_redeem` + `sig_channel_pop` + same nonce/time) **after** `VERIFIED`/`CONSUMED` | Rejected by one-time `pop_status` / nonce | No |
| **First-use race:** attacker submits a **stolen complete PoP request** before the legitimate client | Attacker may win `PENDING→VERIFIED` and receive the ticket response; legitimate attempt is disrupted | **No** — ticket alone + no `channel_sk` cannot pass final credential binding; this is **attempt DoS / hijack to AUTHORIZED**, not account activation |
| Stolen **complete final credential request** (full public header + password/TOTP tails + `sig_channel_cred` + ticket) submitted first | May consume grant and create Owner with **those** credentials | **Yes — residual risk** if the entire request is captured (memory, compromised host, malicious proxy). Channel binding stops *substitution* and *cross-channel* use; it does **not** stop first-use of an unmodified stolen complete request |

**Do not claim** that client-generated `nonce32` uniqueness prevents a stolen
complete request from winning a first-use race. Nonce uniqueness only blocks
*reuse after acceptance*; the first accepted presentation of a valid signed
request wins. Mitigations for complete-request theft are out of band: process
memory protection, TTY-only secret entry, TLS to the verifier, no logging of
secret tails, short ticket lifetime, and operator procedure.

#### Final short transaction (resolve TX-order conflict)

**Do not** hold a database transaction open while waiting for human password/TOTP
input.

Order:

1. Preflight (read-only / short locks as needed): grant, seat, challenge,
   ticket, channel binding — no credential INSERT yet.
2. Interactive credential collection (no open enrollment TX).
3. **Final short transaction** — revalidate **all** authoritative conditions
   (including channel fingerprint + `sig_channel_cred` over the **reconstructed
   full request**), then atomically:
   - create `admin_users` + OWNER seat bind (M0)
   - store password/TOTP credentials for that `admin_user_id` only
   - mark grant `CONSUMED`
   - mark challenge `pop_status = CONSUMED`; invalidate ticket; clear/retain
     only non-secret audit fields
   - commit → state `ACTIVE`

Revalidation inside the final TX MUST include at least: seal-matched profile
still loaded; grant still valid-for-consume; M0 vacant-seat / history rules;
challenge `VERIFIED` and ticket match; **channel_fp unchanged**; claimant
subject unchanged; no concurrent CONSUME. Any failure → `ROLLBACK`; grant
remains unconsumed.

Session issuance only after `ACTIVE` commit.

#### Atomic state transitions (challenge / attempt)

```text
(none) --create(channel_pk)--> OPEN/PENDING
OPEN/PENDING --valid Owner PoP + channel_pop--> VERIFIED (ticket minted)
OPEN/PENDING --expiry|explicit abort|supersede--> ABORTED|SUPERSEDED|EXPIRED
VERIFIED --valid channel_cred + final TX success--> CONSUMED
VERIFIED --ticket expiry|explicit abort|final TX fail policy--> ABORTED
                                                     (grant unconsumed;
                                                      ticket invalidated)
```

No transition may **replace** `channel_pk` / `channel_fp` on an existing
attempt. Interrupted or aborted enrollment requires a **new** authenticated
attempt with a **new** ephemeral channel keypair — never silent channel
reassignment onto a prior attempt.

#### Cleanup / restart behavior

| Event | Behavior |
| --- | --- |
| CLI process exit before PoP | Attempt remains `OPEN` until `expires_at` or supersede; `channel_sk` lost → cannot complete; start new attempt |
| CLI restart after PoP (ticket issued) | Prior `channel_sk` gone → cannot prove channel; **abort** attempt (invalidate ticket); start **new** attempt — do not re-bind ticket to a new channel key |
| Explicit abort | `pop_status → ABORTED`; ticket hash cleared; grant unconsumed |
| Supersede by newer attempt on same grant | Prior `OPEN` → `SUPERSEDED`; prior channel binding discarded with that attempt |
| Review archives / logs | At most `channel_fp`, ids, status codes; **never** `channel_sk`, plaintext tickets, password/TOTP material, or reusable password/TOTP commitments |

#### What is NOT PoP / NOT channel binding

Grant file possession, expiry window, nonce uniqueness alone, M0 seat lock,
email string, `subject_display`, Telegram id, DB password, ops confirm literal,
possession of `enrollment_ticket` without `channel_sk`.

#### Equivalent alternative (Owner may select)

**Witnessed interactive redemption:** Owner and witness co-present; Owner signs
the same `challenge_bytes` (still including `channel_fp`); witness countersigns
a separate attestation bound to `challenge_id` + `attempt_id` + `channel_fp`.
Still requires Owner private-key signature **and** enrollment-channel continuity
above; witness alone cannot redeem. An alternative channel-continuity design is
acceptable only if it provides equivalent binding across attempt creation, PoP
submit, and credential submit.

#### Adversarial / protocol tests (mandatory in Stage B)

| Case | Expect |
| --- | --- |
| Valid grant, no / invalid `sig_redeem` | Refuse; no admin; grant unconsumed; `REDEEM_POP_MISSING_OR_INVALID` |
| Stolen PoP (`sig_redeem`) before first submit, attacker lacks `channel_sk` | Refuse; no ticket |
| Stolen ticket before credential submit, attacker lacks `channel_sk` | Refuse credentials |
| Legitimate Owner signature presented from a different channel/process | Refuse; requires new attempt |
| Concurrent attempts on same grant | One path; others refuse; at most one CONSUME; no channel reassignment |
| Channel-key substitution after create | Refuse (immutable `channel_fp` / Owner bytes) |
| Replay PoP after `VERIFIED` | Refuse; no second ticket |
| Capture valid ticket + `sig_channel_cred`; **replace password** material | Sig fail; no Owner; grant unconsumed; no partial credentials |
| Capture valid ticket + `sig_channel_cred`; **replace TOTP** material | Sig fail; no Owner; grant unconsumed; no partial credentials |
| Capture valid ticket + `sig_channel_cred`; **replace `intended_subject`** | Sig fail; no Owner; grant unconsumed; no partial credentials |
| Modified credential request submitted **before** legitimate request | Refuse modified; legitimate may still proceed if ticket unused; no partial state from attacker |
| Stolen **complete** final request (unmodified) first-use race | May activate with captured credentials — residual capture risk (document; not a substitution hole) |
| Stolen complete PoP first-use race | May steal attempt to `VERIFIED` (DoS); **not** activation without final request / `channel_sk` |
| Expired challenge (`now > expires_at`) | Refuse PoP |
| Restart / aborted enrollment (lost `channel_sk`) | Cannot continue; new authenticated attempt required |
| Failure between PoP success and final commit | Grant unconsumed; no OWNER; retry = new attempt |
| Final TX sees seat taken / grant consumed mid-flight | `ROLLBACK`; no partial credentials |
| Logs/audit after failed/successful enroll | No password, TOTP secret, ticket plaintext, or reusable verifier material |

---

## 3. Endpoint trust (mandatory M1) — see also DB identity doc

No operational mutation until endpoint profile verifies under seal-matched
provenance.

### 3.1 Profile fields

| Check | Requirement |
| --- | --- |
| `deployment_env` | Match grant + profile |
| Expected database name | Supplementary identity; match `current_database()` |
| Expected `system_identifier` | Supplementary only |
| PostgreSQL TLS | **Mandatory** chain + hostname + Owner trust anchor; optional extra SPKI; **no** downgrade (§3.3) |
| DB role | Least-privilege bootstrap role |
| Provenance | Seal-matched before use |

### 3.2 Pre-mutation order

1. Verify seal-matched provenance (pubkey + profile).
2. Parse/validate grant (JCS + Ed25519).
3. Enforce purpose/version/time/env.
4. Connect with mandatory TLS (§3.3 / DB identity doc).
5. Assert DB name, system_identifier (supplementary), role.
6. Complete §2.9 PoP → `enrollment_ticket` (no open enrollment TX).
7. Assert M0 seat/history rules (preflight).
8. Collect credentials interactively; then short final TX (§2.9).

### 3.3 TLS (normative summary)

- Require TLS. Reject `sslmode=disable`, `allow`, `prefer` without full verify.
- **Mandatory** certificate-chain verification to the Owner-approved trust
  anchor (CA).
- **Mandatory** hostname verification against `tls_server_name`.
- **Optional** additional SPKI pin only if the chosen client supports it
  securely — never a substitute for chain or hostname.
- Fail closed if a selected verification feature is unavailable.
- **No insecure fallback** if verify fails.

Details: `docs/OWNER_ADMIN_DB_IDENTITY_DESIGN.md`.

### 3.4 Least-privilege roles

| Role | Allowed |
| --- | --- |
| `alex_owner_bootstrap` | Narrow first-enrollment TX only |
| `alex_owner_auth` | Later login/reauth after separate FS-01 lift |
| Superuser | Infra-controlled; not an app trust anchor |

---

## 4. Enrollment state machine

| State | Meaning |
| --- | --- |
| `UNINITIALIZED` | No OWNER; vacant seat; no consumed first-enroll grant |
| `AUTHORIZED` | Grant + endpoint + **PoP** + **channel continuity** verified; ticket live; **no** enrollment TX held open |
| `CREDENTIAL_SETUP` | Interactive password+TOTP in **same** channel process; ticket + `sig_channel_cred` |
| `ACTIVE` | Short final TX committed; credentials + seat + grant `CONSUMED` |
| Aborted | Abort/supersede/expiry/restart without `channel_sk`; grant not consumed; **new attempt** required (no silent channel reassignment) |

Happy path:
`UNINITIALIZED` → (grant+endpoint+channel register+PoP) → `AUTHORIZED` →
`CREDENTIAL_SETUP` (interactive, no TX, same channel key) → short final TX →
`ACTIVE`.

| Condition | Action |
| --- | --- |
| Active Owner / held seat | Refuse — no silent reclaim/replace/transfer |
| Revoked binding, seat reserved | Refuse — transfer out of scope |
| Multi-holder OWNER history | Refuse — manual Owner resolution |
| Attacker has grant, no PoP | Refuse — F1 test |

---

## 5. Default-deny vs narrow bootstrap route

Existing Owner-auth APIs remain operationally default-denied.
Future `redeemOwnerBootstrapGrant` uses **stricter** seal+TLS+grant+PoP checks —
not a general ops unlock. No public self-registration. No hidden bypass.

Lifting login/reauth default-deny remains a **separate** Owner authorization after
`ACTIVE`.

---

## 6. Canonical test vectors (design — F2)

Stage B MUST ship fixtures (no private ops keys in fixtures — generate ephemeral
test keys in-harness):

1. **JCS golden:** fixed payload → exact JCS string → exact `payload_hash` hex.
2. **Sig round-trip:** ephemeral key signs envelope; verifier accepts.
3. **Parser negatives:** duplicate keys; unexpected field; wrong type; `v=2`;
   float `iat`; `exp` as string; truncated `nonce`; envelope extra field;
   `alg` ≠ `Ed25519`; mismatched envelope/`payload` `key_id`.
4. **Time:** `now = exp` accept; `now = exp+1` reject; `now = iat-61` reject;
   `now = iat-60` accept if other checks pass.
5. **PoP / lifecycle / channel / FinalCredReq:** missing/invalid `sig_redeem`;
   stolen PoP without channel key; stolen ticket; cross-channel signature;
   channel-key substitution; concurrent attempts; credential substitution
   (password/TOTP/`intended_subject`); PoP first-use DoS vs activation;
   restart/abort requiring new attempt (§2.9 table).

---

## 7. Current safe behavior (implemented today)

| Database | First enrollment | Replace / login / reauth |
| --- | --- | --- |
| Isolated `*_test` / `*_phaseN` | Allowed for local testing only | Gated |
| Operational `alex_rewards` | **Always refused** | **Always refused** |

---

## 8. Non-goals (M1)

Ownership transfer / lost-access recovery; WebAuthn primary; CO_OWNER; shipping
operational private keys; claiming DBA-proof security on uncontrolled DBs.

---

## 9. Readiness states (do not conflate)

| State | Meaning | Now |
| --- | --- | --- |
| **A. Design complete** | Docs/ADR reviewable | Largely yes; independent FinalCredReq design review still open (checklist §A) |
| **B. Trust anchor independently established** | Witnessed seal + production pubkey pin | **NO — BLOCKED** |
| **C. Local implementation ready** | Code+tests; **ephemeral test-only keys OK** | **YES — local only** (aligns with checklist §C: Owner-authorized Stage B local code + isolated harness evidence). Independent review acceptance of Stage B local implementation still open. **Does not** establish Checklist **B** or **D**. Structural validators (incl. later G1/G2/G8 ceremony schema helpers) are **not** authentic Owner provenance. |
| **D. Operational enrollment authorized** | Separate go-live | **NO** |

**Status transition (G7 remediation 2026-09-22):** This table previously said
state **C** = “**NO** (Stage B not authorized)”. That was accurate **before**
Owner authorized local Stage B (ADR-021 clarification 2026-09-21) and before
checklist §C marked local Stage B items complete. It is **not** accurate after
those events. State **B** / **D** remain **NO**. Overall label unchanged:
`DESIGN READY — TRUST ESTABLISHMENT BLOCKED`.

**Local Stage B** uses disposable test-only Ed25519 keys inside isolated
harnesses. That MUST NOT mark Checklist **B** or state **D** complete and MUST
NOT use production seal material.

**Report label:** `DESIGN READY — TRUST ESTABLISHMENT BLOCKED`
