# CLAUDE.md — Seerr performance fork

## Context

This repo is a personal fork of `seerr-team/seerr` (TypeScript: Next.js/React frontend, Node/Express backend, TypeORM with SQLite or Postgres).

**The only goal of this fork is speed.** Upstream Seerr works fine functionally, but it is very slow (page loads, discover/search, request lists, admin pages, background jobs). Make it fast without changing what it does.

This fork is deployed as a Docker image and will run **on top of an existing production data volume** (existing database + `settings.json`). The owner must be able to go back to the official upstream image at any time. Every rule below follows from that.

You are running in a fresh, empty GitHub Codespace. Nothing is preinstalled for you: install whatever you need yourself.

---

## Where this stands

Work happens on `adam` (pushed to `origin`). `develop` mirrors upstream and is
never committed to. `working_branch` is gone, locally and on the remote.

Eight commits so far — six optimisations, all measured, plus the CI work.
`PERF_NOTES.md` is the source of truth for what changed, the before/after
numbers, what was investigated and rejected, and what still needs checking on
the real deployment. **Read it before starting anything.**

The headline finding, from the owner's HAR: the slowness is **event-loop
saturation**, not one slow endpoint. Returning to the home page fired 25
concurrent API calls each taking 2.2-3.0 s, with 92.5 s of server `wait` across
77 calls in a 27.6 s session — most of them returning `304 Not Modified` after
doing the full work. So the fixes that pay are the ones that stop calls being
made at all, or cut per-response CPU. Micro-tuning a single handler will not
show up.

Best remaining leads, in order:

1. **`structuredClone` in `server/lib/cache.ts`** — 12.1% of event-loop CPU plus
   much of the 6.9% GC, the largest single cost left. Not safe to remove as-is:
   `getTvSeason` and `getMovie` both mutate what `ExternalAPI.get` returns. The
   route in `PERF_NOTES.md` is to make those two non-mutating first, then add an
   opt-in no-clone flag for audited read-only call sites.
2. **`/api/v1/discover/watchlist`** was the slowest slider call in the HAR at
   1810 ms. Not yet investigated.
3. **`/api/v1/auth/me` fetched 11 times in 27 s**, once per navigation. Raising
   SWR's `dedupingInterval` in `useUser` to match its existing 30 s
   `refreshInterval` would collapse most of them without weakening the freshness
   the polling already guarantees — but it changes how fast a focus event picks
   up a permission change, so it needs a decision first.
4. **`/discover/genreslider/*`** issues ~20 TMDB calls per request, right at the
   client's rate-limit cap.

## Hard rules (never break these)

1. **No database schema changes. Ever.** Do not create, edit or delete migrations. Do not change TypeORM entities in any way that alters the schema (columns, types, relations, indexes, constraints). If an index or schema change would clearly help, **do not implement it**: write it down in `PERF_NOTES.md` under "Proposed, not implemented" with the expected gain.
2. **No breaking changes to `settings.json`.** Don't rename, remove or change the meaning of existing keys. New optional keys are allowed only if the app behaves exactly like upstream when they're absent.
3. **Both SQLite and Postgres must keep working.** Don't optimize for one in a way that breaks the other.
4. **Don't change behavior.** Same features, same results, same permissions, same notifications. No removing features to gain speed. The public API (`/api/v1/...`) keeps the same routes, parameters and response shapes, because external tools consume it.
5. **Stay rebase-friendly.** Upstream changes often and this fork gets rebased on it regularly:
   - Minimal diffs. Touch only what the optimization needs.
   - No repo-wide reformatting, no mass renames, no moving files around, no "while I'm here" refactors.
   - One optimization per commit, with a clear conventional commit message (`perf(scope): ...`).
6. **Type safety.** No `any`, no `@ts-ignore` / `@ts-expect-error` to silence errors. Fix the actual problem.
7. **Dependencies.** Don't add heavy dependencies. Any new dependency needs a one-line justification in `PERF_NOTES.md`.
8. **Git.**
   - Work on the `adam` branch. Never commit to `develop` (it mirrors upstream).
   - Never push to `upstream`. Never open PRs against `seerr-team/seerr`.
   - Never commit secrets, API keys, databases or config files with real data.

---

## Setup

The first session already did the groundwork. In a fresh Codespace:

1. **Node 22.19.0** (`engines` requires `^22.19.0` and `.npmrc` sets
   `engine-strict=true`; the image ships Node 24, which fails install):
   `export NVM_DIR=/usr/local/share/nvm && . "$NVM_DIR/nvm.sh" && nvm install 22.19.0 && nvm alias default 22.19.0`
2. **pnpm 10.24.0**: `corepack enable && corepack prepare pnpm@10.24.0 --activate`
3. `pnpm install`
4. Run the validation suite once to confirm a clean baseline before changing anything.
5. Remotes are already set: `origin` = this fork, `upstream` = seerr-team/seerr.
   Release tags live on `upstream/main`, not `develop`, so fetch with
   `git fetch upstream --tags` when you need the version.
6. Read `PERF_NOTES.md` first — it has the baseline, every measurement so far,
   and what was deliberately left alone. Then `perf/README.md` for the tooling.

### Environment quirks that will bite you

- **Commits need `HUSKY=0`.** `.husky/prepare-commit-msg` runs
  `exec < /dev/tty && npx cz --hook`, which aborts in a non-interactive shell.
  `--no-verify` does *not* skip it. Use `HUSKY=0 git commit ...` and run lint,
  format and tests manually instead.
- **`pnpm build` can OOM** if a server is also running. Stop it first
  (`perf/srv.sh stop`) — the box has ~8 GB.
- `next telemetry disable` (a `postinstall` script) creates an untracked
  `cache/` directory at the repo root. Leave it; never commit it.

## Validation (run before every commit)

```bash
pnpm build          # ~70s   (stop the perf server first, it can OOM)
pnpm typecheck      # ~33s
pnpm lint           # must be 0 errors
pnpm format:check   # prettier; `npx prettier --write <file>` to fix
pnpm test           # ~165s, 189 tests / 49 suites
```

A commit that doesn't pass all of these doesn't get made. Then commit with
`HUSKY=0 git commit` (see Setup for why).

Known-clean baseline on untouched code: build, typecheck, format and all 189
tests pass; lint reports **0 errors and 19 pre-existing warnings**
(`no-explicit-any`, one `no-console`). If you see 19 warnings, that's expected —
don't "fix" them, it's churn against upstream.

---

## Method: measure first, then optimize

**Don't optimize by guessing.** For every change:

1. Identify the slow path and **measure it** (timings, number of queries, number of external HTTP calls, payload size, bundle size…).
2. Change the code.
3. Measure again under the same conditions.
4. Log it in `PERF_NOTES.md`: what was slow, why, what you changed, before/after numbers, risk level.

If the gain isn't measurable or is negligible, revert it. Complexity has to be paid for with real speed.

### About measuring in this Codespace

There is no real Jellyfin/Plex/Sonarr/Radarr here, and no production data. Use
the harness in `perf/` — it exists so this is repeatable. See `perf/README.md`.

```bash
WITH_MIGRATIONS=true pnpm cypress:prepare   # schema + admin@seerr.dev / test1234
perf/seed-requests.sh                       # synthetic requests, real TMDB ids
pnpm build && perf/srv.sh start [trace]
```

Three things that were learned the hard way:

- **This box is ~10-20 ms from TMDB**, against 100-300 ms for a real home
  server, so wall-clock *understates* the gain of removing an external round
  trip. Always also record **outbound calls and serialisation waves per
  request** (`perf/trace-out.cjs`, `perf/bench/run-trace.mjs`) — that number
  transfers to the real deployment.
- **Restart the server between A/B arms.** A warm process carries cache state
  and inflates the baseline; that produced a fake "53% win" once.
- **Profile before guessing at CPU.** `perf/bench/profile.mjs` found the
  single biggest win in the codebase (change 6) in one run.

For anything only verifiable on the real deployment, add it to `PERF_NOTES.md`
under "To verify in production" with exactly what to measure.

### Getting evidence from the owner's instance

The owner runs this in production and can supply real data — a HAR capture of a
slow page, `config/logs/*.json`, row counts, a redacted `settings.json`. Ask
when it would settle a question; it has already produced two of the best fixes.

Do this with it: read it **outside the repo tree** (Prettier and ESLint will
trip over files left inside it), never commit any of it, and keep secrets out of
`PERF_NOTES.md` and commit messages. Their instance: Jellyfin, locale `fr`,
1 Radarr, 1 Sonarr, ~523 media / 269 requests / 10 users, Docker Desktop on a
Hyper-V Windows VM with a named volume for `/app/config`.

---

## Where to look (likely suspects, in rough priority order)

Investigate these, but trust your measurements over this list.

1. **External API calls (TMDB, media server, Sonarr/Radarr)**: sequential calls that could run in parallel, the same data fetched several times per request, missing or too-short caching, no request deduplication, N calls in a loop instead of batching.
2. **Database access**: N+1 queries, loading relations that aren't used, fetching full entities when a few columns suffice, missing pagination, repeated identical queries within one request. (Remember: query-level fixes only, no schema changes.)
3. **SQLite/Postgres connection settings**: check what's configured (journal mode, pool size, etc.). Connection-level options are allowed if they don't touch the schema and stay safe for an existing database. Document any change clearly.
4. **Background jobs** (availability sync, library scans, etc.): blocking the event loop, doing too much work at once, running redundant work.
5. **API responses**: oversized payloads, data sent that the frontend never uses (only trim internal endpoints used by this frontend; public API shapes stay the same).
6. **Frontend**: over-fetching (SWR/revalidation storms, duplicate requests on the same page), unnecessary re-renders, large bundles and heavy imports that could be split or lazy-loaded, image loading.
7. **Synchronous or CPU-heavy code** on hot request paths.

---

## Docker & CI — done, keep it working

This is already set up. Don't redo it; do keep it intact when rebasing.

- Every job in upstream's publishing workflows (`release`, `preview`, `helm`,
  `docs-deploy`, `create-tag`, `trivy-scan`) carries
  `if: github.repository == 'seerr-team/seerr'`, so none run here. Guards, not
  deletions, so upstream edits still merge. `ci.yml`/`cypress.yml` are untouched.
- `.github/workflows/fork-image.yml` is the **only** workflow here that pushes:
  from `adam`, linux/amd64 only, to `ghcr.io/<owner>/seerr`, `GITHUB_TOKEN` with
  `packages: write`. Tags `vX.Y.Z-adam.N` + `sha-<short>`, never `latest`.
  `N` is `github.run_number`. `X.Y.Z` is the newest `v*` tag by version order —
  **not** `git describe`, which reports `v1.3.0` from this branch because
  upstream tags releases on `main`. Current base: **v3.4.1**.
- The `Dockerfile` must keep building a working image. Verify with:
  `docker build --build-arg COMMIT_TAG=test -t seerr-check . && docker run --rm -p 5056:5055 seerr-check`
  then check `/api/v1/status`.

---

## `PERF_NOTES.md`

Keep this file at the repo root, always up to date. Sections:

- **Baseline**: environment, pre-existing failures, initial measurements.
- **Changes**: one entry per commit (problem, cause, fix, before/after, risk).
- **Proposed, not implemented**: things that would help but break the hard rules (schema changes, behavior changes…).
- **To verify in production**: what the owner must measure on the real deployment.

## Working style

- Work autonomously. Don't stop to ask permission for routine steps.
- If you're unsure whether something breaks a hard rule, **it does**: don't do it, and note it in `PERF_NOTES.md`.
- Prefer a few big, well-measured wins over many micro-optimizations.
