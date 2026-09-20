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

---

## Proposed, not implemented

Things that would help but break a hard rule, or that measurement did not
justify.

### Index on `media.tmdbId` + `media.mediaType` for `getRelatedMedia`

`Media.getRelatedMedia` runs `WHERE media.tmdbId IN (...)` for every discover,
search, recommendation and similar response, then filters by `mediaType` in JS.
There is an existing `@Index(['tmdbId', 'mediaType'])` on the entity, so this
may already be covered; worth confirming against a production-sized table
before proposing anything. **Blocked by hard rule 1 (no schema changes)** if it
turns out an index is missing. Not measurable here — the seeded database has
almost no rows.

### `/discover/genreslider/*` issues ~20 TMDB calls per request

Building the genre slider fetches the genre list, then one `discover` call per
genre (19 of them). They run in parallel, so it is 2 waves, but it is 20 calls
against a client rate-limited to `maxRequests: 20`, i.e. exactly at the cap —
so a second concurrent slider request queues behind the first. A longer cache
TTL for this endpoint would help, but the result is genre *artwork* that
changes as titles trend, so a longer TTL is a visible behaviour change.
**Not implemented** pending a decision from the owner.

### `structuredClone` on every cache read and write

`server/lib/cache.ts` clones on both `get` and `set` because callers mutate what
they get back (`getTvSeason` rewrites `still_path` in place). Measured cost on
real payloads: 0.16 ms for a discover page, 2.9 ms for a movie, **4.9 ms for a
TV show**. Every cache *hit* on a TV detail page therefore blocks the event loop
for ~5 ms. Removing the clone would be a correctness change (callers would
share mutable cache state), so it is **not implemented**. A targeted fix —
cloning only the fields that are actually mutated — is possible but needs an
audit of every consumer first.

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

1. **The real size of the ratings win.** This environment is ~10-20 ms from
   both Rotten Tomatoes and `api.radarr.video`. Measure
   `/api/v1/movie/:id/ratingscombined` on a cold cache from the real host; the
   saving should be roughly one full round trip to `api.radarr.video`, so
   100-300 ms rather than the 20 ms observed here.

2. **The real size of the SSR win.** The single-threaded gain was unmeasurable
   here because `/api/v1/auth/me` costs ~5-7 ms against a tiny local SQLite
   file on NVMe. On Postgres over a network, or SQLite on an SD card, the
   session lookup plus user query is far more expensive and the saving scales
   with it. Measure `/api/v1/auth/me` in isolation on the real host — that
   number *is* the per-page-load saving.

3. **Whether `getRelatedMedia` is actually slow at real scale.** The seeded
   database here has almost no rows. Enable TypeORM query logging and check the
   query plan for `WHERE media.tmdbId IN (...)` against the real `media` table.

4. **Background job timings.** Availability sync and library scans could not be
   exercised — there is no Plex/Jellyfin/Sonarr/Radarr in this environment.
