# perf/

Measurement harness for this fork. `CLAUDE.md` requires every optimisation to be
measured before and after; these are the tools that were used to do that, kept
in the repo so the numbers in `PERF_NOTES.md` can be reproduced and extended.

Nothing here ships in the image, and nothing here is imported by `server/` or
`src/`. `perf/.run/` (logs, pidfile, captures) is ignored.

## Setup

```bash
pnpm install
pnpm build

# A local database with fake data. Never point this at real data.
WITH_MIGRATIONS=true pnpm cypress:prepare   # schema + admin@seerr.dev / test1234
perf/seed-requests.sh                       # 20 synthetic requests, real TMDB ids

perf/srv.sh start          # server on :5055
perf/srv.sh start trace    # ... plus the outbound-HTTP counter on :5099
perf/srv.sh stop
```

## The two metrics

This environment sits unusually close to TMDB (~10-20 ms warm, against
100-300 ms for a typical home server), so **wall-clock time understates the gain
of removing an external round trip.** Always record both:

1. **Outbound round trips per request** — network-independent, and the number
   that transfers to a real deployment. `trace-out.cjs` is loaded through
   `NODE_OPTIONS=--require`, wraps `http.request`/`https.request`, and exposes
   `GET /reset` and `GET /dump` on `127.0.0.1:5099`. It counts calls per host
   and groups them into serialisation "waves".
2. **Wall-clock latency** — cold cache, over many *distinct* ids so every
   request is a genuine miss, median of the run, **server restarted between
   arms** so the in-memory cache starts empty.

A/B is done by stashing the change, rebuilding, restarting and re-running, so
both arms use the same ids and the same process lifecycle. A warm server
carries cache state and inflates the baseline — that mistake produced a fake
"53% win" once; see change 3 in `PERF_NOTES.md`.

## Scripts

| Script | What it measures |
|---|---|
| `bench/run-api.mjs` | Per-endpoint latency, warm cache |
| `bench/run-cold.mjs` | Per-endpoint latency, cold cache over distinct ids |
| `bench/run-trace.mjs` | Outbound calls and waves per endpoint |
| `bench/ssr.mjs` / `ssr-n.mjs` | SSR page-load latency (high-N variant) |
| `bench/ssr-conc.mjs` | SSR under 16-way concurrency: latency and throughput |
| `bench/burst.mjs` | 30 concurrent API calls, the home-page burst pattern |
| `bench/home.mjs` | Real browser load via Playwright: API call count per page |
| `bench/capture.mjs` | Dump response bodies for byte-for-byte A/B comparison |
| `bench/profile.mjs` | CPU-profile the event loop during a burst, via CDP |
| `bench/watchlist.mjs` / `-cold.mjs` | Duplicate watchlist POST cost |
| `bench/clone.mjs` | `structuredClone` cost on real TMDB payloads |

`bench/measure.mjs` is the shared helper (login, timing, reporting).

### Extra dependencies

`home.mjs` needs Playwright, deliberately **not** added to `package.json`:

```bash
npm i playwright && npx playwright install chromium
```

`clone.mjs` needs TMDB payloads in `perf/bench/payloads/` (or `$PERF_PAYLOAD_DIR`):

```bash
mkdir -p perf/bench/payloads && cd perf/bench/payloads
K=431a8708161bcd1f1fbe7536137e61ed   # the key Seerr ships with
curl -s "https://api.themoviedb.org/3/discover/movie?api_key=$K&page=1" -o discover.json
curl -s "https://api.themoviedb.org/3/movie/550?api_key=$K&append_to_response=credits,external_ids,videos,keywords,release_dates,watch/providers" -o movie.json
curl -s "https://api.themoviedb.org/3/tv/1399?api_key=$K&append_to_response=aggregate_credits,credits,external_ids,videos,keywords,content_ratings,watch/providers" -o tv.json
```

### CPU profiling

```bash
pnpm build && perf/srvdbg.sh start
node perf/bench/profile.mjs /tmp/burst.cpuprofile
```

Load it in Chrome DevTools, or aggregate self-time from `samples`/`timeDeltas`.
Ignore `(idle)`, `(program)` and `(garbage collector)` when ranking, but do read
the GC number — allocation-heavy work shows up there rather than in its own frame.

### Comparing responses byte for byte

For a change that must not alter output:

```bash
perf/srv.sh start && node perf/bench/capture.mjs /tmp/cap-before   # unmodified
# apply change, pnpm build:server, restart
perf/srv.sh start && node perf/bench/capture.mjs /tmp/cap-after
```

Then diff the `sha` fields in each `index.json`. Some endpoints are genuinely
non-reproducible across restarts — `/discover/genreslider/movie` samples live
TMDB results — so before blaming a diff on the change, check whether the
**unmodified** code differs from itself across two runs.
