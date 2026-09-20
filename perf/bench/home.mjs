import { chromium } from 'playwright'; // npm i playwright && npx playwright install chromium
const BASE = 'http://localhost:5055';
const label = process.argv[2] || 'run';
const ROUNDS = Number(process.argv[3] || 5);

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const runs = [];
for (let r = 0; r < ROUNDS; r++) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  // log in once per context
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    await fetch('/api/v1/auth/local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@seerr.dev', password: 'test1234' }),
    });
  });
  const calls = [];
  page.on('response', async (res) => {
    const u = new URL(res.url());
    if (u.pathname.startsWith('/api/v1/'))
      calls.push({ p: u.pathname, s: res.status() });
  });
  const t0 = Date.now();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 60000 });
  const total = Date.now() - t0;
  const byPath = {};
  for (const c of calls) {
    const k = c.p.replace(/\/\d+$/, '/:id');
    byPath[k] = (byPath[k] || 0) + 1;
  }
  runs.push({ total, n: calls.length, byPath });
  await ctx.close();
}
await browser.close();
const totals = runs.map((r) => r.total).sort((a, b) => a - b);
const ns = runs.map((r) => r.n).sort((a, b) => a - b);
const agg = {};
for (const r of runs)
  for (const [k, v] of Object.entries(r.byPath))
    agg[k] = Math.max(agg[k] || 0, v);
console.log(
  JSON.stringify(
    {
      label,
      medianLoadMs: totals[Math.floor(totals.length / 2)],
      minLoadMs: totals[0],
      medianApiCalls: ns[Math.floor(ns.length / 2)],
      breakdown: Object.fromEntries(
        Object.entries(agg).sort((a, b) => b[1] - a[1])
      ),
    },
    null,
    1
  )
);
