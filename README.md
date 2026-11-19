# url-builder

Local tool that generates URLs from a pattern and fetches each page's title.

## Pattern syntax
- `[000-999]` generates 000 to 999 (inclusive), keeping zero-padding.
- `[000-999:2]` generates every 2nd value: 000, 002, ... 998.
- Multiple brackets are combined (cartesian product).
- Maximum 1000 URLs per run.

## Run

```bash
npm start      # http://localhost:3000 (Node 20+, no dependencies)
npm test
```

Enter a pattern, click **Generate**, then **Fetch titles** to fetch each page title
live (use **Cancel** to stop). Titles are fetched with a throttle; the limits are
code-only settings in `config.js` (`DELAY_MS`, `CONCURRENCY`, `TIMEOUT_MS`,
`MAX_BYTES`, `MAX_URLS`).

Local use only: no auth, bot-blocking workarounds or SSRF protection.
