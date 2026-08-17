/**
 * Tencent public quote API client.
 *
 * Tencent's `qt.gtimg.cn` returns realtime quotes for A-share / HK / US
 * markets on one endpoint with no API key and no Referer requirement, and
 * `web.ifzq.gtimg.cn/appstock/app/fqkline/get` returns historical daily/weekly/
 * monthly K-line. Both are the prototype's sole data source.
 *
 * Encoding is GBK, so the realtime body is decoded as bytes, never as a UTF-8
 * string. Field parsing reads only the stable core segment ([0]..[53] for
 * realtime) and stays tolerant of an unknown tail.
 * @module dsh-market-quote/tencent
 */

/** Symbol code rule for each market. */
export type Market = 'cn' | 'hk' | 'us'

/** The realtime quote of one symbol, mapped to a stable shape. */
export interface Quote {
  /** Market-agnostic primary listing code (for US this carries the exchange suffix, e.g. `AAPL.OQ`). */
  readonly code: string
  /** Human-readable exchange-qualified code Tencent knows the symbol by (e.g. `sh600000`, `hk00700`, `usAAPL`). */
  readonly rawCode: string
  /** Display name as returned by Tencent. */
  readonly name: string
  /** Latest price. */
  readonly price: number
  /** Previous close. */
  readonly prevClose: number
  /** Today's open. */
  readonly open: number
  /** Trading volume. Units differ by market (CN/HK lots or shares; US shares). */
  readonly volume: number
  /** High of the day. */
  readonly high: number
  /** Low of the day. */
  readonly low: number
  /** Absolute change against previous close. */
  readonly change: number
  /** Percent change against previous close. */
  readonly changePct: number
  /** Last-trade time as returned by Tencent (format differs by market). */
  readonly time: string
  /** Deferred when present (US quotes are delayed); undefined otherwise. */
  readonly delayed?: boolean
}

/** One K-line bar. */
export interface Bar {
  readonly date: string
  readonly open: number
  readonly close: number
  readonly high: number
  readonly low: number
  readonly volume: number
}

/** Map a caller-facing symbol to the `prefix+code` string Tencent expects. */
export function qqCode(code: string, market: Market): string {
  switch (market) {
    case 'cn':
      // Stock codes 6xxxxx are Shanghai, 0xxxxx/3xxxxx are Shenzhen.
      return (code.startsWith('6') ? 'sh' : 'sz') + code
    case 'hk':
      return 'hk' + code
    case 'us':
      return 'us' + code
  }
}

/** Latest quote for one symbol. */
export async function fetchQuote(rawCode: string): Promise<Quote> {
  const quotes = await fetchQuotes([rawCode])
  const quote = quotes[0]
  if (quote === undefined) throw new Error(`tencent: no quote returned for ${rawCode}`)
  return quote
}

/**
 * Fetch realtime quotes for several symbols in one request.
 * @param rawCodes - Tencent codes (`sh600000`, `hk00700`, `usAAPL.OQ`, ...).
 * @returns one entry per requested symbol, in request order. A symbol Tencent
 *   does not know is excluded rather than throwing, so a batch survives a bad member.
 */
export async function fetchQuotes(rawCodes: readonly string[]): Promise<Quote[]> {
  if (rawCodes.length === 0) return []
  const url = 'https://qt.gtimg.cn/q=' + rawCodes.join(',')
  const response = await fetch(url, { redirect: 'error' })
  if (!response.ok) {
    throw new Error(`tencent: quote request failed with HTTP ${response.status}`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  const text = decodeGbk(bytes)
  const quotes: Quote[] = []
  for (const line of text.split(';')) {
    const match = /v_(\w+)="([^"]*)"/.exec(line)
    if (match === null) continue
    quotes.push(parseQuote(match[1] as string, match[2] as string))
  }
  return quotes
}

/** Decode a GBK/GB18030 byte buffer to a string. */
function decodeGbk(bytes: Uint8Array): string {
  // TextDecoder('gbk') is globally available in Node 22+/and browsers and maps to GB18030.
  return new TextDecoder('gbk').decode(bytes)
}

/** Parse one `key="f0~f1~..."` line into a {@link Quote}. Only the stable core fields are read. */
function parseQuote(rawCode: string, body: string): Quote {
  const f = body.split('~')
  const num = (index: number): number => {
    const value = Number(f[index])
    return Number.isFinite(value) ? value : 0
  }
  const marketFlag = f[0] ?? ''
  const price = num(3)
  const prevClose = num(4)
  return {
    rawCode,
    code: f[2] ?? rawCode,
    name: f[1] ?? '',
    price,
    prevClose,
    open: num(5),
    volume: num(6),
    high: num(33) || num(41),
    low: num(34) || num(42),
    change: num(31),
    changePct: num(32),
    time: f[30] ?? '',
    // US and some instruments flag delayed data in the leading market token.
    delayed: marketFlag === '200' || marketFlag.indexOf('delay') !== -1,
  }
}

/** Format a timestamp as a YYYY-MM-DD date in UTC. */
function toIsoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Shift a YYYY-MM-DD date by whole calendar days (UTC, so no DST drift). */
function shiftDate(date: string, deltaDays: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  return toIsoDate(Date.UTC(y, m - 1, d) + deltaDays * 86_400_000)
}

/** Today's date as YYYY-MM-DD (UTC). */
function todayUtc(): string {
  return toIsoDate(Date.now())
}

/** Tencent caps one kline request at this many bars. */
const KLINE_PAGE_MAX = 640

/** Hard cap on total bars one fetch returns, bounding memory for long ranges. */
const KLINE_TOTAL_MAX = 2000

/** One kline request, parsed into oldest-first bars. */
async function klineOnce(
  rawCode: string,
  period: 'day' | 'week' | 'month',
  start: string,
  end: string,
  count: number,
  adjusted: boolean,
): Promise<Bar[]> {
  const fq = adjusted ? 'qfq' : ''
  // param = <code>,<period>,<start>,<end>,<count>,<fq>
  const param = [rawCode, period, start, end, String(count), fq].join(',')
  const url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + encodeURIComponent(param)
  const response = await fetch(url, { redirect: 'error' })
  if (!response.ok) {
    throw new Error(`tencent: kline request failed with HTTP ${response.status}`)
  }
  const json = await response.json() as { code?: unknown; data?: Record<string, unknown> }
  if (json.code !== 0) {
    throw new Error(`tencent: kline request rejected (code=${String(json.code)})`)
  }
  const day = json.data?.[rawCode.replace('.', '_')] ?? json.data?.[rawCode]
  // The kline key follows the adjustment request for CN: qfqday/hfqday/day.
  const rows = (day as Record<string, unknown> | undefined)?.[`${fq || ''}${period}`] as unknown
  if (!Array.isArray(rows)) {
    throw new Error(`tencent: kline response for ${rawCode} has no ${period} array`)
  }
  const bars: Bar[] = []
  for (const row of rows) {
    if (!Array.isArray(row)) continue
    const [date, open, close, high, low, volume] = row as [string, string, string, string, string, string]
    if (typeof date !== 'string') continue
    bars.push({
      date,
      open: Number(open),
      close: Number(close),
      high: Number(high),
      low: Number(low),
      volume: Number(volume),
    })
  }
  // Tencent returns newest-first for recent queries; normalize to oldest-first
  // so the tool's documented order and page-cursor logic do not depend on it.
  bars.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return bars
}

/** Options for {@link fetchKline}. */
export interface FetchKlineOptions {
  /** Bar interval: `day`, `week`, or `month`. */
  period: 'day' | 'week' | 'month'
  /** Inclusive start date YYYY-MM-DD; omit for most-recent bars. */
  start?: string
  /** Inclusive end date YYYY-MM-DD; omit for most-recent bars. */
  end?: string
  /** Max bars to return: default 30 for recent, 640 for a range. */
  count?: number
  /** Forward-adjusted (qfq) bars; ignored by the API for HK/US. */
  adjusted?: boolean
}

/**
 * Fetch historical K-line bars, oldest-first.
 *
 * Without `start`/`end` this returns the `count` most-recent bars (≤640). With
 * a range it returns bars inside `[start, end]`, paginating `day` requests past
 * the API's 640-bar page cap; `week`/`month` never paginate (640 bars is ~12/~53
 * years). Total returned bars are capped at 2000.
 *
 * @param rawCode - Tencent code. For a US symbol this MUST carry the exchange
 *   suffix (e.g. `usAAPL.OQ`); use {@link fetchQuote} to resolve it first.
 * @param options - see {@link FetchKlineOptions}.
 * @returns bars oldest-first.
 */
export async function fetchKline(rawCode: string, options: FetchKlineOptions): Promise<Bar[]> {
  const { period } = options
  const adjusted = options.adjusted ?? false

  // Recent path: no range, single request.
  if (options.start === undefined && options.end === undefined) {
    const n = Math.max(1, Math.min(KLINE_PAGE_MAX, Math.floor(options.count ?? 30)))
    return klineOnce(rawCode, period, '', '', n, adjusted)
  }

  // Range path: resolve concrete [start, end].
  const cap = Math.max(1, Math.min(KLINE_TOTAL_MAX, Math.floor(options.count ?? KLINE_PAGE_MAX)))
  let start = options.start
  let end = options.end
  if (end === undefined) end = todayUtc()
  if (start === undefined) {
    // end-only: back up ~2 calendar days per bar to cover weekends/holidays.
    start = shiftDate(end, -(cap * 2))
  }

  // week/month spans never need paging (640 covers 12/53 years).
  if (period !== 'day') {
    return (await klineOnce(rawCode, period, start, end, KLINE_PAGE_MAX, adjusted)).slice(-cap)
  }

  // day: page forward from `start`, deduping and advancing past each page's
  // last date until a short page or the cap is reached.
  const out: Bar[] = []
  const seen = new Set<string>()
  let cursor = start
  while (cursor <= end && out.length < cap) {
    const page = await klineOnce(rawCode, 'day', cursor, end, KLINE_PAGE_MAX, adjusted)
    for (const bar of page) {
      if (out.length >= cap) break
      if (seen.has(bar.date)) continue
      seen.add(bar.date)
      out.push(bar)
    }
    if (page.length < KLINE_PAGE_MAX) break
    const last = page[page.length - 1]
    if (last === undefined) break
    const next = shiftDate(last.date, 1)
    if (next <= cursor) break // safety: cursor must strictly advance
    cursor = next
  }
  return out
}
