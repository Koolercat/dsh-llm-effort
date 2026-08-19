#!/usr/bin/env bash
set -euo pipefail

# Browser smoke test: installs the plugin into a fresh DSH_HOME, boots a real
# dsh web profile on a random free port, configures one dummy pi-ai route, and
# then drives a real browser to open Settings -> Effort 管理 and mount the
# plugin's model row.
#
# The browser part fails when no system Chrome/Chromium is installed unless
# DSH_EFFORT_BROWSER_SKIP=1 is set explicitly.
# Requires: dsh, pnpm, curl, python3; a system Chrome/Chromium/Edge for the
# real mount assertion.

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_HOME="$(mktemp -d "${TMPDIR:-/tmp}/dsh-llm-effort-browser.XXXXXX")"
WORK_DIR="$TMP_HOME/work"
mkdir -p "$WORK_DIR"
LOG="$TMP_HOME/dsh.log"
PID=""

cleanup() {
  local status=$?
  if [[ -n "$PID" ]]; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  if [[ $status -ne 0 ]]; then
    echo "--- dsh web log ($LOG) ---" >&2
    cat "$LOG" >&2 2>/dev/null || true
  fi
  rm -rf "$TMP_HOME"
}
trap cleanup EXIT

PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
export DSH_HOME="$TMP_HOME"

dsh --profile web --dump-config >/dev/null

cat > "$TMP_HOME/profiles/web/pnpm-workspace.yaml" <<'YAML'
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
allowBuilds:
  '@google/genai': false
  protobufjs: false
minimumReleaseAgeExclude:
  - '@deepseek-ai/dsh-llm-pi-ai@0.1.0-rc.7'
  - '@deepseek-ai/dsh-llm@0.1.0-rc.7'
  - '@deepseek-ai/dsh-settings@0.1.0-rc.7'
YAML

dsh plugin --profile web add "file:$PLUGIN_DIR"

# Launch from a unique workspace so host.describe.cwd proves we are talking to
# this instance, not an older server that happened to hold the port.
(
  cd "$WORK_DIR"
  exec dsh --profile web --port "$PORT"
) >"$LOG" 2>&1 &
PID=$!

ready=""
for _ in $(seq 1 100); do
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "dsh exited before becoming ready" >&2
    exit 1
  fi
  if curl -fsS --max-time 1 "http://127.0.0.1:$PORT/plugins/dsh-llm-effort/client.js" -o "$TMP_HOME/client.js" 2>/dev/null; then
    ready=1
    break
  fi
  sleep 0.2
done
if [[ -z "$ready" ]]; then
  echo "dsh did not become ready on port $PORT" >&2
  exit 1
fi
grep -q "dsh-llm-effort" "$TMP_HOME/client.js"

rpc() {
  local method="$1"
  local payload="$2"
  local rpc_id
  rpc_id="$(python3 -c 'import uuid; print(uuid.uuid4())')"
  curl -fsS --max-time 5 -X POST "http://127.0.0.1:$PORT/api/$method" \
    -H 'content-type: application/json' \
    -d "{\"type\":\"client-request\",\"rpcId\":\"$rpc_id\",\"method\":\"$method\",\"payload\":$payload}"
}

# Instance identity: the host workspace must be this script's unique temp dir.
EXPECTED_CWD="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$WORK_DIR")"
HOST_JSON="$(rpc 'host.describe' '{}')"
python3 - "$HOST_JSON" "$EXPECTED_CWD" <<'PY'
import json, os, sys
payload = json.loads(sys.argv[1])
expected = sys.argv[2]
assert payload['result']['ok'] is True, payload
actual = os.path.realpath(payload['result']['value']['cwd'])
assert actual == expected, (actual, expected)
PY

# The browser needs a visible third-party model row.
MUTATE_JSON="$(rpc 'settings.mutate' '{"ns":"llm-pi-ai","ops":[{"op":"set","path":["providers","browser-smoke","api"],"value":"openai-completions"},{"op":"set","path":["providers","browser-smoke","baseURL"],"value":"https://example.invalid/v1"},{"op":"set","path":["providers","browser-smoke","models"],"value":[{"id":"smoke-model"}]},{"op":"set","path":["providers","browser-smoke","reasoning"],"value":"high"}]}')"
python3 - "$MUTATE_JSON" <<'PY'
import json, sys
payload = json.loads(sys.argv[1])
assert payload['result']['ok'] is True, payload
PY

DSH_URL="http://127.0.0.1:$PORT" \
DSH_EFFORT_BROWSER_SCREENSHOT="${DSH_EFFORT_BROWSER_SCREENSHOT:-$TMP_HOME/browser-fail.png}" \
node "$PLUGIN_DIR/test/browser-open-smoke.mjs"

echo "browser smoke test passed (port $PORT)"
