# Phase 21 - Multichain Wallet Compatibility

**Status:** Step 3 documentation / source hardening notes. No live payout.

## Scope

Phase 21 Mainnet micro-launch payout wallets are **TON Connect + TON Mainnet only**.

## Hardening intent

- Proven ownership via TON Connect `ton_proof` on the configured Mainnet network authority (`TON_MAINNET` / `-239`).
- Payout destination must be a verified TON Mainnet wallet; foreign chains are out of scope for Phase 21 withdrawals.
- USDT payout asset is the Owner-approved **USDT Jetton on TON Mainnet** (not native GRAM, not other L1s).
- Native gas display uses Gram (GRAM); chain remains TON (see `PHASE_21_GRAM_NAMING_COMPATIBILITY.md`).
- Do not treat multichain wallet UX as authorization for non-TON payout rails in Phase 21.

## Non-actions (Step 3)

- No production wallet registration ceremony executed.
- No Mainnet funding.
- No live payout.
