# Phase 21 - Controlled Balance Provisioning

**Status:** SOURCE_IMPLEMENTED_OWNER_APPROVED_BUT_NOT_EXECUTED
**Execution in Step 3:** NO
**AdsGram gaps:** NOT closed (remain OPEN)

## Purpose

Provide a controlled Mainnet Available credit path for micro-launch campaign users via ledger `SUPPORT_ADJUSTMENT` (forever separate from Phase 10 Testnet provision).

## Owner-approved constraints

| Constraint | Value |
| --- | --- |
| Network | `TON_MAINNET` only |
| Asset | USDT (Jetton on TON Mainnet) |
| Mechanism | `SUPPORT_ADJUSTMENT` (DR `SUPPORT_COMPENSATION_EXPENSE`) |
| Campaign ceiling | `10_000_000` atomic USDT (10.00 USDT at 6 decimals) |
| Default gate | **Disabled** |
| AdsGram monetary | Gaps remain OPEN - not a substitute for AdsGram settlement |

## Micro-launch band (documented)

- 50 withdrawals x 0.20 USDT gross = **10.00 USDT** gross
- Net **9.50 USDT** with **0.01 USDT** fee per withdrawal
- Fits the micro-launch exposure band when Hot Wallet funding and Available provision stay within Owner ceilings

## Status semantics

`SOURCE_IMPLEMENTED_OWNER_APPROVED_BUT_NOT_EXECUTED` means:

1. Tooling/constants/docs exist in source.
2. Owner approved the source approach.
3. No operational DB mutation / provision CLI execution in Step 3.
4. Not live-payout ready by itself.

See `packages/ledger/src/phase21-mainnet-controlled-available-assets.ts` and `docs/PHASE_21_PROVISIONING_CEREMONY_PREFLIGHT.md`.
