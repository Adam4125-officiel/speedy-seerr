const BASE = 'http://localhost:5055';
const r = await fetch(`${BASE}/api/v1/auth/local`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'admin@seerr.dev', password: 'test1234' }),
});
const cookie = (r.headers.getSetCookie?.() || [])
  .map((c) => c.split(';')[0])
  .join('; ');
const N = 40;
const out = { label: process.argv[2] };
for (const p of ['/requests', '/users', '/']) {
  for (let i = 0; i < 5; i++)
    await fetch(`${BASE}${p}`, { headers: { cookie } }).then((r) =>
      r.arrayBuffer()
    );
  const s = [];
  for (let i = 0; i < N; i++) {
    const t = process.hrtime.bigint();
    await fetch(`${BASE}${p}`, { headers: { cookie } }).then((r) =>
      r.arrayBuffer()
    );
    s.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  s.sort((a, b) => a - b);
  out[p] = {
    median: +s[Math.floor(N / 2)].toFixed(2),
    p25: +s[Math.floor(N * 0.25)].toFixed(2),
    p75: +s[Math.floor(N * 0.75)].toFixed(2),
    min: +s[0].toFixed(2),
  };
}
console.log(JSON.stringify(out));
