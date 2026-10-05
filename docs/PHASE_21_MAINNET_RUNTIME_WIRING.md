# Phase 21 - Mainnet Runtime Wiring (Source)

Default: `PHASE21_MAINNET_ENABLED=false`, real chain OFF, pauses ON.
Canonical runtime remains `production-runtime @ b9dd700`. Phase21 **not deployed**.

## Worker authority

- `PHASE21_MAINNET_ENABLED=false` -> `PHASE10_TESTNET` + `buildPhase10PayoutConfig` (unchanged)
- `PHASE21_MAINNET_ENABLED=true` -> `PHASE21_MAINNET` + `buildPhase21PayoutConfig`

## Worker env gates

When Phase21 off: MAINNET network codes rejected.
When Phase21 on: requires `TON_MAINNET`, real chain on, fake chain off, jetton master, primary+secondary providers.

## Signing / gas

- Mainnet forward GRAM = **1 nanogram** (Owner-approved).
- Attached GRAM lifecycle = **ESTIMATED** (not activated; SPIKE 0.05 forbidden on Mainnet).
- Testnet keeps SPIKE policy. Phase21 must **not** use SPIKE policy.

## Native naming

Canonical native display = Gram/GRAM; chain/network codes remain TON / `TON_MAINNET` / `-239`.
See `PHASE_21_GRAM_NAMING_COMPATIBILITY.md`.

## Bundle encrypt (P21-S2-001)

`encryptKeyBundle` accepts `phase21MainnetEnabled` and passes to `identityFromSeed`.

## Step 3

Source wiring + docs/readiness only. No live Mainnet dispatch. No live payout.
