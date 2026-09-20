#!/usr/bin/env bash
# Start/stop the built server for benchmarking.
#   perf/srv.sh start [trace]   trace = also load the outbound-HTTP counter
#   perf/srv.sh stop
# Run `pnpm build` first. Output goes to $PERF_RUN_DIR (default perf/.run).
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="${PERF_RUN_DIR:-$REPO/perf/.run}"
mkdir -p "$RUN_DIR"
PIDF="$RUN_DIR/server.pid"
PORT="${PORT:-5055}"

case "${1:-}" in
  stop)
    [ -f "$PIDF" ] && kill "$(cat "$PIDF")" 2>/dev/null
    rm -f "$PIDF"
    for _ in $(seq 1 30); do ss -ltn 2>/dev/null | grep -q ":$PORT " || break; sleep 1; done
    ;;
  start)
    cd "$REPO"
    export NODE_ENV=production PORT="$PORT"
    [ "${2:-}" = "trace" ] && export NODE_OPTIONS="--require $REPO/perf/trace-out.cjs"
    setsid nohup node dist/index.js > "$RUN_DIR/server.log" 2>&1 < /dev/null &
    echo $! > "$PIDF"
    for i in $(seq 1 60); do
      [ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/api/v1/status")" = "200" ] \
        && { echo "ready after ${i}s"; exit 0; }
      sleep 1
    done
    echo "TIMEOUT"; tail -5 "$RUN_DIR/server.log"; exit 1
    ;;
  *) echo "usage: $0 {start [trace]|stop}" >&2; exit 2 ;;
esac
