# Phase 21 — Secure Worker → Signer transport

Status: engineering/pre-deploy. This document does **not** authorize funding, signer unlock,
broadcast, production money unpause, AdsGram monetary activation, or a production-runtime cutover.

## Required topology

- Signer stays on the dedicated controlled host and binds the application to `127.0.0.1:3005`.
- Signer joins the Tailnet as `tag:lootra-signer`.
- Railway Worker joins as an ephemeral `tag:lootra-worker` node using a reusable ephemeral auth key.
- Signer application remains bound to `127.0.0.1:3005`.
- A route-filtering nginx proxy binds **only** to the signer's Tailscale IPv4 on port 3005.
  It forwards only the explicitly approved health/signing routes and never forwards
  `/v1/local-unlock` or `/v1/local-relock`.
- No public ingress is added.
- Tailnet access policy permits only `tag:lootra-worker` → `tag:lootra-signer` on TCP 3005.
- The existing signer bearer token remains an additional application-layer credential.
- The Worker uses Tailscale userspace networking because Railway does not provide `/dev/net/tun`.

This is the project's "mTLS / equivalent workload auth" production path: encrypted Tailnet
transport + tagged workload identity + deny-by-default grant + bearer token defense in depth.

## Worker runtime

Use `infra/docker/Dockerfile.worker-tailscale` and start:

```
pnpm --filter @alex-rewards/worker run start:tailscale
```

Required deployment variables:

- `TAILSCALE_AUTHKEY` — secret, generated as reusable + ephemeral + pre-approved and tagged
  `tag:lootra-worker`.
- `SIGNER_TRANSPORT_MODE=tailscale_userspace`.
- `SIGNER_BASE_URL=http://<signer-tailnet-ip>:3005`.
- Existing `SIGNER_SERVICE_TOKEN` remains required by signer HTTP routes.

The startup wrapper runs `tailscaled` with in-memory state and a loopback-only HTTP/SOCKS proxy.
It enables Node 24 built-in proxy handling for HTTP only. HTTPS provider traffic is deliberately not
sent through the Tailnet proxy.

## Signer host

Do **not** use an unrestricted TCP `tailscale serve` mapping to the signer listener. A loopback
reverse proxy can make a remote request appear local to the signer, which would weaken the strict
loopback boundary around `/v1/local-unlock` and `/v1/local-relock`.

Install `infra/nginx/lootra-signer-tailnet.conf` on the dedicated signer host. The proxy binds only
to the signer's Tailscale IPv4 and exposes exactly these routes:

- `GET /health`
- `GET /health/live`
- `GET /health/ready`
- `GET /v1/signing-identity`
- `POST /v1/sign-withdrawal-attempt`

Every other path, including both local custody-control endpoints, is denied at the proxy boundary.
Do not use Funnel. Do not bind the signer application itself to a public interface.

## Required pre-live checks

1. Worker appears as an ephemeral node carrying only `tag:lootra-worker`.
2. Access policy has no wildcard allow-all grant.
3. Tailnet proxy returns 404 for `/v1/local-unlock` and `/v1/local-relock`.
4. Worker can reach `/health` and the signer returns its locked response for
   `/v1/signing-identity` through the Tailnet.
5. Signer remains `custodyState=LOCKED` and `signingReady=false` during transport validation.
6. Public Internet `:3005` remains closed on the signer VM.
7. No funding, unlock, sign-withdrawal call, TON broadcast, or money unpause occurs during this step.
