# Phase 21 - Signer Hosting Decision

**PHASE21_SIGNER_HOSTING_DECISION:** DEDICATED_CONTROLLED_HOST

**Status:** Step 3 - decision **LOCKED**. No operational deploy authorized in Step 3.

## Requirement summary

Production signer (`SIGNER_KEY_MODE=self_hosted_encrypted`) MUST satisfy:

- LOCKED boot
- Passphrase NOT in env
- Loopback-gated unlock on controlled host
- Encrypted bundle on disk
- `apps/signer` isolation

## Railway evaluation

Railway cannot satisfy loopback unlock and operator-present unlock ceremony without custody redesign. Redesign is NOT authorized in Phase 21 Step 3.

## Decision (LOCKED)

**DEDICATED_CONTROLLED_HOST** (dedicated VPS/bare metal with operator SSH and `SIGNER_LISTEN_HOST=127.0.0.1`).

Previous Step 2 label `DEDICATED_HOST_RECOMMENDED` is superseded by this locked decision.

## Non-actions (Step 3)

No Railway signer deploy, no production keys, no funding, no unpause, no live payout.
