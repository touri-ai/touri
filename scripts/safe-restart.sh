#!/usr/bin/env bash
# Usage: TOURI_DEVICE_COOKIE_FILE=<file> scripts/safe-restart.sh [max-wait-minutes] -- <restart-command> [args...]
# A deployment may wait for work or defer; a timeout never authorizes killing a turn.
set -euo pipefail

max_wait=${1:-30}
[[ $max_wait =~ ^[0-9]+$ ]] || { echo "Invalid wait duration" >&2; exit 2; }
shift
[[ ${1:-} == -- ]] && shift
(($#)) || { echo "A restart command is required" >&2; exit 2; }
cookie_file=${TOURI_DEVICE_COOKIE_FILE:?A device cookie file is required}
cookie=$(cat "$cookie_file")
[[ $cookie =~ ^[A-Za-z0-9_-]+$ ]] || { echo "Invalid device cookie" >&2; exit 2; }
server_url=${TOURI_RUNS_URL:-http://127.0.0.1:8795/api/v1/runs}
origin=${TOURI_ORIGIN:-http://127.0.0.1:8795}
deadline=$(( $(date +%s) + max_wait * 60 ))

get_active_count() {
  printf 'header = "Cookie: touri_device=%s"\n' "$cookie" |
    curl --silent --fail --max-time 10 --config - --header "Origin: $origin" "$server_url" |
    python3 -c '
import json, sys
payload = sys.stdin.buffer.read(1048577)
if len(payload) > 1048576:
    raise SystemExit(1)
runs = json.loads(payload)["runs"]
states = {"queued", "starting", "running", "succeeded", "failed", "canceled", "interrupted"}
if not isinstance(runs, list) or any(not isinstance(run, dict) or run.get("status") not in states for run in runs):
    raise SystemExit(1)
print(sum(run["status"] in {"queued", "starting", "running"} for run in runs))
' 2>/dev/null
}

while :; do
  if ! active_count=$(get_active_count); then
    echo "Restart deferred: could not verify active work." >&2
    exit 75
  fi
  if [[ $active_count == 0 ]]; then
    exec "$@"
  fi
  if (( $(date +%s) >= deadline )); then
    echo "Restart deferred: work is still active." >&2
    exit 75
  fi
  echo "Waiting for active work to finish."
  sleep 30
done
