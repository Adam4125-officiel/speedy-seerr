import { bench, login, report } from './measure.mjs';

await login();
const routes = [
  ['movie detail', '/api/v1/movie/550'],
  ['movie ratingscombined', '/api/v1/movie/550/ratingscombined'],
  ['movie recommendations', '/api/v1/movie/550/recommendations'],
  ['tv detail', '/api/v1/tv/1399'],
  ['tv season', '/api/v1/tv/1399/season/1'],
  ['discover movies', '/api/v1/discover/movies'],
  ['discover tv', '/api/v1/discover/tv'],
  ['discover trending', '/api/v1/discover/trending'],
  ['search', '/api/v1/search?query=matrix'],
  ['request list', '/api/v1/request?take=20'],
  ['auth/me', '/api/v1/auth/me'],
  ['settings/public', '/api/v1/settings/public'],
  ['person detail', '/api/v1/person/287'],
  ['person combined', '/api/v1/person/287/combined_credits'],
];
const rows = [];
for (const [label, path] of routes)
  rows.push(await bench(label, path, { runs: 7 }));
console.log('\n=== WARM CACHE (server-side TMDB cache primed) ===\n');
report(rows);
