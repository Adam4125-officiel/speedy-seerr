const BASE = process.env.BASE || 'http://localhost:5055';

let cookie = '';
async function login() {
  const r = await fetch(`${BASE}/api/v1/auth/local`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@seerr.dev', password: 'test1234' }),
  });
  if (!r.ok) throw new Error(`login failed ${r.status} ${await r.text()}`);
  cookie = (r.headers.getSetCookie?.() || [])
    .map((c) => c.split(';')[0])
    .join('; ');
  return cookie;
}

async function timeOne(path, opts = {}) {
  const t = process.hrtime.bigint();
  const r = await fetch(`${BASE}${path}`, { headers: { cookie }, ...opts });
  const body = await r.arrayBuffer();
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  return { ms, status: r.status, bytes: body.byteLength };
}

export async function bench(label, path, { runs = 5, warm = true } = {}) {
  if (warm) await timeOne(path); // prime caches
  const samples = [];
  let last;
  for (let i = 0; i < runs; i++) {
    last = await timeOne(path);
    samples.push(last.ms);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  return {
    label,
    path,
    median,
    min: samples[0],
    max: samples[samples.length - 1],
    status: last.status,
    bytes: last.bytes,
  };
}

export function report(rows) {
  const w = Math.max(...rows.map((r) => r.label.length), 5);
  console.log(
    `${'route'.padEnd(w)}  ${'median'.padStart(9)} ${'min'.padStart(8)} ${'max'.padStart(8)}  ${'bytes'.padStart(8)}  status`
  );
  console.log('-'.repeat(w + 50));
  for (const r of rows) {
    console.log(
      `${r.label.padEnd(w)}  ${r.median.toFixed(1).padStart(7)}ms ${r.min.toFixed(1).padStart(7)}ms ${r.max.toFixed(1).padStart(7)}ms  ${String(r.bytes).padStart(8)}  ${r.status}`
    );
  }
}

export { BASE, login, timeOne };
