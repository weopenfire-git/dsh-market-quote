/**
 * Cached, rate-limited facade over the Tencent quote client.
 *
 * One instance per plugin mount owns the quote/K-line caches and the shared
 * request gate. Cache misses are single-flight: concurrent callers for the same
 * key await one shared in-flight request instead of each hitting the API, and
 * every API request passes through the limiter so bursts are spaced out.
 * @module dsh-market-quote/service
 */

import type { Bar, FetchKlineOptions, Quote } from './tencent.ts'
import { fetchKline, fetchQuote } from './tencent.ts'
import { RateLimiter, TtlCache } from './cache.ts'

/** Tunables for {@link MarketDataService}, all positive integers in milliseconds. */
export interface MarketDataConfig {
  /** Realtime quote cache TTL. */
  quoteTtlMs?: number
  /** K-line cache TTL. */
  klineTtlMs?: number
  /** Minimum spacing between consecutive API requests. */
  minRequestIntervalMs?: number
}

/** Default quote cache lifetime (5 s): quotes move, but not every keystroke. */
export const DEFAULT_QUOTE_TTL_MS = 5_000
/** Default K-line cache lifetime (5 min): historical bars are immutable per day. */
export const DEFAULT_KLINE_TTL_MS = 300_000
/** Default request spacing (500 ms = 2 QPS), within Tencent's de-facto polite range. */
export const DEFAULT_MIN_REQUEST_INTERVAL_MS = 500

/** Validate and default the raw config; fails loud on a non-positive-integer field. */
export function resolveMarketDataConfig(config?: Partial<MarketDataConfig>): Required<MarketDataConfig> {
  const resolved = {
    quoteTtlMs: config?.quoteTtlMs ?? DEFAULT_QUOTE_TTL_MS,
    klineTtlMs: config?.klineTtlMs ?? DEFAULT_KLINE_TTL_MS,
    minRequestIntervalMs: config?.minRequestIntervalMs ?? DEFAULT_MIN_REQUEST_INTERVAL_MS,
  }
  for (const [key, value] of Object.entries(resolved)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`dsh-markets: ${key} must be a positive integer`)
    }
  }
  return resolved
}

/** Stable cache key for one K-line request. */
function klineKey(rawCode: string, options: FetchKlineOptions): string {
  return [rawCode, options.period, options.start ?? '', options.end ?? '', String(options.count ?? ''), String(options.adjusted ?? false)].join('|')
}

/** Cached, rate-limited access to realtime quotes and historical K-line. */
export class MarketDataService {
  private readonly quoteCache: TtlCache<string, Quote>
  private readonly klineCache: TtlCache<string, Bar[]>
  private readonly limiter: RateLimiter
  private readonly quoteInFlight = new Map<string, Promise<Quote>>()
  private readonly klineInFlight = new Map<string, Promise<Bar[]>>()

  constructor(public readonly config: Required<MarketDataConfig>) {
    this.quoteCache = new TtlCache(config.quoteTtlMs)
    this.klineCache = new TtlCache(config.klineTtlMs)
    this.limiter = new RateLimiter(config.minRequestIntervalMs)
  }

  /** Realtime quote for one Tencent code, cached and single-flight. */
  quote(rawCode: string): Promise<Quote> {
    const cached = this.quoteCache.get(rawCode)
    if (cached !== undefined) return Promise.resolve(cached)
    const inFlight = this.quoteInFlight.get(rawCode)
    if (inFlight !== undefined) return inFlight
    const request = this.loadQuote(rawCode).finally(() => this.quoteInFlight.delete(rawCode))
    this.quoteInFlight.set(rawCode, request)
    return request
  }

  /** Historical bars for one request, cached and single-flight. */
  kline(rawCode: string, options: FetchKlineOptions): Promise<Bar[]> {
    const key = klineKey(rawCode, options)
    const cached = this.klineCache.get(key)
    if (cached !== undefined) return Promise.resolve(cached)
    const inFlight = this.klineInFlight.get(key)
    if (inFlight !== undefined) return inFlight
    const request = this.loadKline(rawCode, options, key).finally(() => this.klineInFlight.delete(key))
    this.klineInFlight.set(key, request)
    return request
  }

  private async loadQuote(rawCode: string): Promise<Quote> {
    await this.limiter.acquire()
    const quote = await fetchQuote(rawCode)
    this.quoteCache.set(rawCode, quote)
    return quote
  }

  private async loadKline(rawCode: string, options: FetchKlineOptions, key: string): Promise<Bar[]> {
    await this.limiter.acquire()
    const bars = await fetchKline(rawCode, options)
    this.klineCache.set(key, bars)
    return bars
  }
}
