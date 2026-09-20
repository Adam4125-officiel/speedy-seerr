import { BASE, login } from './measure.mjs';
const cookie = await login();
// Replicates the user's home-page burst: sliders + per-card title lookups, all at once.
const paths = [
  '/api/v1/settings/public',
  '/api/v1/auth/me',
  '/api/v1/status',
  '/api/v1/request/count',
  '/api/v1/issue/count',
  '/api/v1/media?filter=allavailable&take=20&sort=mediaAdded',
  '/api/v1/request?filter=all&take=10&sort=added&skip=0',
  '/api/v1/discover/watchlist',
  '/api/v1/discover/trending',
  '/api/v1/discover/movies',
  '/api/v1/discover/tv',
  '/api/v1/discover/movies?page=2',
  '/api/v1/discover/tv?page=2',
  '/api/v1/discover/genreslider/movie',
  '/api/v1/discover/genreslider/tv',
  ...[550, 680, 13, 155, 27205, 157336, 19995, 24428, 299536, 496243].map(
    (i) => `/api/v1/movie/${i}`
  ),
  ...[1399, 1396, 66732, 60625, 1402].map((i) => `/api/v1/tv/${i}`),
];
const ROUNDS = Number(process.argv[2] || 6);
for (let w = 0; w < 2; w++)
  await Promise.all(
    paths.map((p) =>
      fetch(`${BASE}${p}`, { headers: { cookie } }).then((r) => r.arrayBuffer())
    )
  );
const wall = [];
for (let r = 0; r < ROUNDS; r++) {
  const t = process.hrtime.bigint();
  await Promise.all(
    paths.map((p) =>
      fetch(`${BASE}${p}`, { headers: { cookie } }).then((r) => r.arrayBuffer())
    )
  );
  wall.push(Number(process.hrtime.bigint() - t) / 1e6);
}
wall.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    concurrent: paths.length,
    rounds: ROUNDS,
    burstMedianMs: +wall[Math.floor(wall.length / 2)].toFixed(1),
    burstMinMs: +wall[0].toFixed(1),
  })
);
