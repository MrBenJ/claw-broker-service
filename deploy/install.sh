#!/usr/bin/env bash
# Build the broker and install it as a launchd user agent on macOS.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node || true)"  # `|| true`: under set -e, a bare command -v miss would exit before our message
PORT="${PORT:-8787}"
LABEL="local.claw-broker"
DOMAIN="gui/$(id -u)"
LOG_DIR="${HOME}/Library/Logs/claw-broker"
PLIST_DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

if [[ -z "${NODE_BIN}" ]]; then
  echo "error: node not found on PATH" >&2
  exit 1
fi

echo "==> Building (${REPO_DIR})"
cd "${REPO_DIR}"
npm ci
npm run build

echo "==> Preparing log dir ${LOG_DIR}"
mkdir -p "${LOG_DIR}"
mkdir -p "${HOME}/Library/LaunchAgents"

echo "==> Rendering plist -> ${PLIST_DEST}"
sed \
  -e "s#__NODE_BIN__#${NODE_BIN}#g" \
  -e "s#__REPO_DIR__#${REPO_DIR}#g" \
  -e "s#__PORT__#${PORT}#g" \
  "${REPO_DIR}/deploy/${LABEL}.plist" \
  | sed \
    -e "s#${REPO_DIR}/../claw-broker-logs/out.log#${LOG_DIR}/out.log#g" \
    -e "s#${REPO_DIR}/../claw-broker-logs/err.log#${LOG_DIR}/err.log#g" \
  > "${PLIST_DEST}"

echo "==> (Re)loading launchd service ${LABEL}"
launchctl bootout "${DOMAIN}" "${PLIST_DEST}" 2>/dev/null || true   # modern unload; ok if not loaded
launchctl bootstrap "${DOMAIN}" "${PLIST_DEST}"                     # modern load

echo "==> Waiting for health check on http://127.0.0.1:${PORT}/health"
for attempt in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    echo "==> Healthy. Service ${LABEL} is up."
    echo "    Status:  launchctl list | grep ${LABEL}"
    echo "    Logs:    tail -f ${LOG_DIR}/out.log"
    exit 0
  fi
  sleep 0.5
done

echo "error: service did not pass health check within ~10s." >&2
echo "  Inspect: tail -n 50 ${LOG_DIR}/err.log" >&2
exit 1
