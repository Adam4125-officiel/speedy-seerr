// Preloaded via NODE_OPTIONS=--require. Counts outbound HTTP(S) requests by host,
// and exposes per-window counting over a local control port. No source changes.
const http = require('http');
const https = require('https');

const state = { events: [] };

function record(mod, args) {
  try {
    let host = '?';
    let path = '';
    const a = args[0];
    if (typeof a === 'string') {
      const u = new URL(a);
      host = u.host;
      path = u.pathname;
    } else if (a && typeof a === 'object') {
      host = a.host || a.hostname || '?';
      path = a.path || a.pathname || '';
    }
    if (typeof args[1] === 'object' && args[1] && !path)
      path = args[1].path || '';
    state.events.push({
      t: Date.now(),
      host,
      path: String(path).split('?')[0],
    });
  } catch {
    /* never break the app for tracing */
  }
}

for (const mod of [http, https]) {
  const origReq = mod.request;
  const origGet = mod.get;
  mod.request = function (...args) {
    record(mod, args);
    return origReq.apply(this, args);
  };
  mod.get = function (...args) {
    record(mod, args);
    return origGet.apply(this, args);
  };
}

// Control server: GET /reset clears, GET /dump returns events since reset.
http
  .createServer((req, res) => {
    if (req.url === '/reset') {
      state.events = [];
      res.end('ok');
      return;
    }
    if (req.url === '/dump') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(state.events));
      return;
    }
    res.statusCode = 404;
    res.end();
  })
  .listen(5099, '127.0.0.1');
