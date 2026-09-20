import { BASE, login } from './measure.mjs';
const TRACE = 'http://127.0.0.1:5099';
const cookie = await login();
const MOVIES = [550, 680, 13, 155, 27205, 157336, 19995, 24428, 299536, 496243];
const TV = [1399, 1396, 66732, 60625, 1402];
const post = (tmdbId, mediaType) =>
  fetch(`${BASE}/api/v1/watchlist`, {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tmdbId, mediaType }),
  });
// 1st pass: create them (real work, expected)
for (const id of MOVIES) await post(id, 'movie');
for (const id of TV) await post(id, 'tv');
// 2nd pass: every one is now a duplicate -- this is the user's ~142-title burst
await fetch(`${TRACE}/reset`);
const t = process.hrtime.bigint();
const res = await Promise.all([
  ...MOVIES.map((i) => post(i, 'movie')),
  ...TV.map((i) => post(i, 'tv')),
]);
const ms = Number(process.hrtime.bigint() - t) / 1e6;
const ev = (await (await fetch(`${TRACE}/dump`)).json()).filter(
  (e) => !/127\.0\.0\.1|localhost/.test(e.host)
);
console.log(
  JSON.stringify({
    label: process.argv[2],
    duplicatePosts: res.length,
    statuses: [...new Set(res.map((r) => r.status))],
    burstMs: +ms.toFixed(1),
    externalCalls: ev.length,
    hosts: ev.reduce((a, e) => ((a[e.host] = (a[e.host] || 0) + 1), a), {}),
  })
);
