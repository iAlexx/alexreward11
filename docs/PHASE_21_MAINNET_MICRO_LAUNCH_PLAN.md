# Phase 21 — Mainnet Micro-Launch Plan (Step 1)

**PHASE21_STATUS:** `IN_PROGRESS`
**PHASE21_GATE:** `BLOCKED_FOR_MAINNET_PROVISIONING`
**PHASE21_MAINNET_ENABLED:** `NO`
**PHASE21_REAL_PAYOUT_EXECUTED:** `NO`
**PHASE21_CONFIRMED_WITHDRAWAL_COUNT:** `0`
**PHASE21_ARCHIVE_CREATED:** `NO`

**Spec authority:** Master Spec v1.3 §178
**Branch:** `phase21-mainnet-micro-launch`
**Base HEAD:** `547117e64986e74647bc48b0661028afbac3f318`
**Phase 20 accepted source (preserved):** `b8135c2a94cf5939371100cdbbf2316ba2eeb5e8`
**Canonical runtime (unchanged):** `production-runtime @ b9dd700de428498493fb6e497ec16901684532c0`

---

## Scope of Step 1

SOURCE / TEST / READINESS ONLY.

Authorized:

- Phase 21 engineering start
- Mainnet readiness foundations (typed config, gates, CLI, docs, unit tests)
- Explicit Phase 21 Mainnet allow-path in signing/config that defaults OFF

Not authorized:

- TON Mainnet activation / real chain enable
- Production signer deploy / Hot Wallet create / funding
- USDT or TON transfers
- Payout unpause / real withdrawal / DB or Railway mutation
- Phase 21 archive

---

## Spec §178 semantics (verbatim intent)

- Fresh production signer / Hot Wallet
- Initial funding approximately **5–10 USDT** + required TON gas (not 50 USDT)
- Manual approval only
- Observe and reconcile every payout
- Founder/member withdrawals keep the same security/reconciliation gates
- Gate before expansion: **≥ 50 confirmed real withdrawals** with **zero** duplicate payout, unexplained reconciliation difference, or ledger invariant violation
- Archive `PHASE_21_MAINNET_MICRO_LAUNCH` then STOP (later; not this step)

---

## Architecture

Preserve Phase 10 Testnet configuration and tests unchanged.

Add an **explicit Phase 21 authority layer**:

| Layer | Role |
| --- | --- |
| Phase 10 (`phase10-config`) | Testnet only (`TON_TESTNET` / `-3`); continues to refuse Mainnet |
| Phase 21 (`phase21-config`) | Mainnet only (`TON_MAINNET` / `-239`); requires `phase21MainnetEnabled=true` |
| Signing / signer config | Default Phase 9 Testnet rejection; Mainnet only when `PHASE21_MAINNET_ENABLED=true` |

Mainnet must never enable from `NODE_ENV`, Railway environment name, or branch name.

Worker schema still refuses `WITHDRAWAL_NETWORK_CODE` MAINNET in Step 1 (live dispatch not wired yet).

---

## Tooling

```bash
pnpm phase21:readiness
pnpm phase21:preflight
pnpm test:phase21
```

Expected Step 1: readiness overall `BLOCKED`; preflight `BLOCKED_FOR_EXTERNAL_RESOURCES` (or owner-decision blocked). Never `READY_FOR_LIVE_PAYOUT`.

---

## Related artifacts

- `docs/PHASE_21_READINESS_MATRIX.md`
- `docs/PHASE_21_REAL_MONEY_BLOCKER_MAPPING.md`
- `docs/PHASE_21_SIGNER_HOT_WALLET_CEREMONY.md`
- `docs/PHASE_21_50_WITHDRAWAL_ACCEPTANCE_CAMPAIGN.md`

Do not mark Phase 21 PASS. Do not create archive in Step 1.


---

## Step 2 (complete - source wiring)

- Fixed P21-S2-001 bundle encrypt Mainnet flag propagation
- Fixed P21-S2-002 typed jetton transfer policy (no Mainnet SPIKE default)
- Worker Phase21 selection wiring (default OFF; Phase10 preserved)
- External read-only probes + hosting decision doc
- Readiness/preflight upgraded; still BLOCKED overall at defaults

Operational posture unchanged: PHASE21_MAINNET_ENABLED=NO, REAL_CHAIN=NO, pauses ON.
