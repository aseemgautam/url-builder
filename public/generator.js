// Pure URL pattern generator. Works in the browser (window.UrlGenerator) and Node (require).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.UrlGenerator = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DEFAULT_MAX = 1000; // mirrors config.js MAX_URLS; callers may pass {max}

  // Parses "[start-end]" / "[start-end:step]" contents. Returns {range} or {error}.
  function parseRange(body) {
    const [rangePart, stepPart, ...extra] = body.split(':');
    if (extra.length) return { error: `Invalid range "[${body}]": too many ":"` };
    const m = /^(\d+)-(\d+)$/.exec(rangePart);
    if (!m) return { error: `Invalid range "[${body}]": expected numbers like [000-999] or [000-999:2]` };
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^-?\d+$/.test(stepPart)) return { error: `Invalid step in "[${body}]": step must be a whole number` };
      step = Number(stepPart);
      if (step < 1) return { error: `Invalid step in "[${body}]": step must be 1 or greater` };
    }
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (start > end) return { error: `Invalid range "[${body}]": start is greater than end` };
    const width = m[1].length; // padding comes from the start token
    const count = Math.floor((end - start) / step) + 1;
    return { range: { start, step, width, count } };
  }

  // Splits a pattern into literal strings and range segments.
  function parse(pattern) {
    const segments = [];
    let i = 0;
    while (i < pattern.length) {
      const open = pattern.indexOf('[', i);
      if (open === -1) {
        segments.push({ literal: pattern.slice(i) });
        break;
      }
      if (open > i) segments.push({ literal: pattern.slice(i, open) });
      const close = pattern.indexOf(']', open + 1);
      if (close === -1) return { error: 'Unclosed bracket: missing "]"' };
      const body = pattern.slice(open + 1, close);
      const { range, error } = parseRange(body);
      if (error) return { error };
      segments.push({ range });
      i = close + 1;
    }
    return { segments };
  }

  function generate(pattern, { max = DEFAULT_MAX } = {}) {
    if (typeof pattern !== 'string' || pattern.trim() === '') {
      return { urls: [], error: 'Enter a pattern' };
    }
    const { segments, error } = parse(pattern.trim());
    if (error) return { urls: [], error };

    const ranges = segments.filter((s) => s.range).map((s) => s.range);
    let total = 1;
    for (const r of ranges) {
      total *= r.count;
      if (total > max) {
        return { urls: [], error: `Too many URLs: pattern exceeds the limit of ${max}` };
      }
    }

    // Cartesian product, rightmost bracket varies fastest (odometer).
    const urls = [];
    const idx = new Array(ranges.length).fill(0);
    for (let n = 0; n < total; n++) {
      let r = 0;
      let url = '';
      for (const seg of segments) {
        if (seg.literal !== undefined) {
          url += seg.literal;
        } else {
          const { start, step, width } = seg.range;
          url += String(start + idx[r] * step).padStart(width, '0');
          r++;
        }
      }
      urls.push(url);
      for (let k = ranges.length - 1; k >= 0; k--) {
        if (++idx[k] < ranges[k].count) break;
        idx[k] = 0;
      }
    }
    return { urls };
  }

  return { generate };
});
