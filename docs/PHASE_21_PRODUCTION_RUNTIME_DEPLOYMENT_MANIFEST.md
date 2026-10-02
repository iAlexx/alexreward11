# Phase 21 - Production Runtime Deployment Manifest

**CANONICAL_RUNTIME:** `production-runtime @ b9dd700de428498493fb6e497ec16901684532c0`
**PHASE21_DEPLOYED:** **NO**
**Step 3 / 3A:** documentation / readiness only - no Railway/Vercel cutover of Phase 21

## Minimum service set (when later Owner-authorized)

| Service | Role | Step 3A |
| --- | --- | --- |
| PostgreSQL | Financial source of truth | Runtime unchanged |
| Redis | Non-authoritative throttle/cache | Runtime unchanged |
| API | Session + withdrawal request + wallet Mainnet path | Requires DEPLOYMENT_ENV=production cutover for TON_MAINNET |
| Worker | Temporal payout activities | Mainnet source wired; ops OFF |
| Temporal | Workflow orchestration | Runtime unchanged |
| Bot | Telegram UX | Redeploy only if config/source diff requires |
| Admin | Ops surfaces | Redeploy only if config/source diff requires |
| Miniapp | TON Connect UX | i18n / GRAM wording if runtime asset changed |
| Signer | `self_hosted_encrypted` on **DEDICATED_CONTROLLED_HOST** | NOT_PROVISIONED (external host) |

## Safe future deploy sequence (do not execute in Step 3A)

See `docs/PHASE_21_PRODUCTION_ENVIRONMENT_CUTOVER.md`. High-level order:

1. PRODUCTION safety flag baseline (all restrictive) — DRY_RUN tooling ready
2. Mainnet network/assets/rules while request/dispatch remain paused
3. Generate/register public Hot Wallet identity
4. Deploy/verify dedicated signer LOCKED
5. Configure independent Mainnet providers
6. Deploy Phase21-capable application runtime
7. Switch relevant app services to `DEPLOYMENT_ENV=production`
8. Verify TON Mainnet wallet proof path (-239)
9. Verify policies/flags
10. Keep Mainnet payout OFF
11. Fund only under separate Owner authorization
12. Only later controlled unpause/sign window

## Explicit non-deploy

- Phase 21 branch work is **not** the canonical production runtime.
- Runtime HEAD remains **b9dd700**.
- No production signer deploy, no Mainnet enable, no unpause, no live payout from Step 3A.
- Do not flip DEPLOYMENT_ENV before PRODUCTION pause rows exist (fail-closed).

## Related

- `docs/PHASE_21_PRODUCTION_ENVIRONMENT_CUTOVER.md`
- `docs/PHASE_21_STEP3A_INDEPENDENT_REVIEW_CORRECTIONS.md`
- `docs/PHASE_21_SIGNER_HOSTING_DECISION.md` -> `DEDICATED_CONTROLLED_HOST`
- `docs/PHASE_21_MAINNET_RUNTIME_WIRING.md`
- `docs/PHASE_21_MAINNET_REGISTRY_BOOTSTRAP.md`
