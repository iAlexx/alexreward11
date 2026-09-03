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
