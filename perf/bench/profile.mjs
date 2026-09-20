import { execFileSync } from 'child_process';
const list = JSON.parse(
  await (await fetch('http://127.0.0.1:9229/json/list')).text()
);
const url = list[0].webSocketDebuggerUrl;
const ws = new WebSocket(url);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
};
await new Promise((r) => (ws.onopen = r));
await send('Profiler.enable');
await send('Profiler.setSamplingInterval', { interval: 100 });
await send('Profiler.start');
execFileSync('node', [new URL('./burst.mjs', import.meta.url).pathname, '8'], {
  stdio: 'inherit',
});
const { profile } = await send('Profiler.stop');
const fs = await import('fs');
fs.writeFileSync(process.argv[2], JSON.stringify(profile));
console.log(
  'profile written:',
  process.argv[2],
  '| samples:',
  profile.samples.length
);
ws.close();
