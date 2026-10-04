# Phase 21 — Secure Worker → Signer transport

Status: engineering/pre-deploy. This document does **not** authorize funding, signer unlock,
broadcast, production money unpause, AdsGram monetary activation, or a production-runtime cutover.

## Required topology

- Signer stays on the dedicated controlled host and binds the application to `127.0.0.1:3005`.
- Signer joins the Tailnet as `tag:lootra-signer`.
- Railway Worker joins as an ephemeral `tag:lootra-worker` node using a reusable ephemeral auth key.
- Signer is exposed only inside the Tailnet with a TCP Serve mapping from Tailnet port 3005 to
  `127.0.0.1:3005`. No public ingress is added.
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

After deny-by-default grants are saved, expose the already-loopback-bound signer only to the Tailnet:

```sh
tailscale serve --bg --tcp=3005 tcp://127.0.0.1:3005
```

Do not use Funnel. Do not bind the signer application itself to a public interface.

## Required pre-live checks

1. Worker appears as an ephemeral node carrying only `tag:lootra-worker`.
2. Access policy has no wildcard allow-all grant.
3. Worker can reach `/health` and `/v1/signing-identity` through the Tailnet.
4. Signer remains `custodyState=LOCKED` and `signingReady=false` during transport validation.
5. Public `:3005` remains closed on the signer VM.
6. No funding, unlock, sign-withdrawal call, TON broadcast, or money unpause occurs during this step.
