import { createHash } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { BASE, login } from './measure.mjs';
const cookie = await login();
const outDir = process.argv[2];
mkdirSync(outDir, { recursive: true });
const paths = [
  '/api/v1/settings/public',
  '/api/v1/auth/me',
  '/api/v1/request?filter=all&take=10&sort=added&skip=0',
  '/api/v1/media?filter=allavailable&take=20&sort=mediaAdded',
  '/api/v1/request/count',
  '/api/v1/issue/count',
  '/api/v1/discover/movies',
  '/api/v1/discover/tv',
  '/api/v1/discover/trending',
  '/api/v1/discover/watchlist',
  '/api/v1/discover/genreslider/movie',
  '/api/v1/discover/genreslider/tv',
  '/api/v1/movie/550',
  '/api/v1/movie/680',
  '/api/v1/tv/1399',
  '/api/v1/tv/1396',
  '/api/v1/tv/1399/season/1',
  '/api/v1/movie/550/recommendations',
  '/api/v1/movie/550/similar',
  '/api/v1/search?query=matrix',
  '/api/v1/person/287',
  '/api/v1/person/287/combined_credits',
  '/api/v1/settings/about',
  '/api/v1/user',
  '/api/v1/collection/1241',
  '/api/v1/languages',
  '/api/v1/genres/movie',
  '/api/v1/settings/radarr',
  '/api/v1/settings/sonarr',
  '/api/v1/settings/discover',
  '/api/v1/blocklist',
];
const out = {};
for (const p of paths) {
  const r = await fetch(`${BASE}${p}`, { headers: { cookie } });
  const body = Buffer.from(await r.arrayBuffer());
  out[p] = {
    status: r.status,
    len: body.length,
    sha: createHash('sha256').update(body).digest('hex'),
  };
  writeFileSync(`${outDir}/${Buffer.from(p).toString('base64url')}.bin`, body);
}
writeFileSync(`${outDir}/index.json`, JSON.stringify(out, null, 1));
console.log('captured', Object.keys(out).length, 'responses ->', outDir);
