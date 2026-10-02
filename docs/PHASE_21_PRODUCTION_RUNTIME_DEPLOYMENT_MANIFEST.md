# Phase 21 - Production Runtime Deployment Manifest

**CANONICAL_RUNTIME:** `production-runtime @ b9dd700de428498493fb6e497ec16901684532c0`
**PHASE21_DEPLOYED:** **NO**
**Step 3:** documentation / readiness only - no Railway/Vercel cutover of Phase 21

## Minimum service set (when later Owner-authorized)

| Service | Role | Step 3 |
| --- | --- | --- |
| PostgreSQL | Financial source of truth | Runtime unchanged |
| Redis | Non-authoritative throttle/cache | Runtime unchanged |
| API | Session + withdrawal request surface | Not Phase21-deployed |
| Worker | Temporal payout activities | Mainnet source wired; ops OFF |
| Temporal | Workflow orchestration | Runtime unchanged |
| Bot | Telegram UX | Runtime unchanged |
| Admin | Ops surfaces | Runtime unchanged |
| Miniapp | TON Connect UX | i18n clarity only in Step 3 |
| Signer | `self_hosted_encrypted` on **DEDICATED_CONTROLLED_HOST** | NOT_PROVISIONED |

## Explicit non-deploy

- Phase 21 branch work is **not** the canonical production runtime.
- Runtime HEAD remains **b9dd700**.
- No production signer deploy, no Mainnet enable, no unpause, no live payout from Step 3.

## Related

- `docs/PHASE_21_SIGNER_HOSTING_DECISION.md` -> `DEDICATED_CONTROLLED_HOST`
- `docs/PHASE_21_MAINNET_RUNTIME_WIRING.md`
