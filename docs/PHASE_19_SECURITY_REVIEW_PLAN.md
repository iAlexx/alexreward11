# Phase 19 — Pre-Mainnet Security Review Plan

**PHASE19_STATUS:** `CLOSED / PASS / ARCHIVED`
**PHASE19_GATE:** `PASS`
**PHASE19_ARCHIVE:** `PASS`
**Archive slug:** `PHASE_19_SECURITY_REVIEW` — **CREATED** (final acceptance gate)
**Canonical accepted source:** `b5110524f90f29dc2a9235aac91ee9de731a03c0`
**Phase 20:** **NOT STARTED**

Historical Step 1 / 2A / 2B / 2C plan text below is retained for lineage.

## Authority freeze (unchanged)

| Flag | Value |
| --- | --- |
| MAINNET_ALLOWED | false |
| PRODUCTION_MONETARY_ALLOWED | false |
| PAYOUT_RESUME_AUTHORIZED | false |
| ADSGRAM_PRODUCTION_MONETARY | BLOCKED |
| STAGING PAYOUT_DISPATCH_PAUSE | true (do not change in Phase 19) |
| AUTO_UNPAUSE | false |
| AUTO_RESEND | false |
| Phase 18 | CLOSED / PASS / ARCHIVED |
| Phase 20 | NOT STARTED |

Starting source HEAD: `6c195dd826fcaa3eb720be2d6bcbb0c00e75c7af`
Branch: `phase19-security-review`
Step 1 discovery HEAD: `616fe53dbc30494bac0f9d9ee538a2e84b6d8307`
Canonical Phase 18 accepted source (unchanged): `654a7097456d7d18ad6e6a7072793ee6d353ca33`

## Purpose

Master Specification Phase 19 requires a full pre-Mainnet security review covering ten
categories. Step 1 was discovery. Step 2A corrects the findings register, remediates confirmed
product Mainnet blockers, runs disposable-DB gates, and triages Critical/High dependencies.

Cursor MUST NOT self-accept Critical/High findings. Mainnet remains BLOCKED while Critical/High
findings remain OPEN (currently dependency clusters P19-SEC-019..022).

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
idempotency, concurrency, TOCTOU, mass assignment, IDOR, secret logging, fail-closed boundaries,
dependency supply-chain Critical/High triage.

## Method

- Static source review of authoritative controllers/domain modules
- Deterministic adversarial / source-contract tests under `apps/api/test/phase19-*`
- Existing suite reuse via `pnpm test:phase19-security` harness
- Isolated disposable DB only for mandatory DB-backed gates (`PHASE19_REQUIRE_DB_GATES=1`)
- Harness fails closed if a mandatory DB suite reports 0 passed tests (skip ≠ PASS)
- No live offensive actions against AdsGram, Telegram, Railway, Vercel, Mainnet, signer, or TON

## Severity model

CRITICAL / HIGH / MEDIUM / LOW / INFO as defined in Master Spec Phase 19 guidance.
If uncertain, choose the safer higher classification.
Independent-review corrections supersede earlier discovery severity where evidence requires it.

## Step 2A exit criteria

- Findings register corrected (014/016 HIGH; 013/015 FALSE_POSITIVE; 018 added; dependency triage)
- Product remediations for 001/003/009/014/016/017/018 landed with tests
- Disposable DB gates executed under `PHASE19_REQUIRE_DB_GATES=1`
- `PHASE19_GATE=HOLD` while Critical/High remain OPEN
- No Phase 19 archive
- No Phase 20 start
- No live Railway / staging DB / payout pause / signer / TON / Mainnet actions

## Companions

- `docs/PHASE_19_SECURITY_FINDINGS.md`
- `docs/PHASE_19_ATTACK_SURFACE.md`
- `docs/SECURITY.md` (Phase 19 pointer)
