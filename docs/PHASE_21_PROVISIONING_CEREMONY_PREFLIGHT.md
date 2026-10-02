# Phase 21 - Provisioning Ceremony Preflight

**Status:** Step 3 checklist (read-only). **Not executed.**
**READY_FOR_LIVE_PAYOUT:** NO

## Purpose

Owner-facing preflight before any later provisioning ceremony. Completing this checklist does **not** authorize live payout.

## Preconditions (source)

- [ ] Readiness matrix reviewed (`PHASE_21_READINESS_MATRIX.md`)
- [ ] `pnpm phase21:readiness` overall BLOCKED (expected until external resources exist)
- [ ] `pnpm phase21:preflight` may show `READY_FOR_OWNER_PROVISIONING_CEREMONY` or `MAINNET_SOURCE_READY`
- [ ] `readyForLivePayout` is **false**
- [ ] Signer hosting locked: `DEDICATED_CONTROLLED_HOST`
- [ ] Forward GRAM = 1 nanogram Owner-approved; attached lifecycle **ESTIMATED**
- [ ] Controlled Available tooling documented; **not executed**
- [ ] AdsGram gaps remain OPEN
- [ ] Canonical runtime still `b9dd700`; Phase21 not deployed

## External / operational (ceremony inputs - later)

- [ ] Mainnet USDT Jetton master identity
- [ ] Independent primary + secondary TON Mainnet providers
- [ ] Dedicated controlled host for signer
- [ ] Offline Mainnet key ceremony (generate/encrypt/backup) - see ceremony doc
- [ ] Hot Wallet register + fund (5-10 USDT + GRAM gas)
- [ ] Controlled Available provision (if Owner-authorized) within 10_000_000 atomic ceiling
- [ ] Explicit later Owner gate for `PHASE21_MAINNET_ENABLED` / real chain / unpause

## Forbidden in Step 3

- Live Mainnet payout
- Passphrase in env
- SPIKE transfer policy on Mainnet
- Renaming `TON_MAINNET` -> `GRAM_MAINNET`
- Mutating operational DB for provision
