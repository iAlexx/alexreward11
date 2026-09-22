# Owner admin operational database identity (M1-A.1)

**Status:** DESIGN — operational default-deny is **implemented** in code.
**Operational readiness:** **DESIGN READY — TRUST ESTABLISHMENT BLOCKED**.
**Related:** FS-01, ADR-019, ADR-021, `docs/OWNER_ADMIN_BOOTSTRAP_DESIGN.md` (F1–F3, P1 channel-binding, P2).

Endpoint trust is a **mandatory M1 prerequisite**. It is not deferred.

---

## Implemented policy (code — today)

All existing Owner-auth entry points refuse `alex_rewards` via
`assertOwnerAuthOperationalDefaultDeny`. Cluster id and confirm literals are
**not** approval.

---

## F3 — External root of trust for provenance

### Root

The **Owner ceremony seal** (offline, witnessed) is the external root. It commits to:

1. Bootstrap Ed25519 public key (`key_id`, pubkey bytes, SHA-256 fingerprint).
2. Endpoint profile id + canonical profile digest (JCS or SHA-256 of normalized profile file).
3. Ceremony metadata (ceremony_id, witnesses, time).

Runtime trust stores and deploy artifacts are **derivatives**. They are accepted
only if their digests **match the seal**.

### How the root is initially established

1. Alex generates the keypair offline.
2. Witnesses observe public-key fingerprint and profile digest.
3. Seal is written to Owner-controlled offline media (and optionally a second
   geographically separate copy).
4. A **deploy derivative** (trust-store file / sealed config) is produced from the
   seal under Owner supervision.
5. Redeem hosts mount the derivative **read-only** and verify
   `digest(derivative) == seal_recorded_digest` (or Ed25519 signature by a
   **separate** Owner config-signing key recorded in the same seal — Owner choice).

Until step 3–4 exist, trust establishment is **BLOCKED**.

### Detecting unauthorized replacement of config **and** checksum

An attacker who replaces **both** the config file and a naive local checksum
file on one host defeats single-channel integrity.

**Required dual-channel detection (pick at least one Owner-approved pair):**

| Channel A (runtime) | Channel B (independent) |
| --- | --- |
| Trust-store file on redeem host | Seal digest checked from Owner offline media / ceremony printout at redeem time (human compare) |
| Trust-store file | Signature by Owner config-signing public key embedded in **immutable** first-boot firmware/HSM verify-only slot |
| Trust-store file | CI/CD artifact attestation that itself is gated by Owner-held release key distinct from app deploy bot |

Application behavior: if Channel A is present but Channel B cannot be satisfied
per profile policy → **fail closed**. Do not “trust A alone” in production profiles.

### Who can alter what

| Surface | Who can alter | Mitigation |
| --- | --- | --- |
| Ceremony seal (offline) | Alex (+ physical custody) | Offline; not on app servers |
| Deploy artifact / trust store on host | Deploy operators, root on host | Read-only mount; dual-channel match to seal; host hardening |
| Runtime process env | Process supervisors | Must not override pinned profile fields; ignore untrusted env for pins |
| Database contents | DB roles / superuser | **Not** a source of pubkey pins; least privilege |

---

## Mandatory PostgreSQL TLS

### Normative contract (no ambiguity)

All of the following are required for any operational bootstrap redeem
connection. They are **not** alternatives to each other.

1. **TLS required** — reject plaintext and modes that skip verification.
2. **Mandatory certificate-chain verification** — validate the server certificate
   chain to an **Owner-approved trust anchor** (CA certificate / CA bundle
   recorded in the ceremony seal and endpoint profile).
3. **Mandatory hostname verification** — verify the peer identity against profile
   `tls_server_name` (DNS SAN / CN match per the client library rules). Not
   optional.
4. **Owner-approved trust anchor** — the CA (or CA set) is established in the
   seal; runtime may only use the seal-matched derivative. Application DB
   contents are not the trust-anchor authority.
5. **Optional additional SPKI pinning** — if and only if the chosen client
   implementation supports SPKI (or equivalent public-key) pinning **securely
   and in addition to** (1)–(3). SPKI matching MUST NOT silently substitute for
   required chain or hostname verification.
   **v1 Owner decision (2026-09-22): SPKI = NO.** Explicitly supplied
   `spki_sha256_hex` / `spkiSha256Hex` must be **refused** (fail closed) — never
   ignored, stripped, or treated as satisfied. Mandatory CA chain + hostname
   verification remain required without SPKI.
6. **Fail closed** if any selected verification feature is unavailable in the
   runtime (missing CA file, hostname verify API absent, requested SPKI pin
   unsupported by the client build, etc.). Do not continue with a weaker subset.

### Exact supported client verification mechanism (M1 design target)

| Mechanism | Role |
| --- | --- |
| Node `pg` passes `ssl` as Node.js `tls.ConnectionOptions` (not libpq `sslmode`) with **`rejectUnauthorized: true`**, Owner CA PEM in `ca`, and `servername` = profile `tls_server_name` | **Required** — chain verify + hostname verify via Node default `checkServerIdentity` |
| libpq-compatible `sslmode=verify-full` semantics when a libpq client is used | **Required** equivalent (bootstrap URL must not carry conflicting `sslmode`) |
| Additional SPKI pin | **Unsupported in v1 (G5=NO)** — refuse if configured |

**Note:** Setting `servername` alone without `rejectUnauthorized: true` does **not**
enforce hostname verification. Isolated `tls.connect` tests exercise this adapter;
they do **not** mean operational PostgreSQL TLS is configured.

### Supplementary only

`expected_database_name` and `expected_system_identifier` are checked **after**
TLS success. They never authorize alone and never replace TLS identity.

---

## Pre-mutation checklist (operational)

1. Seal-matched provenance (pubkey + profile) via dual-channel policy.
2. Grant parse: duplicate-key reject, strict schema, RFC 8785 JCS, Ed25519.
3. Hard `exp`; `iat` skew ≤60s early only.
4. TLS: chain + hostname + Owner trust anchor (+ optional SPKI if configured).
5. DB name + system_identifier (supplementary) + least-privilege role.
6. Owner redemption PoP + enrollment-channel proofs + ticket
   (`docs/OWNER_ADMIN_BOOTSTRAP_DESIGN.md` §2.9).
7. M0 seat / history rules (preflight).
8. Interactive credentials **outside** TX (same channel process); short final TX
   revalidate (incl. `sig_channel_cred`) + atomic commit.

---

## Default-deny vs bootstrap

Existing Owner-auth APIs stay default-denied. Bootstrap redeem is a separate
stricter path. Lifting login/reauth deny is a separate Owner authorization.

## Intent literal

`I_CONFIRM_OWNER_ADMIN_AUTH_ON_ALEX_REWARDS` = intent only, never identity.
