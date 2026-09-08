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
- `PACKAGE_SHA256.txt` hashes only the outer review-package ZIP and remains outside it.
- `phase-archives/` is gitignored; never commit ZIP binaries.

## Helper

```powershell
pnpm archive:phase -- --phase 02 --slug DATABASE_BASELINE --commit <sha> --report docs/PHASE_02_ACCEPTANCE_REPORT.md
```

Default behavior builds both archive levels and verifies extraction, prohibited paths, nested
source integrity, and checksums. Exit code is non-zero on any failure.

Backfill an outer review package around an already-sealed canonical source ZIP:

```powershell
pnpm archive:phase -- --from-existing phase-archives/PHASE_01_FOUNDATION --phase 01 --slug FOUNDATION --commit <sha>
```

`--from-existing` must not regenerate or mutate the sealed inner source ZIP.

## Stop rule

After packaging passes: present the final review-package path and `PACKAGE_SHA256.txt` to the
Owner, then wait for explicit approval before starting the next phase.
