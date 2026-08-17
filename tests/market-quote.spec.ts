import { describe, expect, it, vi, afterEach } from 'vitest'
import { qqCode, fetchQuotes, fetchKline, type Quote } from '../src/tencent.ts'
import { apply } from '../src/index.ts'
import { RateLimiter, TtlCache } from '../src/cache.ts'
import { MarketDataService, resolveMarketDataConfig } from '../src/service.ts'

/** A minimal fake of the Cordis ctx surface `apply` needs: just a tools registry. */
function fakeCtx() {
  const registered: Array<{ name: string }> = []
  const ctx = {
    tools: { register: (def: { name: string }) => { registered.push(def); return () => {} } },
  } as unknown as Parameters<typeof apply>[0]
  return { ctx, registered }
}

describe('dsh-markets tool registration', () => {
  it('registers market_quote and market_kline', () => {
    const { ctx, registered } = fakeCtx()
    apply(ctx)
    const names = registered.map(def => def.name).sort()
    expect(names).toEqual(['market_kline', 'market_quote'])
  })
})

describe('qqCode symbol mapping', () => {
  it('maps A-share 6xxxxx to Shanghai and 0/3xxxxx to Shenzhen', () => {
    expect(qqCode('600000', 'cn')).toBe('sh600000')
    expect(qqCode('000001', 'cn')).toBe('sz000001')
    expect(qqCode('300750', 'cn')).toBe('sz300750')
  })
  it('maps Hong Kong and US symbols with prefixes', () => {
    expect(qqCode('00700', 'hk')).toBe('hk00700')
    expect(qqCode('AAPL', 'us')).toBe('usAAPL')
  })
})

describe('tencent realtime parsing', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('parses a GBK quote line into a stable shape', async () => {
    // A representative 浦发银行 v_sh600000 response, GBK-encoded (ASCII-safe core fields).
    const body = 'v_sh600000="1~浦发银行~600000~9.10~9.18~9.14~436231~225394~210837~9.10~3028~9.09~4066~9.08~3912~9.07~4936~9.06~7661~9.09~4379~9.10~4023~9.11~3426~9.12~2783~9.13~2110~~20260814161455~-0.08~-0.87~9.17~9.06~9.10/436231/397586127~436231~39759~0.13~5.92~~9.17~9.06~1.20~3030.83~3030.83~0.40~10.10~8.26~0.81~10985~9.11~4.90~6.06~~~";'
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    })))
    const quotes = await fetchQuotes(['sh600000'])
    const q = quotes[0] as Quote
    expect(q.code).toBe('600000')
    expect(q.price).toBeCloseTo(9.1, 2)
    expect(q.change).toBeCloseTo(-0.08, 2)
    expect(q.changePct).toBeCloseTo(-0.87, 2)
  })
})

describe('kline request', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('builds the Tencent param and parses returned bars', async () => {
    const json = {
      code: 0, msg: 'ok', data: {
        sh600000: { qfqday: [
          ['2026-08-13', '9.00', '9.13', '9.20', '8.99', '510000'],
          ['2026-08-14', '9.14', '9.10', '9.17', '9.06', '436231'],
        ] },
      },
    }
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => ({
      ok: true, status: 200, json: async () => {
        const u = decodeURIComponent(String(url))
        expect(u).toContain('sh600000,day,,,30,qfq')
        return json
      },
    })))
    const bars = await fetchKline('sh600000', { period: 'day', count: 30, adjusted: true })
    expect(bars).toHaveLength(2)
    expect(bars[1]).toEqual({ date: '2026-08-14', open: 9.14, close: 9.1, high: 9.17, low: 9.06, volume: 436231 })
  })

  it('caps the requested count at 640', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => ({
      ok: true, status: 200, json: async () => {
        const u = decodeURIComponent(String(url))
        expect(u).toContain('sh600000,day,,,640,')
        return { code: 0, data: { sh600000: { day: [] } } }
      },
    })))
    await fetchKline('sh600000', { period: 'day', count: 5000 })
  })

  it('passes a date range and sorts bars oldest-first', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => ({
      ok: true, status: 200, json: async () => {
        const u = decodeURIComponent(String(url))
        expect(u).toContain('sh600000,day,2025-06-01,2025-06-30,')
        // Returned newest-first to prove the layer re-sorts.
        return { code: 0, data: { sh600000: { day: [
          ['2025-06-03', '9.20', '9.25', '9.30', '9.15', '400000'],
          ['2025-06-02', '9.10', '9.15', '9.18', '9.05', '350000'],
        ] } } }
      },
    })))
    const bars = await fetchKline('sh600000', { period: 'day', start: '2025-06-01', end: '2025-06-30' })
    expect(bars.map(b => b.date)).toEqual(['2025-06-02', '2025-06-03'])
  })
})

describe('TtlCache', () => {
  it('returns a value within TTL and undefined after it expires', () => {
    let now = 0
    const cache = new TtlCache<string, number>(1000, () => now)
    cache.set('a', 42)
    now = 500
    expect(cache.get('a')).toBe(42)
    now = 1000
    expect(cache.get('a')).toBeUndefined()
  })
})

describe('RateLimiter', () => {
  it('spaces concurrent acquires by the configured interval', async () => {
    let now = 0
    const slept: number[] = []
    const limiter = new RateLimiter(100, () => now, async ms => { slept.push(ms) })
    await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()])
    // Slots are reserved synchronously: 0, 100, 200; the second and third wait.
    expect(slept).toEqual([100, 200])
  })
})

describe('MarketDataService', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('caches a quote so two calls hit fetch once', async () => {
    const body = 'v_sh600000="1~浦发银行~600000~9.10~9.18~9.14~436231~0~0~9.10~0~9.09~0~9.08~0~9.07~0~9.06~0~9.09~0~9.10~0~9.11~0~9.12~0~9.13~0~~20260814161455~-0.08~-0.87~9.17~9.06~9.10/436231/397586127~436231~39759~0.13~5.92~~9.17~9.06~1.20~3030.83~3030.83~0.40~10.10~8.26~0.81~10985~9.11~4.90~6.06~~~";'
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    }))
    vi.stubGlobal('fetch', fetchMock)
    const svc = new MarketDataService(resolveMarketDataConfig({ minRequestIntervalMs: 1 }))
    const a = await svc.quote('sh600000')
    const b = await svc.quote('sh600000')
    expect(a.price).toBe(9.1)
    expect(b).toBe(a)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('validates config and rejects a non-positive field', () => {
    expect(() => resolveMarketDataConfig({ quoteTtlMs: 0 })).toThrow(/positive integer/)
  })
})
