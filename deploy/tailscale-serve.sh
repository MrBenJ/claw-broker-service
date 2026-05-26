#!/usr/bin/env bash
# Front the local broker with HTTPS on this machine's tailnet name, on a
# DEDICATED port (8443) so the frontend can own :443 (/). See the bring-up
# doc for the full topology.
#
# Prerequisites:
#   - Tailscale installed and logged in (`tailscale status` works).
#   - HTTPS certificates enabled for the tailnet:
#     admin console -> DNS -> "Enable HTTPS".
#   - Syntax requires Tailscale >= 1.52 (current `serve` CLI).
set -euo pipefail

PORT="${PORT:-8787}"          # local broker (loopback)
HTTPS_PORT="${HTTPS_PORT:-8443}"  # tailnet-facing HTTPS port for the broker

# Resolve the tailscale CLI. On macOS the GUI app ships it at a non-PATH path.
TS="$(command -v tailscale || true)"
if [[ -z "${TS}" && -x "/Applications/Tailscale.app/Contents/MacOS/Tailscale" ]]; then
  TS="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
fi
if [[ -z "${TS}" ]]; then
  echo "error: tailscale CLI not found." >&2
  echo "  Install the macOS app from https://tailscale.com/download/mac and either" >&2
  echo "  add it to PATH or run: /Applications/Tailscale.app/Contents/MacOS/Tailscale" >&2
  exit 1
fi

# Preflight: must be logged in. (`serve` has no --yes; cert provisioning needs
# HTTPS enabled in the admin console, which we cannot toggle from here.)
if ! "${TS}" status >/dev/null 2>&1; then
  echo "error: tailscale is not logged in / not running. Run: ${TS} up" >&2
  exit 1
fi

echo "==> Proxying https://<machine>.<tailnet>.ts.net:${HTTPS_PORT}  ->  http://127.0.0.1:${PORT}"
# --bg returns promptly; capture failure (the usual cause is HTTPS not enabled).
if ! "${TS}" serve --bg --https="${HTTPS_PORT}" "http://127.0.0.1:${PORT}"; then
  echo "error: 'tailscale serve' failed." >&2
  echo "  Most likely HTTPS certificates are not enabled for this tailnet." >&2
  echo "  Enable them in the admin console (DNS -> Enable HTTPS), then re-run." >&2
  echo "  Docs: https://tailscale.com/kb/1153/enabling-https" >&2
  exit 1
fi

echo "==> Current serve config:"
"${TS}" serve status

echo
echo "Broker URL = https://<machine>.<tailnet>.ts.net:${HTTPS_PORT}"
echo "Use it as VITE_SIGNAL_SERVER (frontend build) and CT_SIGNAL_SERVER (daemon)."
echo "To stop: ${TS} serve --https=${HTTPS_PORT} off"
