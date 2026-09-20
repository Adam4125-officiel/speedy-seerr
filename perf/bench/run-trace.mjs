import { login, timeOne } from './measure.mjs';
const TRACE = 'http://127.0.0.1:5099';
await login();

async function traced(label, path) {
  await fetch(`${TRACE}/reset`);
  const r = await timeOne(path);
  const events = await (await fetch(`${TRACE}/dump`)).json();
  // ignore loopback (our own control/self calls)
  const ext = events.filter((e) => !/127\.0\.0\.1|localhost/.test(e.host));
  const byHost = {};
  for (const e of ext) byHost[e.host] = (byHost[e.host] || 0) + 1;
  // serialization depth: how many distinct "waves" (>8ms gap => next wave)
  const ts = ext.map((e) => e.t).sort((a, b) => a - b);
  let waves = ts.length ? 1 : 0;
  for (let i = 1; i < ts.length; i++) if (ts[i] - ts[i - 1] > 8) waves++;
  return {
    label,
    path,
    ms: r.ms,
    status: r.status,
    calls: ext.length,
    waves,
    byHost,
  };
}

// use ids not yet fetched in this process so the cache is cold
const cases = [
  ['movie detail', '/api/v1/movie/671'],
  ['movie ratingscombined', '/api/v1/movie/672/ratingscombined'],
  ['tv detail', '/api/v1/tv/1416'],
  ['tv season 1', '/api/v1/tv/1418/season/1'],
  ['movie recommendations', '/api/v1/movie/673/recommendations'],
  ['discover movies', '/api/v1/discover/movies?page=3'],
  ['discover trending', '/api/v1/discover/trending?page=2'],
  ['search', '/api/v1/search?query=inception'],
  ['genre slider movies', '/api/v1/discover/genreslider/movie'],
];

console.log('\n=== OUTBOUND CALLS PER REQUEST (cold cache) ===\n');
console.log('route                     time     ext-calls  waves   hosts');
console.log('-'.repeat(78));
for (const [l, p] of cases) {
  const r = await traced(l, p);
  const hosts = Object.entries(r.byHost)
    .map(([h, n]) => `${h}×${n}`)
    .join(' ');
  console.log(
    `${l.padEnd(24)} ${r.ms.toFixed(0).padStart(6)}ms ${String(r.calls).padStart(9)} ${String(r.waves).padStart(6)}   ${hosts}`
  );
}
