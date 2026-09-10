# Phase 10 Acceptance Report — TON Testnet Payout Foundation

**Status:** **IN PROGRESS / BLOCKED — EXTERNAL TESTNET RESOURCE REQUIRED**

Phase 10 foundation code is landed (broadcast evidence migration, provider-neutral chain port,
signer BOC return, broadcast gate, confirmation matcher, worker Testnet activity path).  
**No claim of real Testnet 100+ payout PASS.** Phase 11 not started. Phase 9 signer custody unchanged.

## Owner actions required (exact blockers)

1. **Approve and supply Testnet Jetton master address** → set `TON_TESTNET_JETTON_MASTER`  
   (do not invent; config fails closed when `WITHDRAWAL_REAL_CHAIN_ENABLED=true` and master empty).
2. **Provision Testnet HTTP provider endpoints** → `TON_PRIMARY_PROVIDER_URL` (and optional secondary).
3. **Optional provider API key** → `TON_PROVIDER_API_KEY` via secret store (never commit).
4. **Confirm Hot Wallet Testnet identity** (Wallet V5 R1, `networkGlobalId=-3`) and payout Jetton wallet snapshot on `hot_wallets`.
5. **Enable real chain only after (1)–(4)** → `WITHDRAWAL_REAL_CHAIN_ENABLED=true` and
   `WITHDRAWAL_FAKE_CHAIN_ENABLED=false` (mutually exclusive).
6. **Unlock signer** for Testnet sign windows (`apps/signer` remains non-broadcasting).
7. **Do not authorize Mainnet** (`networkGlobalId=-239` / MAINNET codes remain forbidden).

## What landed (foundation)

| Area                        | Change                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------ |
| Migration `0021`            | Additive BOC / broadcast_submitted_at / ambiguity columns                            |
| `@alex-rewards/ton`         | `TonChainProvider`, Fake + HTTP adapters (Testnet-only)                              |
| `@alex-rewards/signing`     | Returns `externalMessageBocBase64` (no broadcast)                                    |
| `@alex-rewards/withdrawals` | Phase 10 config gate, signer client, broadcast gate, confirmation, skeleton pipeline |
| Worker                      | `executeWithdrawalTestnetPayout`; workflow selects via `realChainEnabled`            |
| Config / `.env.example`     | Real-chain flags default off; fail closed on missing Jetton master                   |

## Explicit non-claims

- No real Testnet broadcast campaign / 100+ payout run
- No Phase 10 archive claiming PASS
- No Phase 11
- No AWS KMS / Mainnet / plaintext keys
- Fake chain remains for Phase 7 local tests
