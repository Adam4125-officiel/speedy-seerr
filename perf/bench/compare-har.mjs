// Compare two HAR captures of the same app.
//   node perf/bench/compare-har.mjs <before.har> <after.har>
//
// Call counts are structural and immune to machine noise; treat them as the
// result. Wall-clock over a hand-driven session indicates direction only.
import { readFileSync } from 'fs';

const load = (f) =>
  JSON.parse(readFileSync(f, 'utf8')).log.entries.filter((e) =>
    e.request.url.includes('/api/v1/')
  );
const norm = (p) =>
  p.replace(/\/\d+(\/|$)/g, '/:id$1').replace(/\/\d+$/, '/:id');
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const q = (a, p) => [...a].sort((x, y) => x - y)[Math.floor(a.length * p)];

const [, , fa, fb] = process.argv;
if (!fa || !fb) {
  console.error('usage: compare-har.mjs <before.har> <after.har>');
  process.exit(2);
}
const A = load(fa);
const B = load(fb);

// --- transport sanity: comparing a proxied domain to localhost measures the proxy
const transport = (es) => {
  const v = {};
  for (const e of es)
    v[e.response.httpVersion] = (v[e.response.httpVersion] || 0) + 1;
  return v;
};
console.log(
  'transport  BEFORE',
  JSON.stringify(transport(A)),
  ' AFTER',
  JSON.stringify(transport(B))
);
if (
  JSON.stringify(Object.keys(transport(A)).sort()) !==
  JSON.stringify(Object.keys(transport(B)).sort())
) {
  console.log(
    '  ** WARNING: different protocols on each side, timings are not comparable **'
  );
}

// --- call counts per endpoint
const tally = (es) => {
  const m = {};
  for (const e of es) {
    const k = norm(new URL(e.request.url).pathname);
    m[k] = (m[k] || 0) + 1;
  }
  return m;
};
const ta = tally(A);
const tb = tally(B);
console.log('\npath'.padEnd(43) + 'BEFORE  AFTER   diff');
console.log('-'.repeat(65));
let sa = 0;
let sb = 0;
for (const k of [...new Set([...Object.keys(ta), ...Object.keys(tb)])].sort()) {
  const a = ta[k] || 0;
  const b = tb[k] || 0;
  sa += a;
  sb += b;
  const d = b - a;
  console.log(
    k.slice(0, 41).padEnd(43) +
      String(a).padStart(6) +
      String(b).padStart(7) +
      (d > 0 ? '+' + d : d === 0 ? '  .' : String(d)).padStart(7)
  );
}
console.log('-'.repeat(65));
console.log(
  'TOTAL'.padEnd(43) +
    String(sa).padStart(6) +
    String(sb).padStart(7) +
    String(sb - sa).padStart(7)
);

// --- server wait
const waits = (es) => es.map((e) => e.timings.wait);
console.log(
  `\nserver wait   median ${med(waits(A)).toFixed(0)}ms -> ${med(waits(B)).toFixed(0)}ms` +
    `   p95 ${q(waits(A), 0.95).toFixed(0)}ms -> ${q(waits(B), 0.95).toFixed(0)}ms`
);

// --- same-endpoint medians, which normalise for differing navigation
const group = (es) => {
  const m = {};
  for (const e of es)
    (m[norm(new URL(e.request.url).pathname)] ||= []).push(e.timings.wait);
  return m;
};
const ga = group(A);
const gb = group(B);
console.log('\nSAME-ENDPOINT median wait (n>=2 both sides)');
for (const k of Object.keys(ga)
  .filter((k) => (ga[k] || []).length >= 2 && (gb[k] || []).length >= 2)
  .sort()) {
  const a = med(ga[k]);
  const b = med(gb[k]);
  console.log(
    '  ' +
      k.replace('/api/v1', '').slice(0, 34).padEnd(36) +
      (a.toFixed(0) + 'ms').padStart(8) +
      ' -> ' +
      (b.toFixed(0) + 'ms').padStart(8) +
      (((b - a) / a) * 100 > 0 ? '  +' : '  ') +
      (((b - a) / a) * 100).toFixed(0) +
      '%'
  );
}

// --- the burst: widest group of calls starting within 1.5s
const burst = (es) => {
  const t0 = Math.min(...es.map((e) => new Date(e.startedDateTime).getTime()));
  const rows = es
    .map((e) => ({
      s: new Date(e.startedDateTime).getTime() - t0,
      d: e.time,
      w: e.timings.wait,
      p: norm(new URL(e.request.url).pathname),
    }))
    .sort((x, y) => x.s - y.s);
  let bi = 0;
  let bc = 0;
  for (let i = 0; i < rows.length; i++) {
    const n = rows.filter(
      (o) => o.s >= rows[i].s && o.s < rows[i].s + 1500
    ).length;
    if (n > bc) {
      bc = n;
      bi = i;
    }
  }
  const g = rows.filter((o) => o.s >= rows[bi].s && o.s < rows[bi].s + 1500);
  const peak = Math.max(
    ...rows.map(
      (r) => rows.filter((o) => o.s <= r.s && o.s + o.d >= r.s).length
    )
  );
  return {
    count: bc,
    peak,
    span: (Math.max(...g.map((x) => x.s + x.d)) - rows[bi].s) / 1000,
    maxWait: Math.max(...g.map((x) => x.w)),
    items: g,
  };
};
const ba = burst(A);
const bb = burst(B);
console.log('\nHOME-PAGE BURST            BEFORE     AFTER');
console.log(
  '  calls in burst      ' +
    String(ba.count).padStart(9) +
    String(bb.count).padStart(10)
);
console.log(
  '  peak concurrency    ' +
    String(ba.peak).padStart(9) +
    String(bb.peak).padStart(10)
);
console.log(
  '  end-to-end          ' +
    (ba.span.toFixed(2) + 's').padStart(9) +
    (bb.span.toFixed(2) + 's').padStart(10)
);
console.log(
  '  slowest call        ' +
    (ba.maxWait.toFixed(0) + 'ms').padStart(9) +
    (bb.maxWait.toFixed(0) + 'ms').padStart(10)
);

const comp = (b) =>
  Object.entries(
    b.items.reduce((a, x) => ((a[x.p] = (a[x.p] || 0) + 1), a), {})
  )
    .sort((x, y) => y[1] - x[1])
    .map(([k, v]) => k.replace('/api/v1', '') + '×' + v)
    .join(' ');
console.log('  BEFORE composition: ' + comp(ba));
console.log('  AFTER  composition: ' + comp(bb));

const st = (es) =>
  es.reduce(
    (a, e) => ((a[e.response.status] = (a[e.response.status] || 0) + 1), a),
    {}
  );
console.log(
  '\nstatus  BEFORE ' +
    JSON.stringify(st(A)) +
    '  AFTER ' +
    JSON.stringify(st(B))
);
