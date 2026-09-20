import { readFileSync } from 'fs';
// Fill this dir with TMDB payloads first; see perf/README.md.
const dir =
  process.env.PERF_PAYLOAD_DIR ??
  new URL('./payloads/', import.meta.url).pathname;
const payloads = {
  discover: JSON.parse(readFileSync(dir + 'discover.json', 'utf8')),
  movie: JSON.parse(readFileSync(dir + 'movie.json', 'utf8')),
  tv: JSON.parse(readFileSync(dir + 'tv.json', 'utf8')),
};

const bench = (label, fn, iters) => {
  for (let i = 0; i < 50; i++) fn(); // warmup
  const t = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  console.log(`${label.padEnd(34)} ${(ms / iters).toFixed(3)} ms/op`);
};

for (const [name, data] of Object.entries(payloads)) {
  const bytes = Buffer.byteLength(JSON.stringify(data));
  console.log(`\n--- ${name} (${(bytes / 1024).toFixed(0)} KB) ---`);
  bench(`structuredClone`, () => structuredClone(data), 200);
  bench(
    `JSON.parse(JSON.stringify())`,
    () => JSON.parse(JSON.stringify(data)),
    200
  );
  bench(`JSON.stringify only`, () => JSON.stringify(data), 200);
}
