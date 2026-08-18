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
import { fetchKline, fetchQuote, isTransientError } from './tencent.ts'
import { RateLimiter, Semaphore, sleep, TtlCache } from './cache.ts'

/** Tunables for {@link MarketDataService}; cache/interval/backoff fields are ms, `maxRetries` is a count. */
export interface MarketDataConfig {
  /** Realtime quote cache TTL. */
  quoteTtlMs?: number
  /** K-line cache TTL. */
  klineTtlMs?: number
  /** Minimum spacing between consecutive API requests. */
  minRequestIntervalMs?: number
  /** Max retries per request on a transient (5xx / network) failure; 0 disables retries. */
  maxRetries?: number
  /** Base of the exponential backoff between retries (1s → 2s → 4s, full jitter). */
  retryBaseMs?: number
  /** Hard per-attempt fetch timeout (AbortController). */
  requestTimeoutMs?: number
  /** Max concurrent in-flight HTTP requests. */
  maxConcurrency?: number
}

/** Default quote cache lifetime (5 s): quotes move, but not every keystroke. */
export const DEFAULT_QUOTE_TTL_MS = 5_000
/** Default K-line cache lifetime (5 min): historical bars are immutable per day. */
export const DEFAULT_KLINE_TTL_MS = 300_000
/** Default request spacing (500 ms = 2 QPS), within Tencent's de-facto polite range. */
export const DEFAULT_MIN_REQUEST_INTERVAL_MS = 500
/** Default max retries per request; transient failures only, 4xx (incl. 429) is never retried. */
export const DEFAULT_MAX_RETRIES = 3
/** Default backoff base (1 s): retries wait ~1s → 2s → 4s with full jitter. */
export const DEFAULT_RETRY_BASE_MS = 1_000
/** Default per-attempt fetch timeout (5 s). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 5_000
/** Default max concurrent in-flight requests. */
export const DEFAULT_MAX_CONCURRENCY = 3

/** Validate and default the raw config; fails loud on a non-positive-integer field. */
export function resolveMarketDataConfig(config?: Partial<MarketDataConfig>): Required<MarketDataConfig> {
  const resolved = {
    quoteTtlMs: config?.quoteTtlMs ?? DEFAULT_QUOTE_TTL_MS,
    klineTtlMs: config?.klineTtlMs ?? DEFAULT_KLINE_TTL_MS,
    minRequestIntervalMs: config?.minRequestIntervalMs ?? DEFAULT_MIN_REQUEST_INTERVAL_MS,
    maxRetries: config?.maxRetries ?? DEFAULT_MAX_RETRIES,
    retryBaseMs: config?.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
    requestTimeoutMs: config?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    maxConcurrency: config?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
  }
  for (const [key, value] of Object.entries(resolved)) {
    const min = key === 'maxRetries' ? 0 : 1
    if (!Number.isInteger(value) || (value as number) < min) {
      throw new Error(`dsh-market-quote: ${key} must be an integer >= ${min}`)
    }
  }
  return resolved
}

/** Stable cache key for one K-line request. */
function klineKey(rawCode: string, options: FetchKlineOptions): string {
  return [rawCode, options.period, options.start ?? '', options.end ?? '', String(options.count ?? ''), String(options.adjusted ?? false)].join('|')
}

/** Full-jitter exponential backoff: uniform in [0, baseMs * 2^attempt]. */
function backoffMs(attempt: number, baseMs: number): number {
  return Math.floor(Math.random() * baseMs * 2 ** attempt)
}

/** Cached, rate-limited access to realtime quotes and historical K-line. */
export class MarketDataService {
  private readonly quoteCache: TtlCache<string, Quote>
  private readonly klineCache: TtlCache<string, Bar[]>
  private readonly limiter: RateLimiter
  private readonly semaphore: Semaphore
  private readonly quoteInFlight = new Map<string, Promise<Quote>>()
  private readonly klineInFlight = new Map<string, Promise<Bar[]>>()

  constructor(public readonly config: Required<MarketDataConfig>) {
    this.quoteCache = new TtlCache(config.quoteTtlMs)
    this.klineCache = new TtlCache(config.klineTtlMs)
    this.limiter = new RateLimiter(config.minRequestIntervalMs)
    this.semaphore = new Semaphore(config.maxConcurrency)
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
    return this.withRetry(async () => {
      const quote = await fetchQuote(rawCode, this.config.requestTimeoutMs, () => this.acquireSlot())
      this.quoteCache.set(rawCode, quote)
      return quote
    })
  }

  private async loadKline(rawCode: string, options: FetchKlineOptions, key: string): Promise<Bar[]> {
    return this.withRetry(async () => {
      const bars = await fetchKline(rawCode, options, this.config.requestTimeoutMs, () => this.acquireSlot())
      this.klineCache.set(key, bars)
      return bars
    })
  }

  /**
   * Claim one request slot: first the time-based limiter (≥500ms spacing), then
   * a concurrency slot (released when the fetch finishes).
   */
  private async acquireSlot(): Promise<() => void> {
    const releaseSemaphore = await this.semaphore.acquire()
    try {
      await this.limiter.acquire()
    } catch (error) {
      releaseSemaphore()
      throw error
    }
    return releaseSemaphore
  }

  /**
   * Run one API operation with bounded retry on transient failures. Every
   * underlying HTTP request claims a slot from the shared limiter inside the
   * data layer (so pagination pages and retries never cut the line); backoff is
   * full-jitter exponential and 4xx is never retried.
   */
  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await operation()
      } catch (error) {
        if (attempt >= this.config.maxRetries || !isTransientError(error)) throw error
        await sleep(backoffMs(attempt, this.config.retryBaseMs))
      }
    }
  }
}
