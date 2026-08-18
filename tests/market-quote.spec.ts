import { describe, expect, it, vi, afterEach } from 'vitest'
import { qqCode, fetchQuotes, fetchKline, fetchQuote, type Quote, type Transport } from '../src/tencent.ts'
import { apply } from '../src/index.ts'
import { RateLimiter, Semaphore, TtlCache } from '../src/cache.ts'
import { MarketDataService, resolveMarketDataConfig } from '../src/service.ts'

const noopAcquire = () => Promise.resolve(() => {})

function testTransport(overrides: Partial<Transport> = {}): Transport {
  return { requestTimeoutMs: 5000, maxRetries: 0, retryBaseMs: 1, acquire: noopAcquire, ...overrides }
}

/** A minimal fake of the Cordis ctx surface `apply` needs: a tools and systemPrompt registry. */
function fakeCtx() {
  const registered: Array<{ name: string }> = []
  const ctx = {
    tools: { register: (def: { name: string }) => { registered.push(def); return () => {} } },
    systemPrompt: { context: () => () => {} },
  } as unknown as Parameters<typeof apply>[0]
  return { ctx, registered }
}

describe('dsh-market-quote tool registration', () => {
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
    const quotes = await fetchQuotes(['sh600000'], testTransport())
    const q = quotes[0] as Quote
    expect(q.code).toBe('600000')
    expect(q.price).toBeCloseTo(9.1, 2)
    expect(q.change).toBeCloseTo(-0.08, 2)
    expect(q.changePct).toBeCloseTo(-0.87, 2)
  })

  it('parses a dotted US code (e.g. BRK.B)', async () => {
    const body = 'v_usBRK.B="1~Berkshire Hathaway~BRK.B~400.00~398.00~399.00~1234~";'
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    })))
    const quotes = await fetchQuotes(['usBRK.B'], testTransport())
    expect(quotes[0]?.code).toBe('BRK.B')
    expect(quotes[0]?.name).toBe('Berkshire Hathaway')
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
    const bars = await fetchKline('sh600000', { period: 'day', count: 30, adjusted: true }, testTransport())
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
    await fetchKline('sh600000', { period: 'day', count: 5000 }, testTransport())
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
    const bars = await fetchKline('sh600000', { period: 'day', start: '2025-06-01', end: '2025-06-30' }, testTransport())
    expect(bars.map(b => b.date)).toEqual(['2025-06-02', '2025-06-03'])
  })

  it('acquires the rate-limit gate once per paginated request (backward paging)', async () => {
    const genBarsEndingAt = (n: number, endIso: string): string[][] => {
      const endMs = Date.parse(endIso)
      return Array.from({ length: n }, (_, i) => {
        const date = new Date(endMs - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10)
        return [date, '9.00', '9.10', '9.20', '8.90', '1000']
      })
    }
    // Tencent returns the newest bars first: 640 ending at the range end, then a shorter older page.
    const pages = [genBarsEndingAt(640, '2025-12-31'), genBarsEndingAt(10, '2024-01-01')]
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ code: 0, data: { sh600000: { day: pages.shift() } } }),
    }))
    const acquire = vi.fn(async () => () => {})
    vi.stubGlobal('fetch', fetchMock)
    const bars = await fetchKline('sh600000', { period: 'day', start: '2023-01-01', end: '2025-12-31', count: 2000 }, testTransport({ acquire }))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(bars).toHaveLength(650)
    expect(bars[0]?.date).toBe('2023-12-23') // oldest (older page, after reversal)
    expect(bars.at(-1)?.date).toBe('2025-12-31') // newest (newest page)
  })
})

describe('per-request retry & cancellation', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('retries only the failed page, not the whole pagination', async () => {
    const genBarsEndingAt = (n: number, endIso: string): string[][] => {
      const endMs = Date.parse(endIso)
      return Array.from({ length: n }, (_, i) => {
        const date = new Date(endMs - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10)
        return [date, '9.00', '9.10', '9.20', '8.90', '1000']
      })
    }
    const responses = [
      { ok: true, status: 200, json: async () => ({ code: 0, data: { sh600000: { day: genBarsEndingAt(640, '2025-12-31') } } }) },
      { ok: false, status: 502 },
      { ok: true, status: 200, json: async () => ({ code: 0, data: { sh600000: { day: genBarsEndingAt(10, '2024-01-01') } } }) },
    ]
    const fetchMock = vi.fn(async () => responses.shift())
    vi.stubGlobal('fetch', fetchMock)
    const bars = await fetchKline('sh600000', { period: 'day', start: '2023-01-01', end: '2025-12-31', count: 2000 }, testTransport({ maxRetries: 1, retryBaseMs: 1 }))
    expect(fetchMock).toHaveBeenCalledTimes(3) // page1 + page2-fail + page2-retry (page1 not re-fetched)
    expect(bars).toHaveLength(650)
  })

  it('does not fetch or retry when the external signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchQuote('sh600000', testTransport({ signal: controller.signal, maxRetries: 3 }))).rejects.toThrow(/aborted/)
    expect(fetchMock).not.toHaveBeenCalled()
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

describe('Semaphore', () => {
  it('bounds in-flight acquires to the limit and releases a slot', async () => {
    const sem = new Semaphore(2)
    const r1 = await sem.acquire()
    const r2 = await sem.acquire()
    let thirdAcquired = false
    const third = sem.acquire().then(release => { thirdAcquired = true; release() })
    expect(thirdAcquired).toBe(false) // limit 2 reached, third is still queued
    r1() // free one slot → the queued third proceeds
    await third
    expect(thirdAcquired).toBe(true)
    r2()
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
    expect(() => resolveMarketDataConfig({ quoteTtlMs: 0 })).toThrow(/integer >= 1/)
  })

  it('defaults maxConcurrency and rejects a non-positive value', () => {
    expect(resolveMarketDataConfig().maxConcurrency).toBe(3)
    expect(() => resolveMarketDataConfig({ maxConcurrency: 0 })).toThrow(/integer >= 1/)
  })

  it('allows maxRetries 0 (disable) but rejects negative', () => {
    expect(resolveMarketDataConfig({ maxRetries: 0 }).maxRetries).toBe(0)
    expect(() => resolveMarketDataConfig({ maxRetries: -1 })).toThrow(/integer >= 0/)
  })

  it('retries a transient 5xx and then succeeds', async () => {
    const body = 'v_sh600000="1~浦发银行~600000~9.10~9.18~9.14~436231~0~0~9.10~0~9.09~0~9.08~0~9.07~0~9.06~0~9.09~0~9.10~0~9.11~0~9.12~0~9.13~0~~20260814161455~-0.08~-0.87~9.17~9.06~9.10/436231/397586127~436231~39759~0.13~5.92~~9.17~9.06~1.20~3030.83~3030.83~0.40~10.10~8.26~0.81~10985~9.11~4.90~6.06~~~";'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 502 })
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValue({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(body).buffer })
    vi.stubGlobal('fetch', fetchMock)
    const svc = new MarketDataService(resolveMarketDataConfig({ minRequestIntervalMs: 1, retryBaseMs: 1 }))
    const q = await svc.quote('sh600000')
    expect(q.price).toBe(9.1)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('does not retry a 4xx (429)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 429 })
    vi.stubGlobal('fetch', fetchMock)
    const svc = new MarketDataService(resolveMarketDataConfig({ minRequestIntervalMs: 1, retryBaseMs: 1 }))
    await expect(svc.quote('sh600000')).rejects.toThrow(/429/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('gives up after maxRetries transient failures', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 502 })
    vi.stubGlobal('fetch', fetchMock)
    const svc = new MarketDataService(resolveMarketDataConfig({ minRequestIntervalMs: 1, retryBaseMs: 1, maxRetries: 2 }))
    await expect(svc.quote('sh600000')).rejects.toThrow(/502/)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})

describe('large-range confirmation', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  function fakeCtxWithQuestions(ask: (questions: unknown) => unknown) {
    let klineExecute: any
    const ctx = {
      tools: {
        register: (def: any) => { if (def.name === 'market_kline') klineExecute = def.execute; return () => {} },
      },
      systemPrompt: { context: () => () => {} },
      get: (name: string) => (name === 'userQuestions' ? { ask } : undefined),
    } as any
    apply(ctx)
    return { ctx, get execute() { return klineExecute } }
  }

  it('asks for confirmation and cancels a paginated day range', async () => {
    const asked: string[] = []
    const { execute } = fakeCtxWithQuestions(async (req: any) => {
      asked.push(req.questions[0].id)
      return { answers: [{ id: 'confirm-large-range', selected: ['取消'] }] }
    })
    const result = await execute(
      { symbol: '600000', market: 'cn', period: 'day', start: '2020-01-01', end: '2026-01-01', count: 2000 },
      { agent: undefined, signal: undefined },
    )
    expect(asked).toEqual(['confirm-large-range'])
    expect(result.cancelled).toBe(true)
  })

  it('proceeds without asking when no userQuestions provider is present', async () => {
    const { execute } = fakeCtxWithQuestions(async () => { throw new Error('should not be called') })
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ code: 0, data: { sh600000: { day: [] } } }),
    })))
    const result = await execute(
      { symbol: '600000', market: 'cn', period: 'day', start: '2020-01-01', end: '2026-01-01', count: 2000 },
      { agent: undefined, signal: undefined },
    )
    expect(result.cancelled).toBe(false)
    expect(result.bars).toEqual([])
  })
})
