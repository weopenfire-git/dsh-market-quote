# dsh-market-quote

A DeepSeek Harness tool plugin: registers two read-only tools, `market_quote` and `market_kline`, covering realtime quotes and historical daily / weekly / monthly K-line for **A-share / Hong Kong / US** markets from a **single data source**.

> [简体中文](./README.md) · English

## Highlights

- **Two tools, three markets, one source**: realtime quotes + historical K-line; one bare-symbol entry across A-share / HK / US (`600000` / `00700` / `AAPL`), prefixes/suffixes resolved automatically.
- **No credentials, no config**: Tencent's public quote API — no API key, no Referer; Node ≥22.19 built-in `fetch` + GBK `TextDecoder`, no third-party runtime deps.
- **Built-in rate limiting (anti-ban)**: global ≤2 QPS spacing (≥500ms) + same-key single-flight + 5s quote / 5min K-line caches flatten bursts into low-rate serial requests, avoiding upstream bans / IP blocks from asking for too much at once; all tunable.
- **Safe retry**: exponential backoff with jitter (1s→2s→4s, ≤3 tries) only for transient errors (5xx / network / timeout); 4xx (incl. the 429 "stop" signal) is never retried; retries still queue through the global limiter, never amplifying QPS.
- **Pre-flight confirm for large ranges**: a `day` range over 640 bars (paginated, slow) asks the user before issuing; headless / no-UI callers proceed automatically.
- **Read-only, concurrency-safe, 30s timeout**: tools are side-effect-free and safe to call concurrently.

## Design

- **Single source, byte-level decode**: the realtime endpoint `qt.gtimg.cn` returns GBK-encoded, `~`-delimited field strings; decoded as bytes (`TextDecoder('gbk')`) rather than a UTF-8 string. Only the stable core fields ([0..53]) are read, staying tolerant of upstream field variants and unknown tails.
- **K-line pagination cursor**: Tencent caps one request at 640 bars and returns the NEWEST bars for a range, so `day` pages backward (each page's oldest bar minus one day becomes the next page's end) and then reverses to oldest-first; `week` / `month` (640 bars ≈ 12 / 53 years) fit one request; total return hard-capped at 2000 bars.
- **US history auto-resolves exchange suffix**: Tencent's US history needs a suffixed code like `usAAPL.OQ`; the plugin first resolves the authoritative code from the realtime quote, then feeds it to the K-line API — users only pass the bare `AAPL`.
- **Rate limiting (anti-ban), three layers, down to every HTTP request**: an in-process TTL cache (5s quotes / 5min K-line) dedupes repeats; concurrent callers for one key share a single in-flight request; a global limiter enforces ≥500ms between any two HTTP requests — including each pagination page and each retry attempt (≤2 QPS) — and queues concurrent calls onto future slots, preventing the "too many requests at once" pattern that triggers upstream bans. Combined with the 640-bars-per-request / 2000-total caps, a single K-line query also has a hard request-count bound. The clock and sleeper are injectable so tests can drive time deterministically.
- **Safe retry strategy**: every attempt carries an `AbortController` timeout (hung requests fail fast); only transient errors (HTTP 5xx, network failure, timeout) are retried — 4xx (incl. the 429 "stop" signal) is never retried; exponential backoff + full jitter (1s→2s→4s), max 3 retries; each retry first queues through the global limiter, never cutting the line or amplifying QPS.
- **Concurrency cap (semaphore)**: on top of the time-spacing limiter, a `maxConcurrency` (default 3) semaphore bounds in-flight requests, capping memory and upstream load; each request releases its slot when done.
- **Pre-flight confirmation**: when a `day` range would paginate (`count > 640`), the tool asks through the optional `ctx.userQuestions`; with no provider / non-live root it proceeds silently.
- **No custom UI**: no `presentCall` / `presentResult`; relies on DSH's generic tool card, keeping front-end coupling low.

## Tools

| Tool | Parameters | Purpose |
|---|---|---|
| `market_quote` | `symbol`, `market` (cn/hk/us) | latest price, prev close, open, high, low, change, change %, volume, quote time, delayed flag |
| `market_kline` | `symbol`, `market`, `period` (day/week/month), `start`/`end`, `count` | historical daily/weekly/monthly bars (open/close/high/low/volume, oldest first); no range = most recent N, `start=end` = one day |

- `market`: `cn` = A-share, `hk` = Hong Kong, `us` = United States.
- `symbol` is bare: A-share `600000` / `000001`, HK `00700`, US `AAPL`.
- `day` paginates past 640 bars; total return capped at 2000 bars.

## Install

### `dsh plugin add` (recommended)

```sh
dsh plugin add dsh-market-quote                        # npm
dsh plugin add github:weopenfire-git/dsh-market-quote  # GitHub
```

### Preset mount (local / source development)

Copy a `standard` preset and append one line to `agent.cordis.yml` (source loads via tsx directly; or run `pnpm run build` first and point at `lib/index.js`):

```yaml
- id: dsh-market-quote
  name: 'file:///D:/path/to/dsh-market-quote/src/index.ts'
```

Start a new session with that preset to expose the two tools.

## Configuration

Seven tunables (`maxRetries` is a non-negative count; `maxConcurrency` a positive integer; the rest are positive-integer milliseconds), overridable via plugin `config`:

| Key | Default | Meaning |
|---|---|---|
| `quoteTtlMs` | 5000 | realtime quote cache TTL |
| `klineTtlMs` | 300000 | K-line cache TTL (5 min) |
| `minRequestIntervalMs` | 500 | minimum request spacing (≤2 QPS) |
| `maxRetries` | 3 | max retries per request (0 disables) |
| `retryBaseMs` | 1000 | backoff base (1s → 2s → 4s, full jitter) |
| `requestTimeoutMs` | 5000 | per-attempt fetch timeout |
| `maxConcurrency` | 3 | max concurrent in-flight requests |

Invalid values (negative `maxRetries`, non-positive `maxConcurrency` or others) throw at plugin activation.

## Usage recommendations (ranges & counts)

Tencent caps one request at 640 bars with ≥500ms spacing; very large `day` ranges paginate (up to 2000 bars ≈ 4 requests), increasing wait time, request count, and ban risk. The plugin injects the same guidance at session start (systemPrompt):

| Need | Recommended call | Requests |
|---|---|---|
| Latest price | `market_quote` | 1 |
| Short-term trend (≤~2.5y) | `market_kline` `period=day`, `count ≤ 640` | 1 |
| Long-term trend (multi-year) | `market_kline` `period=week` (~12y) or `period=month` (~53y) | 1 |

- Avoid one-shot very large `day` ranges (>640 bars): they paginate and slow down.
- For multi-year daily data, prefer several smaller-range queries over one 2000-bar pull.
- A very large `day` range (`count > 640`) triggers a pre-flight confirmation; cancel it and switch to `week` / `month`.

## Data source

- Realtime: `GET https://qt.gtimg.cn/q=sh600000,hk00700,usAAPL` (GBK, `~`-delimited).
- History: `GET https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=<code>,day,,,<count>,qfq` (JSON).

Edges: A-share capped at 640 rows per request; US history requires the exchange suffix (handled automatically); no adjusted K-line for HK/US; US quotes are delayed. The source is Tencent's public interface (not officially licensed) — evaluate a paid feed for production (see [Known limitations](#known-limitations)).

## Development & testing

```sh
pnpm install
pnpm run typecheck && pnpm run test && pnpm run build   # test OK then push
npm pack --dry-run    # inspect package contents before publishing
```

Also available: `node validate.mjs` (26 assertions, vitest-free) and `node --import tsx/esm smoke.mjs` (real tool-registry smoke).

## Layout

```
dsh-market-quote/
├── src/                 # index.ts / tencent.ts / cache.ts / service.ts
├── tests/               # vitest cases
├── preset/              # example preset fragment
├── validate.mjs         # vitest-free runtime validation
├── smoke.mjs            # real tool-registry smoke
├── tsdown.config.ts
├── tsconfig.json
├── vitest.config.ts
├── package.json
├── CHANGELOG.md
├── LICENSE
└── README.md / README.en.md
```

## Known limitations

- In-process memory cache: lost on restart, not shared across instances/processes.
- No adjusted-price selection (A-share defaults to unadjusted; HK/US have none).
- Data source is Tencent's public interface (not officially licensed) — assess compliance/distribution yourself; prefer a paid feed for production.
- Retries cover transient errors only (5xx / network / timeout); a 429 fails immediately (respecting the upstream "stop" signal) — `Retry-After` is not parsed for adaptive backoff.

## Publishing

1. Add the `dsh-plugin` topic (optionally `deepseek-harness`) to the GitHub repo so it appears on the [official topic page](https://github.com/topics/dsh-plugin).
2. Publish to npm and GitHub with matching versions (tag `vX.Y.Z` ↔ npm `X.Y.Z`).
3. `pnpm publish` (`prepare` builds automatically; 2FA required). Scoped packages need an npm org first.
4. Once stable, PR into [awesome-deepseek-harness](https://github.com/0xsline/awesome-deepseek-harness).

## License

[MIT](./LICENSE)
