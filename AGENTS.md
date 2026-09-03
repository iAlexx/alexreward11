# ALEx Rewards engineering rules

The authoritative product, financial, security, and engineering requirements are in
`../ALEx_Rewards_Master_Product_Financial_Security_Engineering_Specification_v1.1.md`.

- Work only in the phase explicitly approved by the Owner.
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
