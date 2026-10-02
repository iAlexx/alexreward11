# M1-A.1 Implementation plan (Stage B — local)

**Status (current):** Local Stage B implementation/testing was Owner-authorized
(ADR-021 Stage B clarification 2026-09-21) and is reflected in checklist §C.
**Historical:** This file originated as **PLAN ONLY** while Stage B was “not
authorized yet” and stated “no code in this phase.” That historical planning
context is preserved here; it must not be read as the current code/status truth.
**Label:** `DESIGN READY — TRUST ESTABLISHMENT BLOCKED` (Checklist **B**/**D**).
**F1–F3 + P1/P2 + channel-binding + FinalCredReq:** design remediation
incorporated; local Stage B code paths exist under isolated_test constraints.
**P2 unchanged** in the original correction note below.

## Before Stage B

1. Independent review accepts F1–F3, P2, and P1 (incl. channel-binding).
2. Owner confirms Option C direction.
3. Explicit Owner text authorizing **local** Stage B only.
4. Understand: ephemeral **test-only** keys for isolated tests ≠ Checklist **B**.

## Proposed future files (unchanged intent)

| Area | Expected |
| --- | --- |
| Redeem + PoP + challenge store | `packages/auth/src/owner-bootstrap.ts`, CLI |
| Enrollment-channel key | Process-memory Ed25519; `sig_channel_pop` / `sig_channel_cred` |
| Enrollment ticket + final TX | Interactive creds outside TX; short atomic commit |
| JCS + schema | strict parser module; RFC 8785 |
| TLS client | verify-full / custom CA + hostname; optional SPKI add-on (P2) |
| FS-01 | keep; do not weaken general Owner-auth |
| Migration | `0026_…` grant consumption + challenge/channel state (no secrets) |
| Tests | PoP/channel lifecycle; JCS vectors; TLS fail; concurrency; M0 |

## Adversarial tests (must include)

- **F1:** valid grant, no `sig_redeem` → refuse, no residue.
- **P1 channel-binding + FinalCredReq:** stolen PoP before first submit;
  stolen ticket; cross-channel signature; concurrent attempts; channel-key
  substitution; restart/abort → new attempt; **credential substitution**
  (password / TOTP / `intended_subject`) under captured ticket+sig → refuse,
  no Owner / no consume / no partial credentials; modified request before
  legitimate; distinguish PoP first-use DoS vs activation; no secret tails in
  logs.
- **F2:** duplicate JSON keys; extra fields; `now > exp`; bad types.
- **P2/F3:** missing CA / hostname fail; SPKI-only without chain refused;
  sslmode downgrade attempt → refuse; unavailable verify feature → fail closed.
- Concurrent redeem with PoP; held seat; revoked reserved seat.
- Audit redaction; `channel_sk` absent from logs/archives.

## Local vs production keys

| Context | Keys | Marks complete? |
| --- | --- | --- |
| Stage B isolated tests | Ephemeral harness keypair (+ test channel keys) | **C** only (when done) |
| Production | Ceremony seal + offline private key | **B** then **D** |

## Rollback

Keep FS-01; feature absent without provenance; no general ops unlock.

## Remaining Owner decisions

Witness set; dual-channel pair; Owner CA trust anchor material; optional SPKI
add-on; grant lifetime ≤15m recommended; authorize Stage B local; later go-live
(**D**); later login FS-01 lift.

## Phase 21 Step 4A — production path status

Isolated Option C remains `ephemeral_isolated_test_only`. Production first-Owner claim uses a separate `owner-production-bootstrap` path with `CLAIM_EXISTING_ADMIN`. Operational ceremony is still blocked pending trust resources (witness, CA, Channel B, endpoint identity).

## Step 4A.1 status

Production path now requires `AuthenticatedProductionBootstrapTrust` and explicit production lifecycle functions. Isolated Stage B unchanged.
