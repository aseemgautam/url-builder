const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const defaultConfig = require('./config');
const { fetchTitle: realFetchTitle } = require('./lib/title');

const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;
const MAX_BODY_BYTES = 1024 * 1024;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const JITTER = 0.3; // ±30%
const MAX_RETRIES = 2;
const RETRY_STATUSES = new Set([429, 503]);

// Sleeps for ms; resolves early (to false) if the signal aborts.
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const onAbort = () => { clearTimeout(t); resolve(false); };
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(true); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// Retry-After is either delta-seconds or an HTTP date.
function parseRetryAfter(value) {
  if (value === undefined || value === null || value === '') return null;
  if (/^\d+$/.test(String(value).trim())) return Number(value) * 1000;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : Math.max(0, t - Date.now());
}

function serveStatic(req, res) {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('Request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// Options exist so tests can inject a fake fetchTitle and short timings.
// Throttling values otherwise come from config.js only, never from the client.
function createServer(opts = {}) {
  const cfg = { ...defaultConfig, ...(opts.config || {}) };
  const fetchTitle = opts.fetchTitle || realFetchTitle;
  const retryDefaultMs = opts.retryDefaultMs ?? 5000;
  const retryCapMs = opts.retryCapMs ?? 30000;

  async function handleTitles(req, res) {
    let urls;
    try {
      const body = await readJson(req);
      urls = body && body.urls;
      if (!Array.isArray(urls) || !urls.every((u) => typeof u === 'string')) {
        throw new Error('Body must be {"urls": string[]}');
      }
      if (urls.length > cfg.MAX_URLS) throw new Error(`Too many URLs (max ${cfg.MAX_URLS})`);
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.flushHeaders();

    // Client went away (cancel / closed tab): stop scheduling new requests.
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    const { signal } = abort;
    const send = (obj) => { if (!signal.aborted) res.write(JSON.stringify(obj) + '\n'); };

    async function processOne(index) {
      send({ type: 'start', index });
      let result;
      for (let attempt = 0; ; attempt++) {
        result = await fetchTitle(urls[index]);
        if (!RETRY_STATUSES.has(result.status)) break;
        if (attempt >= MAX_RETRIES) {
          result = { ...result, error: `HTTP ${result.status} (gave up after ${MAX_RETRIES} retries)` };
          break;
        }
        const wait = parseRetryAfter(result.retryAfter);
        const ms = wait === null ? retryDefaultMs : Math.min(wait, retryCapMs);
        if (!(await sleep(ms, signal))) return; // cancelled while waiting
      }
      const { status, title, error } = result;
      send({ type: 'done', index, status, title, ...(error ? { error } : {}) });
    }

    let next = 0;
    async function worker() {
      let first = true;
      while (!signal.aborted && next < urls.length) {
        const index = next++;
        if (!first) {
          const ms = cfg.DELAY_MS * (1 - JITTER + Math.random() * 2 * JITTER);
          if (!(await sleep(ms, signal))) return;
        }
        first = false;
        await processOne(index);
      }
    }

    await Promise.all(Array.from({ length: Math.max(1, cfg.CONCURRENCY) }, worker));
    if (!signal.aborted) res.end();
  }

  return http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/api/titles') {
      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST' }).end();
        return;
      }
      handleTitles(req, res).catch((err) => {
        console.error(err);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
      return;
    }
    serveStatic(req, res);
  });
}

if (require.main === module) {
  createServer().listen(PORT, () => console.log(`url-builder running at http://localhost:${PORT}`));
}

module.exports = { createServer, parseRetryAfter };
