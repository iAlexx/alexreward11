# ALEx Rewards engineering rules

The authoritative product, financial, security, and engineering requirements are in
`docs/ALEx_Rewards_Master_Product_Financial_Security_Engineering_Specification_v1.2.md`
(Version 1.2). Version 1.2 supersedes conflicting Version 1.1 language. Requirements not
expressly changed by Version 1.2 remain in force.

- Work only in the phase explicitly approved by the Owner.
- After every accepted phase, create under `phase-archives/` (ignored by Git) both:
  1. a deterministic canonical source ZIP from the exact accepted commit (`git archive`), and
  2. a single final review-package ZIP the Owner can send for review, containing that source
     ZIP plus `PHASE_<NN>_ACCEPTANCE_REPORT.md`, `MANIFEST.md`, and `SHA256SUMS.txt`, with
     `PACKAGE_SHA256.txt` beside the outer package.
     Then verify both archive levels (extract, prohibited-path scan, nested source validation,
     checksums), **stop**, present the review package, and wait for explicit Owner approval before
     the next phase. See `docs/PHASE_ARCHIVE.md`.
- Do not invent production values marked `OWNER_DECISION_REQUIRED`, `PROPOSED_DEFAULT`, or
  configurable without Owner approval.
- Phase 1 is foundation only. Do not add business database tables, ledger postings, reward
  issuance, withdrawal financial logic, TON payout logic, AdsGram monetary issuance, or KMS
  signing.
- PostgreSQL is the future financial source of truth. Never add `users.balance` or another
  mutable authoritative balance shortcut.
- Keep `apps/signer` isolated. No other service may import a KMS client or receive signing
  permission.
- Never commit secrets. Frontend bundles may contain only explicitly public configuration.
- All workspace dependencies must be exact versions and installs must use the lockfile.
- ESM, strict TypeScript, configuration validation, clean shutdown, structured logs, and
  health/readiness endpoints are required foundations.
- Do not silently change approved product or financial rules. Record implementation
  clarifications in `docs/DECISIONS.md`.
