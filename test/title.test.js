const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const { fetchTitle, decodeEntities } = require('../lib/title.js');

let server;
let base;
let lastUserAgent;
const closed = {}; // path -> resolver called when the client drops the connection
const closedPromise = {};

function watchClose(name, res) {
  closedPromise[name] = new Promise((resolve) => res.on('close', resolve));
}

function streamForever(res, prefix) {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.write(prefix);
  const junk = 'x'.repeat(8192);
  const iv = setInterval(() => res.write(junk), 1);
  res.on('close', () => clearInterval(iv));
}

const html = (res, body, headers = {}) => {
  res.writeHead(200, { 'Content-Type': 'text/html', ...headers });
  res.end(body);
};

test.before(async () => {
  server = http.createServer((req, res) => {
    lastUserAgent = req.headers['user-agent'];
    switch (req.url) {
      case '/title':
        return html(res, '<html><head><meta charset="utf-8"><TITLE>\n  Tom &amp; Jerry &#39;s &#x41; &mdash; Home \n</TITLE></head><body>hi</body></html>');
      case '/no-title':
        return html(res, '<html><head></head><body>nothing here</body></html>');
      case '/og':
        return html(res, '<html><head><meta content="OG &quot;Title&quot;" property="og:title"><meta property="og:type" content="x"></head></html>');
      case '/og-single':
        return html(res, "<head><meta property='og:title' content='Single Quoted'></head>");
      case '/empty-title-og':
        return html(res, '<head><title> </title><meta property="og:title" content="Fallback"></head>');
      case '/title-after-head':
        return html(res, '<html><head></head><body><title>Too late</title></body></html>');
      case '/title-wins':
        return html(res, '<head><meta property="og:title" content="OG"><title>Real</title></head>');
      case '/gzip':
        return html(res, zlib.gzipSync('<head><title>Zipped</title></head>'), { 'Content-Encoding': 'gzip' });
      case '/huge-no-title':
        watchClose('huge-no-title', res);
        return streamForever(res, '<html><head>');
      case '/huge-after-title':
        watchClose('huge-after-title', res);
        return streamForever(res, '<html><head><title>Early</title>');
      case '/slow':
        // Never sends headers.
        return;
      case '/redirect':
        res.writeHead(302, { Location: '/title' });
        return res.end();
      case '/429':
        res.writeHead(429, { 'Retry-After': '7' });
        return res.end('slow down');
      case '/503':
        res.writeHead(503);
        return res.end();
      case '/404':
        res.writeHead(404, { 'Content-Type': 'text/html' });
        return res.end('<head><title>Not Found Page</title></head>');
      default:
        res.writeHead(404);
        res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.closeAllConnections();
  server.close();
});

test('title in head, entities decoded, whitespace trimmed', async () => {
  const r = await fetchTitle(base + '/title');
  assert.deepEqual(r, { url: base + '/title', status: 200, title: "Tom & Jerry 's A — Home" });
});

test('sends a browser-like User-Agent', async () => {
  await fetchTitle(base + '/title');
  assert.match(lastUserAgent, /Mozilla\/5\.0/);
});

test('no title and no og:title gives empty string', async () => {
  const r = await fetchTitle(base + '/no-title');
  assert.equal(r.status, 200);
  assert.equal(r.title, '');
  assert.equal(r.error, undefined);
});

test('og:title fallback (either attribute order, either quote style)', async () => {
  assert.equal((await fetchTitle(base + '/og')).title, 'OG "Title"');
  assert.equal((await fetchTitle(base + '/og-single')).title, 'Single Quoted');
});

test('empty <title> falls back to og:title', async () => {
  assert.equal((await fetchTitle(base + '/empty-title-og')).title, 'Fallback');
});

test('<title> beats og:title', async () => {
  assert.equal((await fetchTitle(base + '/title-wins')).title, 'Real');
});

test('stops at </head>: a title in the body is ignored', async () => {
  assert.equal((await fetchTitle(base + '/title-after-head')).title, '');
});

test('gzip responses are decoded', async () => {
  assert.equal((await fetchTitle(base + '/gzip')).title, 'Zipped');
});

test('huge body with no title is cut off at MAX_BYTES and the request is cancelled', async () => {
  const started = Date.now();
  const r = await fetchTitle(base + '/huge-no-title');
  assert.equal(r.status, 200);
  assert.equal(r.title, '');
  assert.equal(r.error, undefined);
  assert.ok(Date.now() - started < 3000, 'returned promptly');
  // The server's endless stream only ends because the client dropped the connection.
  await Promise.race([
    closedPromise['huge-no-title'],
    new Promise((_, rej) => setTimeout(() => rej(new Error('connection not closed')), 3000)),
  ]);
});

test('stops reading at </title> and cancels the request', async () => {
  const r = await fetchTitle(base + '/huge-after-title');
  assert.equal(r.title, 'Early');
  await Promise.race([
    closedPromise['huge-after-title'],
    new Promise((_, rej) => setTimeout(() => rej(new Error('connection not closed')), 3000)),
  ]);
});

test('maxBytes override is respected', async () => {
  // Title sits after 1000+ bytes of padding; with a 100-byte cap it is never seen.
  const s = http.createServer((req, res) => html(res, `<head>${' '.repeat(2000)}<title>Late</title></head>`));
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${s.address().port}/`;
  try {
    assert.equal((await fetchTitle(url, { maxBytes: 100 })).title, '');
    assert.equal((await fetchTitle(url)).title, 'Late');
  } finally {
    s.closeAllConnections();
    s.close();
  }
});

test('slow response times out', async () => {
  const started = Date.now();
  const r = await fetchTitle(base + '/slow', { timeoutMs: 200 });
  assert.equal(r.title, '');
  assert.equal(r.status, 0);
  assert.match(r.error, /Timeout/);
  assert.ok(Date.now() - started < 2000);
});

test('follows redirects', async () => {
  const r = await fetchTitle(base + '/redirect');
  assert.equal(r.status, 200);
  assert.equal(r.title, "Tom & Jerry 's A — Home");
});

test('429 returns status, error and Retry-After', async () => {
  const r = await fetchTitle(base + '/429');
  assert.equal(r.status, 429);
  assert.equal(r.title, '');
  assert.equal(r.error, 'HTTP 429');
  assert.equal(r.retryAfter, '7');
});

test('503 without Retry-After', async () => {
  const r = await fetchTitle(base + '/503');
  assert.equal(r.status, 503);
  assert.equal(r.retryAfter, undefined);
});

test('404 reports the error but still returns the title', async () => {
  const r = await fetchTitle(base + '/404');
  assert.equal(r.status, 404);
  assert.equal(r.error, 'HTTP 404');
  assert.equal(r.title, 'Not Found Page');
});

test('connection refused returns an error instead of throwing', async () => {
  const r = await fetchTitle('http://127.0.0.1:1/');
  assert.equal(r.status, 0);
  assert.equal(r.title, '');
  assert.ok(r.error);
});

test('decodeEntities handles named, decimal, hex and unknown entities', () => {
  assert.equal(decodeEntities('&lt;b&gt; &#65;&#x42; &bogus; &amp;amp;'), '<b> AB &bogus; &amp;');
});
