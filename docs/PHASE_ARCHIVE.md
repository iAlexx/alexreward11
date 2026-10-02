# Phase archive packaging

Mandatory after every accepted phase. Full authority: Version 1.2 §156U.

## Layout

```text
phase-archives/
└── PHASE_<NN>_<SLUG>/
    ├── ALEx_Rewards_PHASE_<NN>_<SLUG>_<TIMESTAMP>_<SHORT_SHA>.zip
    ├── PHASE_<NN>_ACCEPTANCE_REPORT.md
    ├── MANIFEST.md
    ├── SHA256SUMS.txt
    ├── PHASE_<NN>_<SLUG>_PACKAGE_<TIMESTAMP>_<SHORT_SHA>.zip
    └── PACKAGE_SHA256.txt
```

- Canonical source ZIP: deterministic `git archive` of the exact accepted commit.
- Final review-package ZIP: the single ZIP the Owner sends for review. Contains exactly the
  source ZIP, acceptance report, `MANIFEST.md`, and `SHA256SUMS.txt` under
  `PHASE_<NN>_<SLUG>/`.
- Outer ZIP entry names MUST use forward slashes (`/`), never backslashes.
- `PACKAGE_SHA256.txt` hashes only the outer review-package ZIP and remains outside it.
- Acceptance report Section O MUST NOT embed the outer package SHA256 (self-reference is
  impossible). Section O points to `PACKAGE_SHA256.txt` as the external authoritative hash.
- `phase-archives/` is gitignored; never commit ZIP binaries.

## Helper

```powershell
pnpm archive:phase -- --phase 02 --slug DATABASE_BASELINE --commit <sha> --report docs/PHASE_02_ACCEPTANCE_REPORT.md
```

Default behavior builds both archive levels and verifies extraction, prohibited paths, nested
source integrity, and checksums. Exit code is non-zero on any failure.

Optional / backfill:

```powershell
pnpm archive:phase -- --from-existing phase-archives/PHASE_01_FOUNDATION --phase 01 --slug FOUNDATION --commit <sha> --next-phase-status "No Phase 2 work had started at packaging time."
```

`--from-existing` must not regenerate or mutate the sealed inner source ZIP.  
`--next-phase-status` must be used whenever the default “No Phase N+1 work has started…” statement
would be historically false.

## Stop rule

After packaging passes: present the final review-package path and `PACKAGE_SHA256.txt` to the
Owner, then wait for explicit approval before starting the next phase.

## Phase 18 archive slug (CLOSED / PASS)

When Phase 18 is accepted after independent review of Step 3, archive with:

- phase: `18`
- slug: `PHASE_18_OBSERVABILITY_DR` (helper argument typically `OBSERVABILITY_DR`)

Example (do **not** run during Step 3):

```powershell
pnpm archive:phase -- --phase 18 --slug OBSERVABILITY_DR --commit <accepted-sha> --report docs/PHASE_18_ACCEPTANCE_REPORT.md
```

Phase 18 status: **CLOSED / PASS** — `PHASE18_GATE=PASS`, `PHASE18_ARCHIVE=PASS`. Canonical source `654a7097456d7d18ad6e6a7072793ee6d353ca33`. Archive acceptance does not authorize payout resume.

## Phase 19 archive slug (CLOSED / PASS / ARCHIVED)

When Phase 19 is accepted after independent review of Step 2C, archive with:

- phase: `19`
- slug: `PHASE_19_SECURITY_REVIEW` (helper argument typically `SECURITY_REVIEW`)

Example:

```powershell
pnpm archive:phase -- --phase 19 --slug SECURITY_REVIEW --commit <accepted-sha> --report docs/PHASE_19_ACCEPTANCE_REPORT.md
```

Phase 19 status: **CLOSED / PASS / ARCHIVED** — `PHASE19_GATE=PASS`, `PHASE19_ARCHIVE=PASS`. Canonical source `b5110524f90f29dc2a9235aac91ee9de731a03c0`. Phase 20 NOT STARTED. Archive acceptance does not authorize Mainnet, production monetary, AdsGram monetary, or payout resume.

## Phase 20 archive slug (CLOSED / PASS / ARCHIVED)

When Phase 20 is accepted after independent final review, archive with:

- phase: `20`
- slug: `PHASE_20_CLOSED_BETA` (helper argument typically `CLOSED_BETA`)

Example:

```powershell
pnpm archive:phase -- --phase 20 --slug CLOSED_BETA --commit <accepted-sha> --report docs/PHASE_20_ACCEPTANCE_REPORT.md --roadmap-version 1.3 --next-phase-status "Phase 21 has NOT started and is NOT authorized by this archive."
```

Phase 20 status: **CLOSED / PASS / ARCHIVED** — `PHASE20_GATE=PASS`, `PHASE20_ARCHIVE=PASS`. Canonical accepted source `b8135c2a94cf5939371100cdbbf2316ba2eeb5e8`. Canonical runtime `production-runtime @ b9dd700de428498493fb6e497ec16901684532c0`. Phase 21 NOT STARTED / NOT AUTHORIZED. Archive acceptance does not authorize real money, AdsGram monetary, Mainnet, payout resume, signer unlock, or TON broadcast.
