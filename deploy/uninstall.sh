#!/usr/bin/env bash
# Stop and remove the broker launchd service. Idempotent.
set -euo pipefail

LABEL="local.claw-broker"
DOMAIN="gui/$(id -u)"
PLIST_DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

if [[ -f "${PLIST_DEST}" ]]; then
  echo "==> Booting out ${LABEL}"
  launchctl bootout "${DOMAIN}" "${PLIST_DEST}" 2>/dev/null || true
  rm -f "${PLIST_DEST}"
  echo "==> Removed ${PLIST_DEST}"
else
  echo "==> ${LABEL} not installed (no plist at ${PLIST_DEST})"
fi

echo "==> Done. Logs (if any) remain in ${HOME}/Library/Logs/claw-broker"
echo "    Tailscale serve, if configured, is separate: tailscale serve --https=8443 off"
