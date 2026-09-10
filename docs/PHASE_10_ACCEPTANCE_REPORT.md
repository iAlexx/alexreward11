# Phase 10 Acceptance Report — TON Testnet Payout Foundation

**Status:** **FOUNDATION CORRECTED — STILL BLOCKED ON OWNER EXTERNAL RESOURCES**

Phase 10 foundation now implements the real payout pipeline stages and documented
provider adapters. **No claim of Phase 10 PASS.** No real Testnet broadcast.
Phase 11 not started. Phase 9 remains CLOSED.

## Owner external resources still required (only)

1. **Owner-approved Testnet Jetton master** → `TON_TESTNET_JETTON_MASTER` (never invent; never Mainnet USDT).
2. **Primary provider** → `TON_PRIMARY_PROVIDER_KIND` + `TON_PRIMARY_PROVIDER_URL` + optional `TON_PRIMARY_PROVIDER_API_KEY`.
3. **Independent secondary provider** (reconciliation campaign) → `TON_SECONDARY_PROVIDER_KIND` + `TON_SECONDARY_PROVIDER_URL` + optional `TON_SECONDARY_PROVIDER_API_KEY`.
4. **Funded Testnet Wallet V5 R1 Hot Wallet** + `hot_wallets.payout_jetton_wallet_address`.
5. **Signer encrypted bundle / unlock** for Testnet sign windows.
6. **Enable flags only after (1)–(5)** → `WITHDRAWAL_REAL_CHAIN_ENABLED=true` and `WITHDRAWAL_FAKE_CHAIN_ENABLED=false`.
7. **Do not authorize Mainnet** (`networkGlobalId=-239` / MAINNET codes remain forbidden).

## What landed (foundation correction)

| Area                        | Change                                                                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration `0021`            | Unchanged; no `0022` required                                                                                                                 |
| `@alex-rewards/ton`         | `TonCenterTestnetProvider` + `TonApiTestnetProvider` (documented APIs); `HttpTonProvider` removed/deprecated                                  |
| `@alex-rewards/withdrawals` | Full real pipeline stages (lease → seqno → attempt → sign → persist BOC → sendBoc → evidence → TEP-74 → CONFIRMED); dual provider auth config |
| Signer                      | `GET /v1/signing-identity` (public key only; no broadcast)                                                                                    |
| CI                          | Dedicated `pnpm test:phase10` step                                                                                                            |
| Config / `.env.example`     | Independent primary/secondary kind/url/api key                                                                                                |

## Explicit non-claims

- No real Testnet broadcast performed
- No Phase 10 archive claiming PASS
- No Phase 11 work started
- No Mainnet
- No AWS KMS / plaintext keys
