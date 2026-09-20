const BASE = 'http://localhost:5055';
const r = await fetch(`${BASE}/api/v1/auth/local`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'admin@seerr.dev', password: 'test1234' }),
});
const cookie = (r.headers.getSetCookie?.() || [])
  .map((c) => c.split(';')[0])
  .join('; ');
async function page(path, runs = 9) {
  const s = [];
  await fetch(`${BASE}${path}`, { headers: { cookie } }).then((r) =>
    r.arrayBuffer()
  ); // warm
  for (let i = 0; i < runs; i++) {
    const t = process.hrtime.bigint();
    const res = await fetch(`${BASE}${path}`, { headers: { cookie } });
    const b = await res.arrayBuffer();
    s.push({
      ms: Number(process.hrtime.bigint() - t) / 1e6,
      status: res.status,
      bytes: b.byteLength,
    });
  }
  s.sort((a, b) => a.ms - b.ms);
  const m = s[Math.floor(s.length / 2)];
  console.log(
    `${path.padEnd(22)} median ${m.ms.toFixed(1).padStart(7)}ms  min ${s[0].ms.toFixed(1).padStart(6)}ms  max ${s[s.length - 1].ms.toFixed(1).padStart(7)}ms  ${(m.bytes / 1024).toFixed(0)}KB  ${m.status}`
  );
}
console.log('\n=== SSR page loads (HTML document, warm) ===\n');
for (const p of [
  '/',
  '/discover/movies',
  '/tv/1399',
  '/movie/550',
  '/requests',
  '/users',
])
  await page(p);
