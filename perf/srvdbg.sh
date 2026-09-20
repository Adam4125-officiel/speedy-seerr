#!/usr/bin/env bash
# Same as srv.sh start, but with the V8 inspector open on 9229 so
# perf/bench/profile.mjs can drive the CPU profiler.
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="${PERF_RUN_DIR:-$REPO/perf/.run}"
mkdir -p "$RUN_DIR"
PIDF="$RUN_DIR/server.pid"
PORT="${PORT:-5055}"

case "${1:-}" in
  stop) exec "$REPO/perf/srv.sh" stop ;;
  start)
    cd "$REPO"
    export NODE_ENV=production PORT="$PORT"
    setsid nohup node --inspect=127.0.0.1:9229 dist/index.js > "$RUN_DIR/server.log" 2>&1 < /dev/null &
    echo $! > "$PIDF"
    for i in $(seq 1 60); do
      [ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/api/v1/status")" = "200" ] \
        && { echo "ready after ${i}s"; exit 0; }
      sleep 1
    done
    echo "TIMEOUT"; tail -5 "$RUN_DIR/server.log"; exit 1
    ;;
  *) echo "usage: $0 {start|stop}" >&2; exit 2 ;;
esac
