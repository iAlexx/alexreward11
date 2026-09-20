# Owner admin bootstrap design (separately reviewable)

**Status:** DESIGN ONLY — not implemented.

**Related:** ADR-019, F-01 remediation.

**Operational readiness:** **BLOCKED** until an independently verifiable bootstrap
authority is approved and implemented.

## Problem

The local Owner admin auth CLI can enroll password+TOTP factors into
`admin_credentials` for an ACTIVE Owner UUID. Knowledge of that UUID plus
database write access (and an ops confirmation literal) is **not** proof of
Owner identity. Inventing a fake “bootstrap secret” in this codebase would not
be independently verifiable.

## Required properties of a future bootstrap

1. **Out-of-band Owner identity** established by a ceremony the Owner controls
   (examples for later Owner approval: hardware-backed attestation, dual-control
   ceremony with split custody, or Owner-held offline enrollment grant issued
   before production go-live).
2. **One-time, narrowly scoped enrollment authority** with explicit expiry,
   single-use consumption, and redacted audit provenance.
3. **Separation** from ordinary `enroll --replace` and from the ops confirmation
   literal (`I_CONFIRM_OWNER_ADMIN_AUTH_ON_ALEX_REWARDS`), which remains
   **intent-only**, never authentication.
4. **Fail closed** when bootstrap authority is missing, expired, consumed, or
   unverifiable.
5. **No** reliance on Telegram user id, Owner UUID alone, DB password alone, or
   Recovery confirmation phrase as enrollment authentication.

## Current safe behavior (implemented)

| Database | First enrollment (zero active credentials) | Replace / login / reauth |
| --- | --- | --- |
| Approved isolated `*_test` / `*_phaseN` | Allowed for local testing only | Allowed with gates; ACTIVE WEBAUTHN refuses replace |
| Operational `alex_rewards` | **Always refused** (this design not implemented) | Cluster id + ops confirm required; first enroll still refused; ACTIVE WEBAUTHN refuses replace |

**This document is design-only.** It does not authorize operational enrollment and does not describe a working ops first-enroll procedure.

## Non-goals of this design note

- Does not authorize ops enrollment.
- Does not implement WebAuthn.
- Does not create credentials or sessions.

## Next Owner decision

Approve a concrete bootstrap ceremony and a follow-on implementation phase before
any operational first enrollment.
