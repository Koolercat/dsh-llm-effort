#!/usr/bin/env bash
set -euo pipefail

# Real dsh web install smoke test.
#
# Requirements: dsh and pnpm on PATH, curl, python3. The script uses a
# temporary DSH_HOME and a temporary port; it does not touch the user profile.

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_HOME="$(mktemp -d "${TMPDIR:-/tmp}/dsh-llm-effort-smoke.XXXXXX")"
PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
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

export DSH_HOME="$TMP_HOME"

# Initialize the web profile from the shipped template.
dsh --profile web --dump-config >/dev/null

# The pi-ai peer chain pulls two packages with ignored build scripts. They are
# not needed by this plugin; mark them unbuildable before pnpm ever runs so
# `dsh plugin add` exits zero and reconciles the bundle list.
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

# Boot the real web profile with the plugin bundle installed. Launch from a
# unique workspace so host.describe.cwd proves instance identity.
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

# 1. The host plugin registered its settings namespace.
SETTINGS_JSON="$(rpc 'settings.describe' '{}')"
python3 - "$SETTINGS_JSON" <<'PY'
import json, sys
payload = json.loads(sys.argv[1])
namespaces = payload['result']['value']['namespaces']
assert payload['result']['ok'] is True
assert any(ns['ns'] == 'llm-effort' and ns['applies'] == 'live' for ns in namespaces), namespaces
PY

# 2. Configure a dummy pi-ai route with one model and confirm the generic
# five-effort menu reaches llm.models without any provider network call.
MUTATE_JSON="$(rpc 'settings.mutate' '{"ns":"llm-pi-ai","ops":[{"op":"set","path":["providers","effort-smoke","api"],"value":"openai-completions"},{"op":"set","path":["providers","effort-smoke","baseURL"],"value":"https://example.invalid/v1"},{"op":"set","path":["providers","effort-smoke","models"],"value":[{"id":"smoke-model"}]},{"op":"set","path":["providers","effort-smoke","reasoning"],"value":"high"}]}')"
python3 - "$MUTATE_JSON" <<'PY'
import json, sys
payload = json.loads(sys.argv[1])
assert payload['result']['ok'] is True, payload
PY

MODELS_JSON="$(rpc 'llm.models' '{}')"
python3 - "$MODELS_JSON" <<'PY'
import json, sys
payload = json.loads(sys.argv[1])
groups = payload['result']['value']['groups']
group = next(group for group in groups if group['id'] == 'effort-smoke')
model = next(model for model in group['models'] if model['id'] == 'smoke-model')
efforts = [effort['id'] for effort in model['reasoning']['efforts']]
assert efforts == ['low', 'medium', 'high', 'xhigh', 'max'], efforts
assert model['reasoning']['defaultEffort'] == 'high'
PY

# 3. Hand-edit the plugin namespace to disable the route default (high), as an
# already-saved settings.yaml or session selection would. The host must migrate
# the default to the nearest enabled level instead of making the model unusable.
MUTATE_EFFORT_JSON="$(rpc 'settings.mutate' '{"ns":"llm-effort","ops":[{"op":"set","path":["providers","effort-smoke","models","smoke-model","disabledEfforts"],"value":["high"]}]}')"
python3 - "$MUTATE_EFFORT_JSON" <<'PY'
import json, sys
payload = json.loads(sys.argv[1])
assert payload['result']['ok'] is True, payload
PY

MODELS_AFTER_JSON="$(rpc 'llm.models' '{}')"
python3 - "$MODELS_AFTER_JSON" <<'PY'
import json, sys
payload = json.loads(sys.argv[1])
group = next(group for group in payload['result']['value']['groups'] if group['id'] == 'effort-smoke')
model = next(model for model in group['models'] if model['id'] == 'smoke-model')
efforts = [effort['id'] for effort in model['reasoning']['efforts']]
assert efforts == ['low', 'medium', 'xhigh', 'max'], efforts
assert model['reasoning']['defaultEffort'] == 'medium', model['reasoning']
PY

echo "dsh web install smoke test passed (port $PORT)"
