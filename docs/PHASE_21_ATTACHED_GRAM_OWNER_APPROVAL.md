# Phase 21 — Attached GRAM Owner Approval

**Decision date:** 2026-10-04  
**Status:** OWNER_APPROVED_DECISION / SOURCE_WIRING_PENDING  
**READY_FOR_LIVE_PAYOUT:** NO

## Owner-approved Mainnet transfer gas amount

- Network: `TON_MAINNET` / globalId `-239`
- Payout asset: USDT Jetton
- Attached native amount per withdrawal: **50,000,000 nanogram = 0.05 GRAM**
- Forward native amount: **1 nanogram** (previously Owner-approved)
- Approval scope: Phase 21 Mainnet micro-launch only
- Testnet/SPIKE policy object remains forbidden on Mainnet even though its historical attached numeric value is also 50,000,000.

## Live read-only evidence preceding approval

The Owner decision followed a real Mainnet read-only Toncenter `estimateFee` run using the canonical Phase 21 Hot Wallet and canonical Mainnet USDT Jetton master.

Observed for both cases:

| Net USDT case | Mode | Estimated network fee | Candidate attached | Forward | Native exposure |
| --- | --- | ---: | ---: | ---: | ---: |
| 0.19 USDT (`190000`) | `LIVE_READ_ONLY` | 73,334 nanogram | 50,000,000 nanogram | 1 nanogram | 50,000,001 nanogram |
| 5.00 USDT (`5000000`) | `LIVE_READ_ONLY` | 73,334 nanogram | 50,000,000 nanogram | 1 nanogram | 50,000,001 nanogram |

Provider evidence:
- provider kind: `toncenter`
- provider host: `toncenter.com`
- network identity: `-239`
- estimate method: `estimateFee`
- emulation: unsigned Jetton transfer body
- wallet version: `v5R1`
- broadcast: **false**

The API key used for the read-only call is not recorded in source or evidence.

## Important source/runtime boundary

This decision does **not** by itself enable Mainnet signing. Current source still contains a historical safety guard that rejects the numeric SPIKE attached value on Mainnet. That guard must be corrected and tested so authority is based on Mainnet scope + Owner-approved lifecycle rather than numeric inequality.

Until that source correction is tested and deployed:

- signer remains LOCKED
- real-chain remains disabled
- payout dispatch remains paused
- no real payout is authorized
- `READY_FOR_LIVE_PAYOUT=NO`

Funding, signer unlock, real-chain enable, payout unpause, and the first real withdrawal each remain separate later Owner-authorized steps.
