# Phase 21 — Mainnet Registry Bootstrap

**Status:** TOOLING IMPLEMENTED — DRY_RUN default — DO NOT APPLY to ops DB in Step 3A

## Planned resources

1. Network TON_MAINNET (chain=TON, environment=MAINNET, global_chain_identifier=ton:mainnet)
2. Asset USDT (decimals=6, non-native, contract_identity=Owner-supplied Jetton master)
3. Asset GRAM (decimals=9, native, display/canonical native currency; chain remains TON_MAINNET)
4. withdrawal_fee_rules v1 — locked economics fixed fee 0.01 USDT (10000 atomic)
5. withdrawal_limit_rules v1 — min 0.20, max single 5, user hourly 5, daily 10,
   hot-wallet hourly 25, daily 100 (USDT 6dp atomic equivalents from LOCKED_INITIAL_WITHDRAWAL)
6. Hot Wallet slot — **DOCUMENTED_ONLY** (address/signer_reference = OWNER_DECISION_REQUIRED)

## Gates

- Default DRY_RUN
- Apply only when PHASE21_MAINNET_REGISTRY_BOOTSTRAP_APPLY=1 AND
  PHASE21_OPERATIONAL_CEREMONY_ENABLED=true
- Conflict detection refuses rewrite of differing historical rows
- No migration rewrite

## Module

packages/withdrawals/src/phase21-mainnet-registry-bootstrap.ts
