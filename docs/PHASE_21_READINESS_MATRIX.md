# Phase 21 - Readiness Matrix (Step 3)

**PHASE21_GATE:** BLOCKED_FOR_MAINNET_PROVISIONING
**PHASE21_MAINNET_ENABLED:** NO (operational)
**PRODUCTION_SIGNER_SERVICE:** NOT_PROVISIONED
**SIGNER_HOSTING_DECISION:** DEDICATED_CONTROLLED_HOST
**CONTROLLED_MAINNET_WITHDRAWABLE_BALANCE_SOURCE:** SOURCE_IMPLEMENTED_OWNER_APPROVED_BUT_NOT_EXECUTED
**CANONICAL_RUNTIME:** production-runtime @ b9dd700 (unchanged; Phase21 not deployed)
**READY_FOR_LIVE_PAYOUT:** NO

Statuses: READY | PARTIAL | BLOCKED | NOT_PROVISIONED | OWNER_DECISION_REQUIRED

## Step 3 readiness distinctions

| Layer | Meaning | Step 3 default |
| --- | --- | --- |
| MAINNET_SOURCE_READY | Source foundations progressing / present | Approachable |
| READY_FOR_OWNER_PROVISIONING_CEREMONY | Foundations PASS; remaining blockers external/operational | Expected when defaults complete |
| READY_FOR_LIVE_PAYOUT | Live Mainnet payout authorization | **NO** (never from Step 3) |

```text
WORKER_MAINNET_SOURCE_WIRING=READY
WORKER_MAINNET_OPERATIONAL_ENABLE=OFF
SIGNER_HOSTING=DEDICATED_CONTROLLED_HOST
BALANCE_SOURCE=SOURCE_IMPLEMENTED_OWNER_APPROVED_BUT_NOT_EXECUTED
ATTACHED_GRAM_LIFECYCLE=ESTIMATED
FORWARD_GRAM_ATOMIC=1 (Owner-approved)
```

| ID | Requirement | Current state | Evidence / tooling | Readiness |
| --- | --- | --- | --- | --- |
| M01 | Phase 20 archived context preserved | Phase 20 PASS/ARCHIVED | Phase 20 acceptance/archive docs | READY (context) |
| M02 | Explicit Mainnet gate | Default false; operational OFF | PHASE21_MAINNET_ENABLED | BLOCKED (safe-off) |
| M03 | Network authority TON_MAINNET/-239 | Source support; chain=TON | phase21-config.ts | PARTIAL (code only) |
| M04 | Mainnet USDT Jetton master | Absent | TON_MAINNET_USDT_JETTON_MASTER | BLOCKED |
| M05 | Independent primary/secondary providers | Unconfigured | TON_PRIMARY_* / TON_SECONDARY_* | BLOCKED |
| M06 | Production signer service | Dedicated controlled host not deployed | ceremony + hosting decision | NOT_PROVISIONED |
| M07 | Signer self_hosted_encrypted + LOCKED boot | Policy ready; service absent | signing + config Phase21 path | BLOCKED |
| M08 | Hot Wallet registered/funded | Generated offline; NOT registered/funded | Step 4C closeout + ceremony doc | BLOCKED |
| M09 | Initial exposure 5-10 USDT + GRAM gas | Not funded | assessPhase21InitialFundingExposure | BLOCKED |
| M10 | Real chain enable | false operationally | WITHDRAWAL_REAL_CHAIN_ENABLED | BLOCKED (safe-off) |
| M11 | Fake chain disabled | Default false | config | READY (safe) |
| M12 | Withdrawal request / payout pauses | Must stay paused until ceremony | readiness codes | PARTIAL (pause assumed; unpause forbidden) |
| M13 | Manual approval only / no auto payout/unpause/resend | Enforced in Phase21 config | phase21-config.ts | READY (source) |
| M14 | 50-withdrawal expansion gate | Implemented; count=0 | phase21-expansion-gate.ts | BLOCKED (count) |
| M15 | Withdrawable balance source | Tooling Owner-approved; not executed | SUPPORT_ADJUSTMENT path; ceiling 10_000_000 atomic USDT | SOURCE_IMPLEMENTED_OWNER_APPROVED_BUT_NOT_EXECUTED |
| M16 | Worker Mainnet **source** wiring | Implemented; default OFF | phase21-runtime-selection.ts, worker schema | READY (source) |
| M16b | Worker Mainnet **operational** enable | OFF — no live Mainnet dispatch | PHASE21_MAINNET_ENABLED=false operationally | BLOCKED (safe-off) |
| M17 | Signer hosting | Owner decision: DEDICATED_CONTROLLED_HOST | PHASE_21_SIGNER_HOSTING_DECISION.md | READY (decision) |
| M18 | Mainnet transfer gas policy | Forward 1 nanogram Owner-approved; attached ESTIMATED | jetton-transfer-policy.ts | PARTIAL (forward READY; attached OWNER_DECISION) |
| M19 | _(historical Step 2)_ Worker Mainnet wiring | Same as M16 — source READY / operational OFF | See M16 / M16b | READY (source) / BLOCKED (ops) |
| M20 | Mainnet Jetton external verification | Tooling present; live pending | phase21-external-probes.ts | BLOCKED |
| M21 | Signer hosting decision documented | DEDICATED_CONTROLLED_HOST | docs | READY (decision doc) |
| M22 | GRAM native currency naming | Display/canonical = Gram/GRAM; chain remains TON | PHASE_21_GRAM_NAMING_COMPATIBILITY.md | READY (docs) |
| M23 | Multichain wallet hardening | TON Connect Mainnet-only payout wallet | PHASE_21_MULTICHAIN_WALLET_COMPATIBILITY.md | READY (docs/source) |
| M24 | Offline Mainnet key ceremony tooling | Source ready; not executed | signer CLI + ceremony preflight | READY (tool) / BLOCKED (not run) |
| M25 | Dedicated signer deployment pack | Documented; not deployed | PHASE_21_PRODUCTION_RUNTIME_DEPLOYMENT_MANIFEST.md | READY (pack) / NOT_PROVISIONED |
| M26 | Controlled Available provision | Tooling present; disabled; not executed | PHASE_21_CONTROLLED_BALANCE_PROVISIONING.md | SOURCE_IMPLEMENTED / NOT_EXECUTED |
| M27 | AdsGram monetary gaps | Still OPEN | PHASE_21_REAL_MONEY_BLOCKER_MAPPING.md | BLOCKED (gaps OPEN) |
| M28 | Micro-launch band math | 50 x 0.20 gross=10.00; net 9.50 @ 0.01 fee | docs | READY (documented) |

CLI: `pnpm phase21:readiness` / `pnpm phase21:preflight` - overall readiness BLOCKED; preflight may reach `READY_FOR_OWNER_PROVISIONING_CEREMONY` when source foundations complete and remaining items are external. Never `READY_FOR_LIVE_PAYOUT`. No live payout from Step 3.

## Step 3A source corrections (must PASS before ceremony readiness)

| Code | Meaning |
| --- | --- |
| CONTROLLED_PROVISION_OPERATIONAL_MODE | Test vs production ceremony env gates |
| LIVE_FEE_ESTIMATOR_HONEST | MOCK / LIVE_READ_ONLY / UNAVAILABLE honesty |
| PRODUCTION_ENV_CUTOVER_PLAN | Cutover docs present; not executed |
| EXTERNAL_VERIFIER_HARDENED | Provider independence + provenance |
| WITHDRAWAL_REQUEST_PAUSE_FAIL_CLOSED | Missing pause row fails closed |
| PRODUCTION_FLAG_BASELINE_TOOL | DRY_RUN baseline tooling present |
| MAINNET_REGISTRY_BOOTSTRAP | DRY_RUN registry bootstrap present |

READY_FOR_LIVE_PAYOUT remains always false.

## Step 3B ceremony tooling hardening (source observations)

| Code | Meaning |
| --- | --- |
| FORCE_APPLY_REMOVED | No forceApply bypass; env gates only |
| PRODUCTION_FLAG_BASELINE_ATOMIC | Atomic flag baseline APPLY |
| MAINNET_REGISTRY_ONE_PASS_ATOMIC | Zero→complete registry one txn |
| CONCRETE_EXTERNAL_ADAPTERS | Toncenter/TonAPI Mainnet read-only adapters |
| CONCRETE_FEE_ADAPTER | Toncenter Mainnet fee provider |
| HOT_WALLET_REGISTRATION_TOOL | Gated hot wallet register tooling |

READY_FOR_LIVE_PAYOUT remains false.

## Phase 21 Step 3C final operational truth gate

Step 3C adds ceremony observations that must PASS for READY_FOR_OWNER_PROVISIONING_CEREMONY: twoProviderMetadataOperational, realJettonFeeEstimation, usdtMasterFallbackRemoved, livePlanRequiresDatabase, ceremonyOwnerActorRequired, providerUrlSsrfProtection, hotWalletDerivationProofRequired, ceremonyEvidenceSchemaReady. READY_FOR_LIVE_PAYOUT remains always false. See PHASE_21_STEP3C_FINAL_OPERATIONAL_TRUTH_GATE.md.

### Step 4A (2026-10-02)

- `PRODUCTION_OWNER_BOOTSTRAP_SOURCE_READY=YES`
- `PRODUCTION_OWNER_BOOTSTRAP_TRUST_RESOURCES_READY=NO`
- `READY_FOR_PRODUCTION_OWNER_BOOTSTRAP_CEREMONY=NO`
- Step4 remains `PAUSED_OWNER_AUTHORITY_REQUIRED`

### Step 4A.1 (2026-10-02)

- Source capabilities corrected (branded trust, Layer C/D TTY, fail-closed auth state)
- `READY_FOR_PRODUCTION_OWNER_BOOTSTRAP_CEREMONY=NO`
- `RAILWAY_POSTGRES_PUBLIC_ENDPOINT_CURRENTLY_AVAILABLE=NO`
- Step4 remains `PAUSED_OWNER_AUTHORITY_REQUIRED`

### Step 4A.2 (2026-10-03)

- Final source hardening: private mint, encrypted `.enc` Owner key, TTY-only secrets, schema 0024-0028 preflight, APPLY refused
- `PRODUCTION_OWNER_BOOTSTRAP_SOURCE_READY=YES`
- `PRODUCTION_OWNER_BOOTSTRAP_SCHEMA_READY=NO`
- `PRODUCTION_OWNER_BOOTSTRAP_ENDPOINT_TRUST_READY=NO`
- `PRODUCTION_OWNER_BOOTSTRAP_TRUST_RESOURCES_READY=NO`
- `READY_FOR_PRODUCTION_OWNER_BOOTSTRAP_CEREMONY=NO`
- `REAL_OWNER_BOOTSTRAP_KEY_GENERATED=NO`
- Hot Wallet frozen; Railway tunnel discovery-only; no TCP Proxy
- Step4 remains `PAUSED_OWNER_AUTHORITY_REQUIRED`
- See `docs/PHASE_21_STEP4A2_FINAL_OWNER_BOOTSTRAP_HARDENING.md`

### Step 4B.1 (2026-10-03)

- Authenticated read-only preflight source complete; unauthenticated preflight can no longer report ready
- Scoped authentication session closes the verified pool; `--apply` reuses it
- `REAL_AUTHENTICATED_PREFLIGHT_RUN=NO` (Owner manual run pending)
- `READY_FOR_PRODUCTION_OWNER_BOOTSTRAP_CEREMONY=NO`
- `REAL_OWNER_BOOTSTRAP_KEY_GENERATED=NO` (no key/seal/bundle regenerated in this step)
- Public digest reference: `686e3361dedc833312e8698c560b1fccdee84ff3d796cc38a8250c10dce33298`
- Step4 remains `PAUSED_OWNER_AUTHORITY_REQUIRED`
- See `docs/PHASE_21_STEP4B1_AUTHENTICATED_READONLY_PREFLIGHT.md`

### Step 4B.2 (2026-10-03)

- Safe APPLY hardening source complete: no production TOTP auto-confirm; backup attestation + final APPLY phrase; strict READY gate; post-apply read-only verify (`verify-apply`)
- Step 4B.2a: Windows secret-input pause fixed (`readSecretFromTty` + stdin.resume); aborted TOTP not reused
- `REAL_APPLY_RUN=NO` (Owner-manual only after independent review; Cursor must not execute it)
- `READY_FOR_PRODUCTION_OWNER_BOOTSTRAP_CEREMONY=NO`
- `REAL_OWNER_BOOTSTRAP_KEY_GENERATED=NO` (no key/seal/bundle/Channel B regenerated)
- Step4 remains `PAUSED_OWNER_AUTHORITY_REQUIRED`
- See `docs/PHASE_21_STEP4B2_SAFE_OWNER_APPLY.md`

### Step 4C (2026-10-03)

- Owner production bootstrap **COMPLETE** (sanitized closeout IDs only; no secrets)
  - `OWNER_ADMIN_USER_ID=a11a11a1-0000-4000-8000-000000000011`
  - `OWNER_GRANT_ID=e075fc33-ee46-4848-ac84-53c509adc96f`
  - `OWNER_ATTEMPT_ID=ccd4b016-6dd8-43a8-a536-ee341d2fad7e`
- Hot Wallet **GENERATED** offline; **NOT registered**, **NOT funded**
  - Friendly `EQD4NWgFbqCOIGQL9k0SDIP8onQH9cj_MxDcBr3N7DYLy8Lf`
  - Fingerprint `e3e47c32acaed8912c4515618987d66d2c0ddc6d65c46cf16e293c7598e64093`
  - Bundle SHA-256 `A0CD6CD1B871EA7664A4F66BB56CCB3794DA551C5D0E920ECDA2E188061E5C43`
- Source hardening: branded Owner ceremony trust (TTY password+TOTP), WeakSet confirmations, verified APPLY pool, identity proof tooling
- `READY_FOR_LIVE_PAYOUT=NO`
- Phase 21 is **not** complete after Step 4C
- See `docs/PHASE_21_STEP4C_OWNER_CLOSEOUT_AND_HOT_WALLET_READINESS.md`

### Step 4C.1 (2026-10-03)

- `SOURCE_HARDENING_COMPLETE=YES` for 4C.1 corrections only (no live APPLY/register/fund)
- Production Owner auth: verified-pool-only password+TOTP path; generic Owner auth operational deny preserved
- Mandatory branded confirmations on flags / registry / Hot Wallet APPLY
- Hot Wallet APPLY: `DUAL_PROVIDER_LIVE` + independent providers + registry truth + audit post-verify + tx honesty lifecycle
- Operational truth unchanged: `HOT_WALLET_REGISTERED=NO`, `HOT_WALLET_FUNDED=NO`, `MAINNET_REGISTRY_APPLIED=NO`, `READY_FOR_LIVE_PAYOUT=NO`, `PHASE21_STATUS=IN_PROGRESS`

### Step 4C.3 (2026-10-03)

- Removed public mintAuthenticatedPhase21MainnetRegistryVerificationFromLiveTwoProviderPass (plain two-provider result is never authority)
- Package-private 
unLivePhase21MainnetRegistryVerificationAndMintTrust mints trust only from concrete HTTP adapters in-process
- Hardcoded Mainnet registry verification freshness window: 120 seconds
- erify-mainnet-external remains diagnostic-only; APPLY reruns live verification

### Step 4C.2 (2026-10-03)

- Removed public production test-pool registration backdoor from `@alex-rewards/auth` package root
- Mainnet registry APPLY requires live two-provider branded verification trust before Owner final confirmation / mutation
- Post-registry READ ONLY verify (audit + canonical USDT/GRAM/fee/limit; Hot Wallet remains absent)
- Production Owner auth disposable integration coverage for password/TOTP/replay/throttle/lockout
- Operational truth unchanged: `HOT_WALLET_REGISTERED=NO`, `HOT_WALLET_FUNDED=NO`, `MAINNET_REGISTRY_APPLIED=NO`, `READY_FOR_LIVE_PAYOUT=NO`, `PHASE21_STATUS=IN_PROGRESS`

