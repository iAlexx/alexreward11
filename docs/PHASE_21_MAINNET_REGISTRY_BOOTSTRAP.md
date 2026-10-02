# Phase 21 — Mainnet Registry Bootstrap

**Status:** TOOLING HARDENED (Step 3B) — PLAN default — DO NOT APPLY to ops DB without Owner ceremony
**READY_FOR_LIVE_PAYOUT:** NO

## Planned resources (even when network missing)

1. Network TON_MAINNET (chain=TON, environment=MAINNET, global_chain_identifier=ton:mainnet)
2. Asset USDT (decimals=6, non-native, contract_identity=Owner-supplied Jetton master)
3. Asset GRAM (decimals=9, native; chain remains TON_MAINNET)
4. withdrawal_fee_rules v1 — locked economics from LOCKED_INITIAL_WITHDRAWAL
5. withdrawal_limit_rules v1 — locked economics from LOCKED_INITIAL_WITHDRAWAL
6. Hot Wallet slot — DOCUMENTED_ONLY (use hot-wallet:register for Owner-supplied insert)

## APPLY (atomic one-pass)

- Gates: DEPLOYMENT_ENV=production + PHASE21_OPERATIONAL_CEREMONY_ENABLED=true +
  PHASE21_MAINNET_REGISTRY_BOOTSTRAP_APPLY=1 + PHASE21_CEREMONY_REQUIRED_DATABASE_NAME match
- BEGIN + pg_advisory_xact_lock(21000303, …) + re-plan + CREATE chain + re-assert + COMMIT
- Conflicts → ROLLBACK refuse
- forceApply removed

## Module / CLI

- packages/withdrawals/src/phase21-mainnet-registry-bootstrap.ts
- pnpm phase21:mainnet-registry:plan
- pnpm phase21:mainnet-registry:apply -- --apply

See: PHASE_21_STEP3B_CEREMONY_TOOLING_HARDENING.md
