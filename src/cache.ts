/**
 * In-memory TTL cache and a simple request rate limiter.
 *
 * Both are dependency-free and take injectable `now`/`sleep` so unit tests can
 * drive time deterministically. The limiter is a fixed-minimum-interval gate:
 * concurrent callers each receive a distinct future slot, so a burst is spaced
 * out rather than firing together.
 * @module dsh-market-quote/cache
 */

/** Resolve a promise after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** A cache entry that expires after a fixed TTL. */
export class TtlCache<K, V> {
  private readonly entries = new Map<K, { at: number; value: V }>()

  /** @param ttlMs - entry lifetime in milliseconds. @param now - clock, defaults to `Date.now`. */
  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** The live value, or `undefined` when absent or expired (expired entries are dropped). */
  get(key: K): V | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    if (this.now() - entry.at >= this.ttlMs) {
      this.entries.delete(key)
      return undefined
    }
    return entry.value
  }

  /** Store a value, stamping it with the current time. */
  set(key: K, value: V): void {
    this.entries.set(key, { at: this.now(), value })
  }

  /** Number of entries currently held (including not-yet-evicted expired ones). */
  get size(): number {
    return this.entries.size
  }
}

/** A fixed minimum-interval request gate (no burst: callers queue onto future slots). */
export class RateLimiter {
  /** Earliest timestamp the next request may start. */
  private nextAt = 0

  /** @param minIntervalMs - minimum spacing between consecutive requests. @param now - clock. @param doSleep - sleeper. */
  constructor(
    private readonly minIntervalMs: number,
    private readonly now: () => number = Date.now,
    private readonly doSleep: (ms: number) => Promise<void> = sleep,
  ) {}

  /**
   * Claim the next request slot, sleeping until it opens. Synchronously reserves
   * the slot before awaiting, so concurrent callers get increasing start times.
   */
  async acquire(): Promise<void> {
    const now = this.now()
    const waitMs = Math.max(0, this.nextAt - now)
    this.nextAt = Math.max(now, this.nextAt) + this.minIntervalMs
    if (waitMs > 0) await this.doSleep(waitMs)
  }
}
