# CLAUDE.md — Seerr performance fork

## Context

This repo is a personal fork of `seerr-team/seerr` (TypeScript: Next.js/React frontend, Node/Express backend, TypeORM with SQLite or Postgres).

**The only goal of this fork is speed.** Upstream Seerr works fine functionally, but it is very slow (page loads, discover/search, request lists, admin pages, background jobs). Make it fast without changing what it does.

This fork is deployed as a Docker image and will run **on top of an existing production data volume** (existing database + `settings.json`). The owner must be able to go back to the official upstream image at any time. Every rule below follows from that.

You are running in a fresh, empty GitHub Codespace. Nothing is preinstalled for you: install whatever you need yourself.

---

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

## Setup (first session)

1. Read `package.json` (`engines`, `packageManager`, `scripts`) and any `.nvmrc`/`.node-version` to find the right Node and pnpm versions. Install them (e.g. via `nvm` + `corepack enable`). Don't guess versions.
2. `pnpm install`
3. Run the full validation suite once (see below) to get a clean baseline **before changing anything**. If something already fails on untouched code, note it in `PERF_NOTES.md` and don't try to fix it unless it blocks you.
4. Git remotes: `origin` = this fork. Add `upstream` = `https://github.com/seerr-team/seerr.git` if missing.
5. Read `CONTRIBUTING.md` and the existing code structure (`server/` and `src/`) before optimizing anything.

## Validation (run before every commit)

Use the scripts actually defined in `package.json`. At minimum:

- `pnpm build` (must pass)
- typecheck (`tsc --noEmit` or the repo's script)
- lint
- tests, if any exist

A commit that doesn't pass all of these doesn't get made.

---

## Method: measure first, then optimize

**Don't optimize by guessing.** For every change:

1. Identify the slow path and **measure it** (timings, number of queries, number of external HTTP calls, payload size, bundle size…).
2. Change the code.
3. Measure again under the same conditions.
4. Log it in `PERF_NOTES.md`: what was slow, why, what you changed, before/after numbers, risk level.

If the gain isn't measurable or is negligible, revert it. Complexity has to be paid for with real speed.

### About measuring in this Codespace

There is no real Jellyfin/Plex/Sonarr/Radarr here, and no production data. So:

- Where you can run the app, measure locally (you may seed a local test DB with fake data; never use real data).
- Where you can't, rely on solid evidence instead: counting queries per request (TypeORM logging), counting external calls, profiling isolated functions, analyzing Next.js build output and bundle sizes.
- For anything that can only be verified on the real deployment, add it to `PERF_NOTES.md` under "To verify in production" with exactly what to measure.

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

## Docker & CI

- The existing `Dockerfile` must keep building and producing a working image.
- Disable upstream's GitHub Actions workflows that publish images or releases to upstream's registries (delete them or restrict them so they never run in this fork).
- Add one workflow that builds the image from the `adam` branch and pushes it to GHCR (`ghcr.io/<owner>/seerr`), **linux/amd64 only**, using `GITHUB_TOKEN` with `packages: write`.
- Image tags: `vX.Y.Z-adam.N`, where `X.Y.Z` is the upstream version this branch is based on and `N` increments with each fork build. Also push a `sha-<short>` tag. Don't use `latest`.

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
