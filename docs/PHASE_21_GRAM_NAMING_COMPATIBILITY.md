# Phase 21 - GRAM Naming Compatibility

**Status:** Step 3 documentation (source). No rename of chain/network codes. No live payout.

## Authority facts (Owner-approved)

| Fact | Value |
| --- | --- |
| Chain | TON |
| Network code | `TON_MAINNET` (do **not** rename to `GRAM_MAINNET`) |
| Network globalId | `-239` |
| Canonical native display | Gram / `GRAM` |
| Decimals | 9 |
| Atomic unit | nanogram |
| Wallet connect | TON Connect only |
| Payout asset | USDT Jetton on TON Mainnet (unchanged) |

## Classification

| Class | Meaning | Examples |
| --- | --- | --- |
| A - CANONICAL_NATIVE_DISPLAY | User/ops native currency label | `Gram`, `GRAM` |
| B - CHAIN_NETWORK_AUTHORITY | Chain/network identity (immutable codes) | `TON`, `TON_MAINNET`, `TON_TESTNET`, globalId `-239` |
| C - PROVIDER_ALIAS | Provider/UI aliases that normalize to GRAM in native context only | `TON`, `Ton`, `Toncoin` (native alias only; not USDT) |
| D - LEGACY_INTERNAL_IDENTIFIER | Historical ledger/code field names; never rewrite migrations | `HOT_WALLET_TON_ASSET`, `TON_NETWORK_FEE_EXPENSE`, `attachedTonAtomic`, `forwardTonAtomic` |

## Rules

1. Display and canonical native currency for Mainnet gas/native amounts = **Gram (GRAM)**.
2. Chain and network authority remain **TON / TON_MAINNET / -239**.
3. Do **not** invent `GRAM_MAINNET` or rewrite historical ledger account type codes.
4. USDT Jetton payout asset naming is unchanged (`PAYOUT_ASSET_UNCHANGED`).
5. SPIKE Testnet constants remain Testnet-only historical fixtures - must **not** be used by Phase 21.

See `packages/signing/src/gram-native-currency.ts`.
