# Phase 21 - Mainnet Runtime Wiring (Source)

Default: PHASE21_MAINNET_ENABLED=false, real chain OFF, pauses ON.

## Worker authority

- PHASE21_MAINNET_ENABLED=false -> PHASE10_TESTNET + uildPhase10PayoutConfig (unchanged)
- PHASE21_MAINNET_ENABLED=true -> PHASE21_MAINNET + uildPhase21PayoutConfig

## Worker env gates

When Phase21 off: MAINNET network codes rejected.
When Phase21 on: requires TON_MAINNET, real chain on, fake chain off, jetton master, primary+secondary providers.

## Signing

Mainnet requires Owner-approved JettonTransferExecutionPolicy. Testnet keeps SPIKE policy.

## Bundle encrypt (P21-S2-001)

encryptKeyBundle accepts phase21MainnetEnabled and passes to identityFromSeed.
