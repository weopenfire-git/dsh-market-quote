# dsh-market-quote

A DeepSeek Harness tool plugin: registers two read-only tools, `market_quote` and `market_kline`, covering realtime quotes and historical daily / weekly / monthly K-line for **A-share / Hong Kong / US** markets from a **single data source**.

> [简体中文](./README.md) · English

## Highlights

- **Two tools, three markets, one source**: realtime quotes + historical K-line; one bare-symbol entry across A-share / HK / US (`600000` / `00700` / `AAPL`), prefixes/suffixes resolved automatically.
- **No credentials, no config**: Tencent's public quote API — no API key, no Referer; Node ≥22.19 built-in `fetch` + GBK `TextDecoder`, no third-party runtime deps.
- **Built-in cache + rate limit**: 5s quote / 5min K-line TTL, same-key single-flight, ≥500ms request spacing (≤2 QPS) to avoid IP bans; all three tunable.
- **Read-only, concurrency-safe, 15s timeout**: tools are side-effect-free and safe to call concurrently.

## Design

- **Single source, byte-level decode**: the realtime endpoint `qt.gtimg.cn` returns GBK-encoded, `~`-delimited field strings; decoded as bytes (`TextDecoder('gbk')`) rather than a UTF-8 string. Only the stable core fields ([0..53]) are read, staying tolerant of upstream field variants and unknown tails.
- **K-line pagination cursor**: Tencent caps one request at 640 bars. `day` paginates forward with a "last date +1" cursor and dedupes; `week` / `month` (640 bars ≈ 12 / 53 years) fit one request; total return hard-capped at 2000 bars.
- **US history auto-resolves exchange suffix**: Tencent's US history needs a suffixed code like `usAAPL.OQ`; the plugin first resolves the authoritative code from the realtime quote, then feeds it to the K-line API — users only pass the bare `AAPL`.
- **Cache → single-flight → rate-limit layers**: an in-process TTL cache dedupes repeats; concurrent callers for one key share a single in-flight request; a global minimum-interval gate spreads bursts. The clock and sleeper are injectable so tests can drive time deterministically.
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

Three tunables (positive integer milliseconds), overridable via plugin `config`:

| Key | Default | Meaning |
|---|---|---|
| `quoteTtlMs` | 5000 | realtime quote cache TTL |
| `klineTtlMs` | 300000 | K-line cache TTL (5 min) |
| `minRequestIntervalMs` | 500 | minimum request spacing (≤2 QPS) |

Non-positive values throw at plugin activation.

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

Also available: `node validate.mjs` (22 assertions, vitest-free) and `node --import tsx/esm smoke.mjs` (real tool-registry smoke).

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

## Publishing

1. Add the `dsh-plugin` topic (optionally `deepseek-harness`) to the GitHub repo so it appears on the [official topic page](https://github.com/topics/dsh-plugin).
2. Publish to npm and GitHub with matching versions (tag `vX.Y.Z` ↔ npm `X.Y.Z`).
3. `pnpm publish` (`prepare` builds automatically; 2FA required). Scoped packages need an npm org first.
4. Once stable, PR into [awesome-deepseek-harness](https://github.com/0xsline/awesome-deepseek-harness).

## License

[MIT](./LICENSE)
