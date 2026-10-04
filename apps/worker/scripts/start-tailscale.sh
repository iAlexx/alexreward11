#!/bin/sh
set -eu

fail() {
  echo "worker tailscale startup: $*" >&2
  exit 1
}

[ -n "${TAILSCALE_AUTHKEY:-}" ] || fail "TAILSCALE_AUTHKEY is required"

TS_SOCKET="${TAILSCALE_SOCKET:-/tmp/lootra-tailscaled.sock}"
TS_PROXY_ADDR="${TAILSCALE_PROXY_ADDR:-127.0.0.1:1055}"
TS_HOSTNAME="${TAILSCALE_HOSTNAME:-lootra-railway-worker}"
TS_LOG="${TAILSCALE_LOG_FILE:-/tmp/lootra-tailscaled.log}"

case "$TS_SOCKET" in
  /tmp/*) ;;
  *) fail "TAILSCALE_SOCKET must stay under /tmp for the non-root Railway worker" ;;
esac

case "$TS_PROXY_ADDR" in
  127.0.0.1:*|localhost:*) ;;
  *) fail "TAILSCALE_PROXY_ADDR must be loopback-only" ;;
esac

rm -f "$TS_SOCKET"

env -u TAILSCALE_AUTHKEY tailscaled \
  --tun=userspace-networking \
  --state=mem: \
  --socket="$TS_SOCKET" \
  --socks5-server="$TS_PROXY_ADDR" \
  --outbound-http-proxy-listen="$TS_PROXY_ADDR" \
  >"$TS_LOG" 2>&1 &
TS_PID=$!

cleanup_ts() {
  kill "$TS_PID" 2>/dev/null || true
  wait "$TS_PID" 2>/dev/null || true
}
trap cleanup_ts EXIT

i=0
while [ "$i" -lt 120 ]; do
  if [ -S "$TS_SOCKET" ]; then
    break
  fi
  if ! kill -0 "$TS_PID" 2>/dev/null; then
    cat "$TS_LOG" >&2 || true
    fail "tailscaled exited before creating its LocalAPI socket"
  fi
  i=$((i + 1))
  sleep 0.25
done

if [ "$i" -ge 120 ]; then
  cat "$TS_LOG" >&2 || true
  fail "tailscaled LocalAPI socket did not become ready"
fi

tailscale --socket="$TS_SOCKET" up \
  --auth-key="$TAILSCALE_AUTHKEY" \
  --hostname="$TS_HOSTNAME" \
  --accept-dns=false \
  --accept-routes=false \
  --ssh=false

tailscale --socket="$TS_SOCKET" status >/dev/null 2>&1 ||
  fail "Tailscale did not reach a usable state"

unset TAILSCALE_AUTHKEY

# Node 24 built-in proxy support is enabled only for HTTP. HTTPS provider calls
# remain direct; the signer is intentionally HTTP over the encrypted Tailnet.
export NODE_USE_ENV_PROXY=1
export HTTP_PROXY="http://$TS_PROXY_ADDR"
export http_proxy="$HTTP_PROXY"
export NO_PROXY="${NO_PROXY:-localhost,127.0.0.1,::1,.railway.internal}"
export no_proxy="$NO_PROXY"
unset HTTPS_PROXY https_proxy ALL_PROXY all_proxy

node dist/main.js &
APP_PID=$!

forward_and_wait() {
  signal="$1"
  kill "-$signal" "$APP_PID" 2>/dev/null || true
  wait "$APP_PID" 2>/dev/null || true
  cleanup_ts
}

trap 'forward_and_wait TERM; exit 143' TERM
trap 'forward_and_wait INT; exit 130' INT

set +e
wait "$APP_PID"
APP_STATUS=$?
set -e

cleanup_ts
trap - EXIT
exit "$APP_STATUS"
