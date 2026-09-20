# PERF_NOTES

Performance log for this fork. Every entry records what was slow, why, what
changed, and the before/after numbers that justify it.

The only goal of this fork is speed; behaviour, the database schema, the
`settings.json` contract and the public `/api/v1` surface are unchanged.

---

## Baseline

### Environment

Measurements are taken in a GitHub Codespace, not on the production host.

| | |
|---|---|
| Machine | GitHub Codespace, 2 vCPU, 7.9 GB RAM |
| OS / kernel | Linux 6.8.0-1064-azure |
| Node | 22.19.0 (per `engines`, installed via nvm; the image's default v24 fails `engine-strict`) |
| pnpm | 10.24.0 (via corepack, per `packageManager`) |
| Database | SQLite, seeded by `WITH_MIGRATIONS=true pnpm cypress:prepare` |
| Settings | `cypress/config/settings.cypress.json` (Plex, no real media server reachable) |
| Server | `NODE_ENV=production node dist/index.js` on port 5055 |

### Pre-existing state on untouched code

Everything passes on `develop` as inherited. No pre-existing failures.

| Check | Result |
|---|---|
| `pnpm build` | passes (~70 s) |
| `pnpm typecheck` | passes (~33 s) |
| `pnpm lint` | 0 errors, 19 warnings (all pre-existing: `no-explicit-any`, one `no-console`) |
| `pnpm test` | 189 passed / 189, 49 suites (~165 s) |

Two environment notes, neither a code defect:

- `.husky/prepare-commit-msg` runs `exec < /dev/tty && npx cz --hook`, which
  aborts in a non-interactive shell. `--no-verify` does not skip it, so commits
  here are made with `HUSKY=0`. Lint, format and tests are run manually instead.
- `next telemetry disable` (the `postinstall` script) writes an untracked
  `cache/` directory at the repo root. It is not in `.gitignore` and is never
  committed. Left alone as an upstream concern.

### How things were measured

The Codespace sits unusually close to TMDB (~10-20 ms warm, vs 100-300 ms
typical for a home server), so wall-clock numbers here *understate* the real
gain of removing an external round trip. Two metrics are therefore recorded:

1. **Outbound round trips per request**, via a preload
   (`NODE_OPTIONS=--require`) that wraps `http.request`/`https.request` and
   counts calls and serialisation "waves" per API request. This is
   network-independent and is the number that transfers to the real
   deployment.
2. **Wall-clock latency**, cold cache, over 20 distinct TMDB ids so every
   request is a genuine cache miss, median of the run, with the server
   restarted between arms so the in-memory cache starts empty.

A/B is done by stashing the change, rebuilding, restarting and re-running, so
both arms use the same ids and the same process lifecycle.

### Baseline measurements

Outbound calls per request, cold cache:

| Endpoint | External calls | Sequential waves |
|---|---|---|
| `/api/v1/movie/:id` | 1 | 1 |
| `/api/v1/movie/:id/ratingscombined` | 3 | **3** |
| `/api/v1/tv/:id` | 1 | 1 |
| `/api/v1/tv/:id/season/:n` | **2** | **2** |
| `/api/v1/discover/movies` | 1 | 1 |
| `/api/v1/discover/genreslider/movie` | 20 | 2 |
| `/api/v1/search` | 1 | 1 |

SSR page loads issue two sequential self-HTTP calls before rendering anything:
`/api/v1/settings/public` then `/api/v1/auth/me`.

TMDB payload sizes, which bound the per-hit `structuredClone` the cache does:
discover 12 KB, movie detail 170 KB, TV detail 355 KB.

---

## Changes

### 1. `perf(movie): fetch Rotten Tomatoes and IMDb ratings in parallel`

**Problem.** `/movie/:id/ratingscombined` took three sequential waves of
external calls: TMDB, then Rotten Tomatoes (Algolia), then IMDb
(`api.radarr.video`).

**Cause.** The IMDb lookup was awaited after the Rotten Tomatoes one, although
neither depends on the other; both only need the already-fetched TMDB movie.

**Fix.** `Promise.all` over the two independent lookups.

**Before / after.** 3 waves → **2 waves**. Median cold-cache response over 20
distinct titles, two clean runs per arm:

| | Before | After |
|---|---|---|
| median | 152.3 ms / 146.0 ms | 129.6 ms / 127.1 ms |
| mean | 173.3 ms / 164.5 ms | 151.7 ms / 145.9 ms |
| p90 | 258.1 ms / 231.6 ms | 225.9 ms / 218.9 ms |

≈ **-14%** here. On a real deployment the saving is one full round trip to
`api.radarr.video`, not the 20 ms seen in this Codespace.

**Risk: low.** Response shape and status codes are unchanged. The only
behavioural difference is that a failing Rotten Tomatoes lookup no longer
short-circuits the IMDb request; both still surface the same 500.

### 2. `perf(tv): skip the anime keyword lookup when it cannot change the provider`

**Problem.** `/tv/:id/season/:n` made two TMDB calls where one suffices, and
`/tv/:id` fetched the show twice.

**Cause.** Both routes fetched the full show from TMDB purely to test whether
its keywords contain the anime id, then used that to pick between the `tv` and
`anime` metadata providers. When both are configured the same — the default,
since both default to TMDB — the two branches resolve to the *same* provider,
so the fetch cannot affect the outcome. The wasted call pulls a ~355 KB payload
and pays a `structuredClone` on it (~4.9 ms measured) on cache read and write.

**Fix.** `getTvShowMetadataProvider()` in `server/api/metadata.ts` centralises
the choice and only pays for the keyword fetch when the two providers actually
differ. Installs that set `metadataSettings.tv` and `.anime` differently behave
exactly as before.

**Before / after.** `/tv/:id/season/:n` drops from 2 calls / 2 waves to
**1 call / 1 wave**. Median cold-cache response over 20 distinct series, two
clean runs per arm:

| | Before | After |
|---|---|---|
| median | 44.3 ms / 41.3 ms | 22.2 ms / 23.1 ms |
| mean | 64.4 ms / 64.5 ms | 35.4 ms / 33.2 ms |
| p90 | 146.5 ms / 149.6 ms | 112.0 ms / 104.0 ms |

≈ **-47%**.

**Risk: low.** Pure removal of a call whose result was discarded under the
default configuration. The non-default path is unchanged.

### 3. `perf(ssr): overlap the settings and user lookups on page render`

**Problem.** Every server-rendered page load made two sequential self-HTTP
calls in `_app.tsx`'s `getInitialProps` before rendering: `/settings/public`,
then `/auth/me`. Each is a full Express cycle including session lookup and a
user query.

**Cause.** `/auth/me` was only issued inside the `initialized === true` branch,
so it could not start until `/settings/public` had resolved.

**Fix.** Both requests are issued together. The user request resolves to
`undefined` instead of rejecting, so it stays handled even when the settings
request is the one that fails, and the redirect logic is unchanged.

**Before / after.** Trace confirms the serialisation is gone — the two calls
start 12 ms and 24 ms into the render before, and 9 ms and 10 ms after.

Single-threaded page-load medians did **not** move measurably (40 samples per
page, two runs per arm: ~28-33 ms before, ~29-37 ms after). The saving is one
`/auth/me` — about 5-7 ms here — which is inside the run-to-run noise.

Under concurrent load it is measurable. 16 simultaneous `/requests` renders,
12 rounds, two runs per arm:

| | Before | After |
|---|---|---|
| median request | 444.5 ms / 398.3 ms | 382.6 ms / 373.7 ms |
| p95 request | 574.2 ms / 452.1 ms | 551.9 ms / 493.1 ms |
| throughput | 35.4 / 38.5 rps | 39.9 / 39.8 rps |

≈ **-10% median, +8% throughput** under concurrency.

**Risk: low.** Redirect behaviour, props and response shapes are unchanged.
One behavioural note: an uninitialised instance now also issues a `/auth/me`
that it discards, returning 401. That only happens during the setup wizard and
changes no output.

### 4. `perf(requests): stop refetching request rows the list already returned`

**Problem.** Loading the home page issued ten `/api/v1/request/:id` calls that
returned data the page already had, inside the same burst as the discover
sliders and the per-card title lookups.

**Cause.** `RequestCard` and `RequestItem` seed SWR with
`fallbackData: request` — the object their parent list request just returned —
and then let SWR revalidate on mount anyway.

**Fix.** `revalidateOnMount: false` on that hook. Approve, decline, retry and
delete still call `revalidate()` or `mutate()` explicitly, and a request with an
in-progress download still polls through the existing `refreshInterval`.

**Before / after.** Playwright, seeded home page, median of 5 loads:

| | Before | After |
|---|---|---|
| API calls per load | 36 | **26** |
| median load | 3223 ms | 3055 ms |

Every removed call was a `/api/v1/request/:id`. The load-time change is small
here because this machine has spare cores; the call count is what matters on a
saturated single-threaded event loop.

**Risk: low.** No change to what is rendered — the data shown is the same object
either way.

### 5. `perf(watchlist): only fetch TMDB details when a new media row is needed`

**Problem.** `Watchlist.createWatchlist()` fetched the full movie or show from
TMDB as its *first* action, then checked whether the entry already existed and
discarded the result on a duplicate.

**Cause.** The fetched details are used in exactly one place: constructing a
`Media` row that does not exist yet.

**Fix.** The lookup moved inside that branch, so a duplicate watchlist entry and
a title already in the library both cost no TMDB call at all.

This is not a rare path. In the owner's production log covering 13.5 hours,
`"Duplicate request for watchlist blocked"` appears **1002 times** across 142
distinct titles, arriving in bursts roughly every two hours — a Jellyfin
watchlist plugin re-posting the whole watchlist, confirmed by the owner. Each of
those paid for a TMDB fetch and a `structuredClone` of a 170-360 KB payload
before being rejected.

**Before / after.** 15 duplicate POSTs issued together:

| | Before | After |
|---|---|---|
| cold cache | 525.6 ms, **15 TMDB calls** | 214.9 ms, **0 TMDB calls** |
| warm cache | 301.5 ms, 0 TMDB calls | 182.2 ms, 0 TMDB calls |

**Risk: low.** Duplicates still return 409 and new entries still resolve
`tmdbId`/`tvdbId` identically. One difference: a duplicate submitted while TMDB
is unreachable now returns that same 409 instead of a 500, which is the correct
answer for it.

### 6. `perf(api): drop the JSON round-trip applied to every API response`

**Problem.** Every API response was stringified twice and parsed once.

**Cause.** A middleware replaced `res.json` with one calling
`JSON.parse(JSON.stringify(json))` before delegating to the real `res.json`,
which serialises again. Its stated purpose was converting `Date` objects to
strings ahead of OpenAPI *response* validation — but response validation is not
enabled anywhere: the validator is configured with `validateRequests: true` and
nothing sets `validateResponses`. The conversion is also redundant on its own
terms, since `res.json`'s own `JSON.stringify` applies `Date.prototype.toJSON`
identically.

**Fix.** Removed the middleware.

**Verification.** Response bodies captured across 31 endpoints (discover, search,
movie and TV details, seasons, requests, media, users, collections, settings)
and compared byte for byte: 30 identical. The one that differs,
`/discover/genreslider/movie`, differs **the same way when the unmodified code is
compared against itself across two runs**, because it samples live TMDB discover
results for genre artwork. So the change is byte-identical on every endpoint
that is reproducible at all.

**Before / after.** CPU profile of the event loop over an identical 30-request
burst:

| | Before | After |
|---|---|---|
| this function's self time | 342 ms (4.7%) | **0 ms** |
| total sampled CPU | 7246 ms | **6112 ms (-15.6%)** |

Burst wall time, 10 rounds, two runs per arm: 364/372 ms → 338/328 ms
(**-9.5%**).

**Risk: low.** Byte-identical output, and `res.json(undefined)` — which the
removed middleware would have thrown a `SyntaxError` on — now behaves normally
again.

---

## Evidence from the owner's production instance

The owner supplied a HAR capture, server logs, a copy of the SQLite database and
a `settings.json`. None of it is in the repository; it was read for analysis
only. What it established:

**The slowness is real and it is server-side.** 77 API calls in a 27.6 second
session accumulated **92.5 seconds** of `wait` against only 2.5 seconds of
`blocked`. Returning to the home page fired **25 concurrent API calls**, each
taking 2.2-3.0 seconds. Most of those returned **`304 Not Modified`** — the
server did the whole job and then sent nothing, because the work happens before
the ETag comparison.

The mechanism is event-loop saturation, not any single slow endpoint: each call
would be fast alone, but Node serves them on one thread. That is why the fixes
that matter most are the ones that stop calls being made at all (changes 4 and
5) or cut per-response CPU (change 6).

**Shape of the instance:** Jellyfin (5 libraries), locale `fr`, 1 Radarr,
1 Sonarr, no Tautulli, `metadataSettings` both `tmdb` — so change 2 applies in
full. Database: 523 media, 269 requests, 410 seasons, 10 users, which is small
enough that query shape is not the bottleneck.

**Ruled out:** the container's `/app/config` is a Docker *named volume* on ext4
inside the Linux VM, not a Windows bind mount, so the SQLite file is not going
through a 9p/SMB translation layer. Host is a 5600G, VM has 4 vCPU and 10 GB.

**Also seen, not acted on:** `/api/v1/auth/me` was fetched **11 times** in
27 seconds, once per navigation. `useUser` sets `revalidateOnMount`,
`revalidateOnFocus` and `revalidateOnReconnect` alongside a 30 s
`refreshInterval`. Raising `dedupingInterval` to match the refresh interval
would collapse most of those without weakening the freshness guarantee the
polling already sets, but it changes how quickly a focus event picks up a
permission change, so it is left alone pending a decision.

---

## Proposed, not implemented

Things that would help but break a hard rule, or that measurement did not
justify.

### Index for `getRelatedMedia` — checked, already present, nothing to do

`Media.getRelatedMedia` runs `WHERE media.tmdbId IN (...)` for every discover,
search, recommendation and similar response. The composite index it wants
already exists in the schema:

    CREATE INDEX "IDX_f8233358694d1677a67899b90a" ON "media" ("tmdbId", "mediaType")

No schema change is needed or proposed. Separately, the owner's production
database is small enough that query shape is not the bottleneck: 523 `media`,
269 `media_request`, 410 `season`, 74 `watchlist`, 10 `user`. Database work was
deprioritised on that evidence.

### `/discover/genreslider/*` issues ~20 TMDB calls per request

Building the genre slider fetches the genre list, then one `discover` call per
genre (19 of them). They run in parallel, so it is 2 waves, but it is 20 calls
against a client rate-limited to `maxRequests: 20`, i.e. exactly at the cap —
so a second concurrent slider request queues behind the first. A longer cache
TTL for this endpoint would help, but the result is genre *artwork* that
changes as titles trend, so a longer TTL is a visible behaviour change.
**Not implemented** pending a decision from the owner.

### `structuredClone` on every cache read and write — the largest single cost

`server/lib/cache.ts` clones on both `get` and `set`. Measured cost on real
payloads: 0.16 ms for a discover page, 2.9 ms for a movie, **4.9 ms for a TV
show**, so every cache *hit* on a TV detail page blocks the event loop for
~5 ms.

A CPU profile of the event loop over a 30-request burst puts it at **874 ms of
12.1%**, the largest entry that is not idle, program or GC — and it drives a
good share of the 500 ms (6.9%) spent in GC, since it allocates 170-360 KB per
call. Together that is roughly a fifth of event-loop CPU.

It is **not implemented** because both clones are load-bearing. Two callers
mutate the object they get back from `ExternalAPI.get`:

- `getTvSeason` rewrites `episode.still_path` in place, prefixing an image host.
  Without the clone this would compound on every cache hit, producing
  `https://image.tmdb.org/t/p/original/https://image.tmdb.org/...`.
- `getMovie` assigns `data.videos` when merging English fallback trailers. Without
  the clone the cached entry would accumulate those trailers, and the
  `some(video => video.type === 'Trailer')` guard would then stop firing,
  changing behaviour. This path is especially live for non-English installs; the
  owner's is `fr`.

The safe route is to make those two call sites build new objects instead of
mutating, then add an opt-in "no clone" flag to `ExternalAPI.get` used only at
call sites audited as read-only (the route mappers all construct new objects and
would qualify). That is a real refactor with a real risk of missing a mutator,
so it is left as a proposal rather than done blind.

### 982 KB client chunk — investigated, no action needed

The largest client chunk is 982 KB out of 16 MB total in `.next/static/chunks`.
It is `ace-builds`, confirmed by marker strings in the emitted chunk
(`ace_gutter` ×72, `ace_editor` ×26, `VirtualRenderer` ×7).

It is **already correctly lazy-loaded**: no entry in `.next/build-manifest.json`
references it, and `src/components/Settings/Notifications/NotificationsWebhook`
pulls it in via `dynamic(() => import('@app/components/JSONEditor'))`. It is
therefore only fetched when the webhook notification settings page is opened,
and never on a normal page load. No change made.

---

## To verify in production

Things that cannot be confirmed in this Codespace.

1. **Whether the home-page burst actually shrinks.** The HAR showed 25
   concurrent calls each taking 2.2-3.0 s. Changes 4 and 6 should cut both the
   count and the per-response cost. Recapture a HAR of the home page and
   compare: API call count for the load, and the `wait` total across all
   `/api/v1/` entries (it was 92.5 s across 77 calls).

2. **The real size of the ratings win.** This environment is ~10-20 ms from both
   Rotten Tomatoes and `api.radarr.video`. Measure
   `/api/v1/movie/:id/ratingscombined` cold from the real host; the saving
   should be roughly one full round trip to `api.radarr.video`, so 100-300 ms
   rather than the 20 ms observed here.

3. **The watchlist plugin burst.** `"Duplicate request for watchlist blocked"`
   should still appear in the logs at the same rate — the duplicates are still
   rejected — but each one should no longer be preceded by a TMDB fetch. Worth
   confirming the bursts stop showing up as latency spikes for anyone browsing
   at the time.

4. **The real size of the SSR win.** The single-threaded gain was unmeasurable
   here because `/api/v1/auth/me` costs ~5-7 ms against a small local SQLite
   file. Measure `/api/v1/auth/me` in isolation on the real host — that number
   *is* the per-page-load saving.

5. **Background job timings.** Availability sync and library scans could not be
   exercised — there is no Jellyfin/Sonarr/Radarr in this environment. The
   owner's log shows `Download Sync` starting 1617 times in 13.5 hours (every
   30 s) and `Download Tracker` as the noisiest label at 3234 lines. Its two
   calls per server are genuinely dependent (`refreshMonitoredDownloads` then
   `getQueue`), so nothing was changed, but its real cost per run is worth
   measuring on the host.

6. **`/api/v1/discover/watchlist` was the slowest slider call** in the HAR at
   1810 ms. Not yet investigated.

---

## CI and Docker

**Upstream publishing workflows are disabled here.** Every job in `release.yml`,
`preview.yml`, `helm.yml`, `docs-deploy.yml`, `create-tag.yml` and
`trivy-scan.yml` carries `if: github.repository == 'seerr-team/seerr'`, so none
of them can run in this fork. Guards were used rather than deleting the files so
that upstream edits to them keep merging cleanly on rebase. Jobs that already
had an `if:` have the guard ANDed with the original condition. `ci.yml` and
`cypress.yml` are untouched — they only run checks and are useful here.

**`fork-image.yml`** is the only workflow in this fork that pushes anything. It
builds from `adam` (or on manual dispatch), `linux/amd64` only, and pushes to
`ghcr.io/<owner>/seerr` using `GITHUB_TOKEN` with `packages: write`.

Tags are `vX.Y.Z-adam.N` plus `sha-<short>`; `latest` is never pushed. `N` is
`github.run_number`, so it increments with each fork build.

`X.Y.Z` is detected as the newest `v*` tag by version order. This matters
because upstream tags releases on `main`, not on `develop`: `git describe` from
this branch reports `v1.3.0` (1351 commits back), while the release this fork
actually sits on is **v3.4.1**. A `base_version` input overrides the detection
if it ever picks wrong.

The image version reaches the app through the existing `COMMIT_TAG` build arg,
so the About page reports `develop-v3.4.1-adam.N`. No settings key and no schema
is involved.
