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

Seven optimisations so far, all measured, plus the CI work.
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

All seven changes are verified on the owner's own hardware. `v3.4.1-adam.6`
was A/B'd against production and improved **every percentile** of server wait
with no crossover (p10 -33% through p99 -14%), cut total server wait by **51%**,
and shortened the home-page burst from 6.94 s to **4.17 s** with a matching call
composition. See "Verified on the owner's deployment, round 2" in
`PERF_NOTES.md`.

When capturing a HAR for comparison, **check no scheduled job is running on the
test container**. One capture was contaminated exactly that way and produced a
misleading split result — better in the middle of the distribution, worse at
both ends.

Best remaining leads, in order:

1. **`/api/v1/auth/me` fetched ~20 times per session**, once per navigation, all
   adding to the burst. Raising SWR's `dedupingInterval` in `useUser` to match
   its existing 30 s `refreshInterval` would collapse most of them without
   weakening the freshness the polling already guarantees — but it changes how
   fast a focus event picks up a permission change, **so ask the owner first.**
2. **`/discover/genreslider/*`** issues ~20 TMDB calls per request, right at the
   client's rate-limit cap. A longer TTL means visibly staler genre artwork, so
   this also needs the owner's call.
3. **`/discover/watchlist` payload** — returns whole User and Media entities
   where `seerr-api.yml` documents four scalar fields, 33 KB for 20 rows.
   Trimming it is a public API shape change, blocked by hard rule 4 unless the
   owner authorises it.
4. **304s.** 129 of 147 production responses were `304 Not Modified`, each
   having done the full work before the ETag comparison. Unexamined, and likely
   architectural.

Do **not** re-investigate `/api/v1/discover/watchlist` as a slow endpoint. It
looks like the worst one in the HAR at 3013 ms, but measured in isolation on the
owner's code path it runs in 23 ms — it is queueing behind the burst, not slow.
That is written up in `PERF_NOTES.md`.

One standing hazard from change 7: `getMovie`, `getTvShow` and `getTvSeason`
hand out **frozen, shared** cache entries. Anything that mutates their result
will throw. **Re-check those three after any rebase touching
`server/api/themoviedb/index.ts`.**

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

## Rebasing onto a newer upstream

This fork exists to be rebased. The whole diff is small on purpose: **11 files
under `server/` and `src/`, +167/-92**, no migrations, no entity columns.

```bash
git fetch upstream --tags
git checkout develop && git reset --hard upstream/develop   # mirror, never commit here
git checkout adam
git rebase upstream/develop
```

### Where conflicts are expected, and how to resolve them

| File | Why | Resolution |
|---|---|---|
| `server/api/themoviedb/index.ts` | changes 2 and 7 both touch it; most likely conflict | keep ours, re-audit (below) |
| `server/lib/cache.ts` | change 7 | keep the `shared`/`deepFreeze` logic |
| `server/index.ts` | change 6 deleted a middleware | **check it has not come back** |
| `src/pages/_app.tsx` | change 3 | keep the parallel fetch |
| `.github/workflows/*.yml` | the `if:` repository guards | keep the guard, take upstream's other edits |

If upstream has fixed one of these themselves, **drop our commit** rather than
forcing ours in. Check before assuming: `git log upstream/develop --oneline -20`.

### Mandatory post-rebase checks

1. **Re-audit the change 7 hazard.** `getMovie`, `getTvShow` and `getTvSeason`
   hand out **frozen, shared** cache entries. Confirm none of them, and nothing
   new that consumes them, mutates the result — a write to a frozen object
   throws. The audit that justified this is in `PERF_NOTES.md` under change 7.
   Re-run it:

   ```bash
   grep -nE "^\s+(data|show|movie|tv|season)\.[A-Za-z_]+\s*=[^=]" server/api/themoviedb/index.ts
   grep -rnE "^\s+[a-z][A-Za-z]*\.[A-Za-z_]+\s*=[^=>]" server/models/ server/routes/ --include=*.ts | grep -v test
   ```

2. **Confirm the `res.json` round-trip has not returned** to `server/index.ts`.
   If upstream enables `validateResponses`, change 6 must be reverted — the
   middleware exists for that, and the rationale for removing it was that
   response validation is off.

3. **Check the migration delta** before shipping, since it decides whether a
   rollback is possible by swapping the image:

   ```bash
   ls server/migration/sqlite/ | wc -l    # compare against the deployment's count
   ```

4. Run the full validation suite, then re-measure with `perf/`. Do not assume
   the old numbers still hold — upstream may have fixed or changed any of these
   paths.

5. Rebuild the image and re-run the A/B in the runbook in `PERF_NOTES.md`
   before the owner deploys it.

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

## Working with the owner

The owner runs this in production and is the only person who can touch that
deployment. **Assume they have done nothing since the last session** — no
rebase, no build, no image pulled, nothing deployed. Do the code work yourself
first, then bring them in.

When anything has to happen on their machine, **go one step at a time and wait
for the output before giving the next step.** They asked for this explicitly and
it has caught real problems: a botched `jq` command, a container that had not
finished booting, a capture contaminated by a background job. A wall of
instructions would have buried all three.

- Give **exact, copy-pasteable commands**. They should never have to edit a
  path, a name or a port.
- Their environment: **PowerShell**, on a Windows Hyper-V VM, Docker Desktop.
  Container `seerr` on port 5055, volume `seerr-data` -> `/app/config`, image
  `ghcr.io/seerr-team/seerr:latest`. A stopped `seerr-test` on 5056 with
  `seerr-data-test` is kept deliberately as a fallback.
- **Quoting rule that has cost several attempts:** pass `sh -c` scripts in
  **double** quotes with **single** quotes inside. Docker's Windows CLI strips
  inner double quotes, and `\"` is a bash escape PowerShell does not honour.
  PowerShell continuation is a backtick, not a backslash — prefer one-liners.
- Say what each step will do before it does it, and what output means success.
  Tell them plainly when a step is destructive or causes downtime; they can
  schedule maintenance, but only if they are told in advance.
- They are a capable operator, not a Seerr developer. Explain *why* a step
  matters — "stop the container first, copying a live SQLite file gives a
  corrupt backup" — rather than just issuing it.
- When they report something odd ("I think a task was running"), **check it
  against the data** rather than accepting or dismissing it. That specific
  hunch was right and was confirmed from the container log and HAR timestamps.

The two runbooks in `PERF_NOTES.md` — testing an image beside production, and
rolling back — are written to be followed in this style.

## Deployment state — NOT deployed yet

As of the end of the 2026-09-20 session, **production is still running upstream
`v3.4.1` and has never been touched.** `v3.4.1-adam.6` is built, pushed and
verified beside it, but not deployed. Nothing is half-finished; the deployment
simply had not started when the owner had to stop.

What is already in place:

| | |
|---|---|
| production container | `seerr`, port 5055, volume `seerr-data` -> `/app/config` |
| production image | `ghcr.io/seerr-team/seerr:latest` = **v3.4.1** |
| managed by | **Docker Compose**, project `seerr`, service `seerr` |
| compose file | `C:\Users\Adrrrr\seerr\docker-compose.yml` |
| healthcheck | `wget --spider http://localhost:5055/api/v1/status`, 15s interval, 30s timeout, 20s start period, 3 retries |
| restart policy | `unless-stopped` |
| rollback image | pinned as `seerr:rollback`, digest in `C:\seerr-backup\rollback-image-digest.txt` |
| container inspect | `C:\seerr-backup\seerr-container-inspect.json` |
| fallback instance | `seerr-test` (stopped) on 5056 with volume `seerr-data-test`, already running adam.6 — the owner wants both kept |

Because it is Compose-managed, deploying is **one `image:` line** plus
`docker compose up -d`. Do not reconstruct a `docker run`: the healthcheck,
restart policy, networks and any proxy labels come from that file and would be
silently lost.

### Where the deployment was interrupted, and what remains

The next steps, in order, each waiting on the owner's output:

1. **Read `C:\Users\Adrrrr\seerr\docker-compose.yml`** before editing it, and
   copy it to `C:\seerr-backup\`. Three things need checking in it: whether
   `image:` is pinned to `:latest`; whether any other service could auto-update
   it (**Watchtower would silently revert the deployment**); and whether the
   volume is external or Compose-managed, which sets the blast radius of a
   `docker compose down`.
2. `docker stop seerr-test` so it is not competing for CPU or the *arr APIs.
3. **Back up `seerr-data` with `seerr` stopped** — to a second volume *and* a
   tarball. Copying a live SQLite file yields a corrupt backup.
4. Verify that backup with `PRAGMA integrity_check` and a migration count
   **before** trusting it.
5. Change the `image:` line to `ghcr.io/adam4125-officiel/seerr:v3.4.1-adam.6`,
   then `docker compose up -d` from `C:\Users\Adrrrr\seerr`.
6. Watch the three upstream migrations apply, confirm the healthcheck goes
   healthy, and confirm `/api/v1/status` reports `v3.4.1-adam.6`.

**The rollback constraint is the thing to say out loud before step 5.** Three
upstream migrations apply on first start, one of which drops a unique
constraint the older image still expects. Once they have run, **restoring the
volume is the rollback** — swapping the image back is not sufficient. That is
why steps 3 and 4 are not optional.

## Working style

- Work autonomously. Don't stop to ask permission for routine steps.
- If you're unsure whether something breaks a hard rule, **it does**: don't do it, and note it in `PERF_NOTES.md`.
- Prefer a few big, well-measured wins over many micro-optimizations.
