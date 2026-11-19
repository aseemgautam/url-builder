const config = require('../config');

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®', trade: '™',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·',
};

function decodeEntities(s) {
  return s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z][a-z0-9]*));/gi, (m, dec, hex, name) => {
    if (dec || hex) {
      const cp = dec ? parseInt(dec, 10) : parseInt(hex, 16);
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    const v = NAMED_ENTITIES[name.toLowerCase()];
    return v === undefined ? m : v;
  });
}

const clean = (s) => decodeEntities(s).replace(/\s+/g, ' ').trim();

function extractTitle(html) {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  return m ? clean(m[1]) : '';
}

function extractOgTitle(html) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    if (!/\b(?:property|name)\s*=\s*["']?og:title["']?/i.test(tag)) continue;
    const c = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    if (c) return clean(c[1] ?? c[2]);
  }
  return '';
}

// Fetches a page and returns {url, status, title, error?}. Never throws.
// `opts` can override config limits (used by tests).
// For 429/503 the Retry-After header value, if any, is returned as `retryAfter`.
async function fetchTitle(url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? config.TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? config.MAX_BYTES;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);

  let status = 0;
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    status = res.status;
    const result = { url, status, title: '' };
    if (status === 429 || status === 503) {
      result.retryAfter = res.headers.get('retry-after') || undefined;
    }
    if (status >= 400) result.error = `HTTP ${status}`;
    if (status === 429 || status === 503 || !res.body) {
      controller.abort();
      return result;
    }

    // Stream the (already decompressed) body; stop at </title>, </head> or maxBytes.
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let html = '';
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Never look past maxBytes, even when it falls inside a chunk.
      const chunk = bytes + value.byteLength > maxBytes ? value.subarray(0, maxBytes - bytes) : value;
      bytes += chunk.byteLength;
      html += decoder.decode(chunk, { stream: true });
      const lower = html.toLowerCase();
      const headEnd = lower.indexOf('</head>');
      if (headEnd !== -1) {
        html = html.slice(0, headEnd); // ignore anything after </head>
        break;
      }
      if (bytes >= maxBytes) break;
      // Stop at </title> only when it yielded a title; an empty one falls back to og:title.
      if (lower.includes('</title') && extractTitle(html)) break;
    }
    controller.abort(); // cancel the rest of the request
    result.title = extractTitle(html) || extractOgTitle(html);
    return result;
  } catch (err) {
    return {
      url,
      status,
      title: '',
      error: timedOut ? `Timeout after ${timeoutMs}ms` : (err.cause?.code || err.cause?.errors?.[0]?.code || err.message),
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchTitle, decodeEntities, extractTitle, extractOgTitle };
