const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer, parseRetryAfter } = require('../server.js');

async function start(opts) {
  const server = createServer(opts);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}
const stop = (server) => { server.closeAllConnections(); server.close(); };

async function readNdjson(res) {
  const text = await res.text();
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const post = (base, body, init = {}) =>
  fetch(base + '/api/titles', { method: 'POST', body: JSON.stringify(body), ...init });

test('streams start/done NDJSON in order with concurrency 1', async () => {
  const log = [];
  const { server, base } = await start({
    config: { DELAY_MS: 0, CONCURRENCY: 1 },
    fetchTitle: async (url) => { log.push(url); return { url, status: 200, title: 'T ' + url }; },
  });
  try {
    const res = await post(base, { urls: ['a', 'b', 'c'] });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/x-ndjson/);
    const events = await readNdjson(res);
    assert.deepEqual(events, [
      { type: 'start', index: 0 }, { type: 'done', index: 0, status: 200, title: 'T a' },
      { type: 'start', index: 1 }, { type: 'done', index: 1, status: 200, title: 'T b' },
      { type: 'start', index: 2 }, { type: 'done', index: 2, status: 200, title: 'T c' },
    ]);
  } finally { stop(server); }
});

test('done carries error when fetchTitle reports one', async () => {
  const { server, base } = await start({
    config: { DELAY_MS: 0 },
    fetchTitle: async (url) => ({ url, status: 0, title: '', error: 'Timeout after 10000ms' }),
  });
  try {
    const events = await readNdjson(await post(base, { urls: ['a'] }));
    assert.deepEqual(events[1], { type: 'done', index: 0, status: 0, title: '', error: 'Timeout after 10000ms' });
  } finally { stop(server); }
});

test('DELAY_MS with ±30% jitter is applied between requests (not before the first)', async () => {
  const times = [];
  const { server, base } = await start({
    config: { DELAY_MS: 200, CONCURRENCY: 1 },
    fetchTitle: async (url) => { times.push(Date.now()); return { url, status: 200, title: '' }; },
  });
  try {
    const t0 = Date.now();
    await readNdjson(await post(base, { urls: ['a', 'b', 'c'] }));
    assert.ok(times[0] - t0 < 100, 'first request is not delayed');
    for (let i = 1; i < times.length; i++) {
      const gap = times[i] - times[i - 1];
      assert.ok(gap >= 130 && gap <= 330, `gap ${gap}ms should be within 200ms ±30% (+ scheduling slack)`);
    }
  } finally { stop(server); }
});

test('CONCURRENCY > 1 runs requests in parallel', async () => {
  let inFlight = 0;
  let peak = 0;
  const { server, base } = await start({
    config: { DELAY_MS: 0, CONCURRENCY: 2 },
    fetchTitle: async (url) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      return { url, status: 200, title: '' };
    },
  });
  try {
    const events = await readNdjson(await post(base, { urls: ['a', 'b', 'c', 'd'] }));
    assert.equal(peak, 2);
    assert.equal(events.filter((e) => e.type === 'done').length, 4);
  } finally { stop(server); }
});

test('429 honors Retry-After, retries, then succeeds', async () => {
  const calls = [];
  const { server, base } = await start({
    config: { DELAY_MS: 0 },
    fetchTitle: async (url) => {
      calls.push(Date.now());
      return calls.length < 3
        ? { url, status: 429, title: '', error: 'HTTP 429', retryAfter: '0' }
        : { url, status: 200, title: 'Finally' };
    },
  });
  try {
    const events = await readNdjson(await post(base, { urls: ['a'] }));
    assert.equal(calls.length, 3);
    assert.deepEqual(events, [
      { type: 'start', index: 0 },
      { type: 'done', index: 0, status: 200, title: 'Finally' },
    ]);
  } finally { stop(server); }
});

test('503 without Retry-After waits the default, gives up after 2 retries and marks failed', async () => {
  const calls = [];
  const { server, base } = await start({
    config: { DELAY_MS: 0 },
    retryDefaultMs: 100,
    fetchTitle: async (url) => { calls.push(Date.now()); return { url, status: 503, title: '', error: 'HTTP 503' }; },
  });
  try {
    const events = await readNdjson(await post(base, { urls: ['a', 'b'] }));
    assert.equal(calls.length, 3 + 3, '1 try + 2 retries per URL');
    assert.ok(calls[1] - calls[0] >= 90, 'default wait between retries');
    const done = events.filter((e) => e.type === 'done');
    assert.equal(done.length, 2);
    assert.equal(done[0].status, 503);
    assert.match(done[0].error, /gave up after 2 retries/);
  } finally { stop(server); }
});

test('Retry-After is capped', async () => {
  const calls = [];
  const { server, base } = await start({
    config: { DELAY_MS: 0 },
    retryCapMs: 50,
    fetchTitle: async (url) => {
      calls.push(Date.now());
      return calls.length < 2 ? { url, status: 429, title: '', retryAfter: '9999' } : { url, status: 200, title: 'ok' };
    },
  });
  try {
    const t0 = Date.now();
    await readNdjson(await post(base, { urls: ['a'] }));
    assert.ok(Date.now() - t0 < 1000);
  } finally { stop(server); }
});

test('client cancel stops scheduling new requests', async () => {
  let calls = 0;
  const { server, base } = await start({
    config: { DELAY_MS: 50, CONCURRENCY: 1 },
    fetchTitle: async (url) => { calls++; return { url, status: 200, title: '' }; },
  });
  try {
    const ctrl = new AbortController();
    const res = await post(base, { urls: Array.from({ length: 50 }, (_, i) => 'u' + i) }, { signal: ctrl.signal });
    const reader = res.body.getReader();
    await reader.read(); // first chunk (start event)
    ctrl.abort();
    await reader.read().catch(() => {});
    const seen = calls;
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(calls <= seen + 1, `calls kept growing after cancel (${seen} -> ${calls})`);
    assert.ok(calls < 5);
  } finally { stop(server); }
});

test('invalid requests get 400; wrong method gets 405', async () => {
  const { server, base } = await start({ config: { MAX_URLS: 2 } });
  try {
    assert.equal((await post(base, { nope: 1 })).status, 400);
    assert.equal((await post(base, { urls: [1] })).status, 400);
    assert.equal((await fetch(base + '/api/titles', { method: 'POST', body: 'not json' })).status, 400);
    assert.equal((await post(base, { urls: ['a', 'b', 'c'] })).status, 400);
    assert.equal((await fetch(base + '/api/titles')).status, 405);
  } finally { stop(server); }
});

test('still serves static files and blocks traversal', async () => {
  const { server, base } = await start();
  try {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /url-builder/);
    assert.equal((await fetch(base + '/generator.js')).status, 200);
    assert.equal((await fetch(base + '/nope.txt')).status, 404);
    const raw = await fetch(base + '/..%2Fconfig.js');
    assert.ok([403, 404].includes(raw.status));
  } finally { stop(server); }
});

test('parseRetryAfter handles seconds, dates and junk', () => {
  assert.equal(parseRetryAfter('7'), 7000);
  assert.equal(parseRetryAfter(undefined), null);
  assert.equal(parseRetryAfter('soon'), null);
  const ms = parseRetryAfter(new Date(Date.now() + 5000).toUTCString());
  assert.ok(ms > 3000 && ms <= 5000);
});
