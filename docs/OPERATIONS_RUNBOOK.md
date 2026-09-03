# Phase 1 operations runbook

Use `pnpm dev:stack` to start the local foundation and `pnpm smoke` to verify it. Inspect services
with `docker compose -f infra/docker/compose.yaml --env-file .env --profile apps ps`. Stop without
data deletion using `pnpm dev:stack:down`. Production financial operations are intentionally not
defined or enabled in Phase 1.
