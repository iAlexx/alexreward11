# Phase 19 — Pre-Mainnet Security Review Plan

**PHASE19_STATUS:** `IN_PROGRESS`
**PHASE19_GATE:** `HOLD` (Step 1 discovery)
**Archive slug (later):** `PHASE_19_SECURITY_REVIEW` — **NOT CREATED** in Step 1

## Authority freeze (unchanged)

| Flag | Value |
| --- | --- |
| MAINNET_ALLOWED | false |
| PRODUCTION_MONETARY_ALLOWED | false |
| PAYOUT_RESUME_AUTHORIZED | false |
| ADSGRAM_PRODUCTION_MONETARY | BLOCKED |
| STAGING PAYOUT_DISPATCH_PAUSE | true (do not change in Phase 19 Step 1) |
| AUTO_UNPAUSE | false |
| AUTO_RESEND | false |
| Phase 18 | CLOSED / PASS / ARCHIVED |
| Phase 20 | NOT STARTED |

Starting source HEAD: `6c195dd826fcaa3eb720be2d6bcbb0c00e75c7af`
Branch: `phase19-security-review`
Canonical Phase 18 accepted source (unchanged): `654a7097456d7d18ad6e6a7072793ee6d353ca33`

## Purpose

Master Specification Phase 19 requires a full pre-Mainnet security review covering ten
categories. Step 1 is **discovery first**: attack-surface inventory, adversarial tests,
finding classification, and documentation. Product remediation is deferred to later Phase 19
steps after independent review.

Cursor MUST NOT self-accept Critical/High findings. Mainnet remains BLOCKED until Critical/High
findings are resolved or explicitly Owner-accepted with documented mitigation where policy permits.

## Scope (10 categories)

1. Membership claim-code security / replay
2. Entitlement escalation
3. Founder admin grant / reassignment
4. Provider adapter / webhook trust
5. Provider hard-limit override attempts
6. Policy Center authorization
7. Mission claim abuse
8. Notification targeting leakage
9. Feature-flag misuse
10. Review Queue authorization

Plus cross-cutting: Admin vs Access session separation, CSRF, reauth, confirmation binding,
idempotency, concurrency, TOCTOU, mass assignment, IDOR, secret logging, fail-closed boundaries.

## Method

- Static source review of authoritative controllers/domain modules
- Deterministic adversarial / source-contract tests under `apps/api/test/phase19-*`
- Existing suite reuse via `pnpm test:phase19-security` harness
- Isolated disposable DB only for mandatory DB-backed gates (fail closed if URL missing)
- No live offensive actions against AdsGram, Telegram, Railway, Vercel, Mainnet, signer, or TON

## Severity model

CRITICAL / HIGH / MEDIUM / LOW / INFO as defined in Master Spec Phase 19 guidance.
If uncertain, choose the safer higher classification.

## Step 1 exit criteria

- Plan + findings + attack-surface docs present
- Category matrix complete (REVIEWED / TEST_COVERAGE / open counts)
- `PHASE19_GATE=HOLD` unless zero open findings AND all mandatory gates fully executed
- No Phase 19 archive
- No product remediation (except non-authoritative harness wiring)

## Companions

- `docs/PHASE_19_SECURITY_FINDINGS.md`
- `docs/PHASE_19_ATTACK_SURFACE.md`
- `docs/SECURITY.md` (Phase 19 pointer)
