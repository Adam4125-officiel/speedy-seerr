const BASE = 'http://localhost:5055';
const r = await fetch(`${BASE}/api/v1/auth/local`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'admin@seerr.dev', password: 'test1234' }),
});
const cookie = (r.headers.getSetCookie?.() || [])
  .map((c) => c.split(';')[0])
  .join('; ');
const CONC = 16,
  ROUNDS = 12,
  PATH = '/requests';
for (let i = 0; i < 8; i++)
  await fetch(`${BASE}${PATH}`, { headers: { cookie } }).then((r) =>
    r.arrayBuffer()
  );
const all = [];
const wall = [];
for (let round = 0; round < ROUNDS; round++) {
  const t0 = process.hrtime.bigint();
  await Promise.all(
    Array.from({ length: CONC }, async () => {
      const t = process.hrtime.bigint();
      await fetch(`${BASE}${PATH}`, { headers: { cookie } }).then((r) =>
        r.arrayBuffer()
      );
      all.push(Number(process.hrtime.bigint() - t) / 1e6);
    })
  );
  wall.push(Number(process.hrtime.bigint() - t0) / 1e6);
}
all.sort((a, b) => a - b);
wall.sort((a, b) => a - b);
const q = (a, p) => +a[Math.floor(a.length * p)].toFixed(1);
console.log(
  JSON.stringify({
    label: process.argv[2],
    conc: CONC,
    reqMedian: q(all, 0.5),
    reqP95: q(all, 0.95),
    batchWallMedian: q(wall, 0.5),
    throughputRps: +(CONC / (q(wall, 0.5) / 1000)).toFixed(1),
  })
);
