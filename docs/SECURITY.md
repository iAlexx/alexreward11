# Security foundation

- All configuration is validated before a process starts.
- Production-like environments reject loopback service endpoints and known local-only tokens.
- Secrets are never returned by health endpoints or passed to frontend applications.
- Logs redact common credential, token, cookie, authorization, and key fields.
- The Signer package boundary is checked automatically; KMS dependencies outside it fail CI.
- Repository secret-pattern scanning and high-severity dependency auditing run in CI.
- Docker image and GitHub Action versions are immutable or exact.

Application authentication and financial authorization controls belong to their approved later
phases; Phase 1 contains no pretend authentication or financial endpoints.

## Phase 6 — TON wallet ownership

- Wallet challenge/verify requires a valid Phase 3 application session. Client `userId` is never ownership authority.
- `ton_proof` expected domain is server-configured; Host / Origin / Telegram URL are not cryptographic domain authority.
- Challenges use CSPRNG entropy; only a hash is stored; raw nonce is never logged or audited.
- Network acceptance is separate from `ton_proof` crypto and comes from authoritative `networks` rows.
- Unknown wallet StateInit codes fail closed (`INVALID_WALLET`).
- Primary wallet change requires a fresh proof, emits `PRIMARY_WALLET_CHANGED` audit evidence, invalidates open challenges, and starts a fixed **24-hour** withdrawal cooldown for all membership tiers.
- Redis may throttle abuse but never authorizes wallet ownership.
- Private keys, seeds, and mnemonics are never accepted or stored.

See `docs/WALLETS.md`.
