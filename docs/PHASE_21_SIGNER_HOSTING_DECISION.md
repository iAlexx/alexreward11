# Phase 21 - Signer Hosting Decision

**PHASE21_SIGNER_HOSTING_DECISION:** DEDICATED_HOST_RECOMMENDED

**Status:** Step 2 source decision documented. No operational deploy authorized.

## Requirement summary

Production signer (SIGNER_KEY_MODE=self_hosted_encrypted) MUST satisfy LOCKED boot, passphrase NOT in env, loopback-gated unlock, encrypted bundle on disk, and apps/signer isolation.

## Railway evaluation

Railway cannot satisfy loopback unlock and operator-present unlock ceremony without custody redesign. Redesign is NOT authorized in Phase 21 Step 2.

## Dedicated host recommendation

Dedicated VPS/bare metal with operator SSH and SIGNER_LISTEN_HOST=127.0.0.1 matches the approved custody model.

## Non-actions (Step 2)

No Railway deploy, no production keys, no funding, no unpause, no live payout.
