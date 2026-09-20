import { login, report, timeOne } from './measure.mjs';
await login();

// Distinct popular TMDB ids => guaranteed cache miss each time.
const MOVIES = [
  550, 680, 13, 155, 27205, 157336, 19995, 24428, 299536, 496243, 278, 238, 424,
  129, 389,
];
const TV = [
  1399, 1396, 66732, 60625, 1402, 456, 62286, 71446, 94605, 82856, 1622, 4607,
  46648, 60735, 1668,
];

async function coldSeries(label, paths) {
  const samples = [];
  for (const p of paths) {
    const r = await timeOne(p);
    if (r.status !== 200) {
      console.log(`  ! ${p} -> ${r.status}`);
      continue;
    }
    samples.push(r.ms);
  }
  samples.sort((a, b) => a - b);
  return {
    label,
    path: '(cold, distinct ids)',
    median: samples[Math.floor(samples.length / 2)],
    min: samples[0],
    max: samples[samples.length - 1],
    bytes: 0,
    status: 200,
    n: samples.length,
  };
}

const rows = [];
rows.push(
  await coldSeries(
    'movie detail',
    MOVIES.map((i) => `/api/v1/movie/${i}`)
  )
);
rows.push(
  await coldSeries(
    'tv detail',
    TV.map((i) => `/api/v1/tv/${i}`)
  )
);
rows.push(
  await coldSeries(
    'movie ratingscombined',
    MOVIES.map((i) => `/api/v1/movie/${i}/ratingscombined`)
  )
);
rows.push(
  await coldSeries(
    'tv season 1',
    TV.map((i) => `/api/v1/tv/${i}/season/1`)
  )
);
rows.push(
  await coldSeries(
    'movie recommendations',
    MOVIES.map((i) => `/api/v1/movie/${i}/recommendations`)
  )
);
rows.push(
  await coldSeries(
    'movie similar',
    MOVIES.map((i) => `/api/v1/movie/${i}/similar`)
  )
);

console.log('\n=== COLD CACHE (each request a distinct, unseen TMDB id) ===\n');
report(rows);
console.log(`\nsamples per row: ${rows.map((r) => r.n).join(', ')}`);
