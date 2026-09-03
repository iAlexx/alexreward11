# ALEx Rewards

Phase 1 foundation for the ALEx Rewards Telegram Mini App platform. The repository is a pnpm
TypeScript monorepo and intentionally contains no financial business implementation yet.

## Prerequisites

- Node.js exactly `24.18.0`
- pnpm exactly `11.25.0`
- Docker Engine with Docker Compose
- Git

## First start

1. Copy `.env.example` to `.env`.
2. Replace `SIGNER_SERVICE_TOKEN` with a unique local random value of at least 32 characters.
3. Run `pnpm install --frozen-lockfile`.
4. Run `pnpm verify:local`.
5. Run `pnpm dev:stack` to build and start the complete local stack.
6. Run `pnpm smoke` to verify every process and dependency.

Local endpoints:

| Component   | URL                                |
| ----------- | ---------------------------------- |
| Mini App    | http://localhost:3000              |
| Admin       | http://localhost:3001              |
| API         | http://localhost:3002/health/ready |
| Bot         | http://localhost:3003/health/ready |
| Worker      | http://localhost:3004/health/ready |
| Signer      | http://localhost:3005/health/ready |
| Temporal UI | http://localhost:8080              |

Stop the stack with `pnpm dev:stack:down`. Add `--volumes` to the underlying Compose command
only when intentionally deleting local service data.

See [docs/LOCAL_DEVELOPMENT.md](docs/LOCAL_DEVELOPMENT.md) for troubleshooting and the clean
environment verification procedure.
