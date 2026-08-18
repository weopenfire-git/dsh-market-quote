// Standalone runtime validation of the pure dsh-markets logic, run with:
//   node validate.mjs
// It transpiles src/{tencent,cache,service}.ts in-process (no child spawn, no
// vitest) and exercises symbol mapping, GBK realtime parsing, kline URL/paging,
// TTL cache, the rate limiter, and the cached service facade against stubbed
// fetch responses copied verbatim from the live-test research reports.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const ts = createRequire(join(here, '..', '..', 'node_modules', 'typescript'))('typescript')
const iconv = createRequire(join(here, '..', '..', 'node_modules', '.pnpm', 'iconv-lite@0.6.3', 'node_modules', 'iconv-lite'))('iconv-lite')

// Transpile one src/*.ts into lib-tmp/*.js, rewriting relative .ts specifiers to .js.
const tmpDir = join(here, 'lib-tmp')
mkdirSync(tmpDir, { recursive: true })
function transpileTo(relSrc, outName) {
  const source = readFileSync(join(here, 'src', relSrc), 'utf8')
  let out = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2024,
      rewriteRelativeImportExtensions: true,
    },
    fileName: relSrc,
  }).outputText
  out = out.replace(/from '(\.\/[^']+)\.ts'/g, "from '$1.js'")
  writeFileSync(join(tmpDir, outName), out)
}
transpileTo('tencent.ts', 'tencent.js')
transpileTo('cache.ts', 'cache.js')
transpileTo('service.ts', 'service.js')

const tencent = await import(pathToFileURL(join(tmpDir, 'tencent.js')).href)
const cache = await import(pathToFileURL(join(tmpDir, 'cache.js')).href)
const service = await import(pathToFileURL(join(tmpDir, 'service.js')).href)
const { qqCode, fetchQuotes, fetchKline } = tencent
const { TtlCache, RateLimiter } = cache
const { MarketDataService, resolveMarketDataConfig } = service
const noopAcquire = () => Promise.resolve(() => {})
const testTransport = { requestTimeoutMs: 5000, maxRetries: 0, retryBaseMs: 1, acquire: noopAcquire }

let failures = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    console.log(`  ok  ${label}`)
  } else {
    failures += 1
    console.log(`FAIL  ${label}\n      expected ${e}\n      actual   ${a}`)
  }
}

// 1. qqCode mapping
check('qqCode 600000 -> sh600000', qqCode('600000', 'cn'), 'sh600000')
check('qqCode 000001 -> sz000001', qqCode('000001', 'cn'), 'sz000001')
check('qqCode 00700 -> hk00700', qqCode('00700', 'hk'), 'hk00700')
check('qqCode AAPL -> usAAPL', qqCode('AAPL', 'us'), 'usAAPL')

// 2. Realtime GBK parse, body copied verbatim from the research report.
const realtimeBody = 'v_sh600000="1~浦发银行~600000~9.10~9.18~9.14~436231~225394~210837~9.10~3028~9.09~4066~9.08~3912~9.07~4936~9.06~7661~9.09~4379~9.10~4023~9.11~3426~9.12~2783~9.13~2110~~20260814161455~-0.08~-0.87~9.17~9.06~9.10/436231/397586127~436231~39759~0.13~5.92~~9.17~9.06~1.20~3030.83~3030.83~0.40~10.10~8.26~0.81~10985~9.11~4.90~6.06~~~";'
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => iconv.encode(realtimeBody, 'gbk').buffer,
})
const [quote] = await fetchQuotes(['sh600000'], testTransport)
check('realtime code', quote.code, '600000')
check('realtime price', quote.price, 9.1)
check('realtime change', quote.change, -0.08)
check('realtime changePct', quote.changePct, -0.87)
check('realtime name decoded GBK', quote.name, '浦发银行')

// 3. Kline URL construction + parse, body copied verbatim from the report.
const klineBody = { code: 0, msg: 'ok', data: { sh600000: { qfqday: [
  ['2026-08-13', '9.000', '9.130', '9.200', '8.990', '510000'],
  ['2026-08-14', '9.140', '9.100', '9.170', '9.060', '436231'],
] } } }
let capturedUrl = ''
globalThis.fetch = async (url) => {
  capturedUrl = String(url)
  return { ok: true, status: 200, json: async () => klineBody }
}
const bars = await fetchKline('sh600000', { period: 'day', count: 30, adjusted: true }, testTransport)
check('kline url carries qfq+count', decodeURIComponent(capturedUrl), 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600000,day,,,30,qfq')
check('kline bar count', bars.length, 2)
check('kline last bar', bars[1], { date: '2026-08-14', open: 9.14, close: 9.1, high: 9.17, low: 9.06, volume: 436231 })

// 4. Count cap at 640 (unadjusted: key is `day`)
globalThis.fetch = async (url) => {
  capturedUrl = String(url)
  return { ok: true, status: 200, json: async () => ({ code: 0, data: { sh600000: { day: [] } } }) }
}
await fetchKline('sh600000', { period: 'day', count: 5000 }, testTransport)
check('kline count capped to 640', decodeURIComponent(capturedUrl).includes('sh600000,day,,,640,'), true)

// 5. Date range passes start/end and sorts oldest-first.
globalThis.fetch = async (url) => {
  capturedUrl = String(url)
  return { ok: true, status: 200, json: async () => ({ code: 0, data: { sh600000: { day: [
    ['2025-06-03', '9.20', '9.25', '9.30', '9.15', '400000'],
    ['2025-06-02', '9.10', '9.15', '9.18', '9.05', '350000'],
  ] } } }) }
}
const ranged = await fetchKline('sh600000', { period: 'day', start: '2025-06-01', end: '2025-06-30' }, testTransport)
check('range url carries start+end', decodeURIComponent(capturedUrl), 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600000,day,2025-06-01,2025-06-30,640,')
check('range bars sorted oldest-first', ranged.map(b => b.date), ['2025-06-02', '2025-06-03'])

// 6. TTL cache expiry.
let clock = 0
const ttl = new TtlCache(1000, () => clock)
ttl.set('a', 42)
clock = 500
check('ttl hit within TTL', ttl.get('a'), 42)
clock = 1000
check('ttl miss after expiry', ttl.get('a'), undefined)

// 7. Rate limiter spaces concurrent acquires.
let lnow = 0
const slept = []
const limiter = new RateLimiter(100, () => lnow, async ms => { slept.push(ms) })
await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()])
check('limiter spaces three acquires', slept, [100, 200])

// 8. Service caches a quote so two calls hit fetch once.
let fetchCount = 0
globalThis.fetch = async () => {
  fetchCount += 1
  return { ok: true, status: 200, arrayBuffer: async () => iconv.encode(realtimeBody, 'gbk').buffer }
}
const svc = new MarketDataService(resolveMarketDataConfig({ minRequestIntervalMs: 1 }))
const q1 = await svc.quote('sh600000')
const q2 = await svc.quote('sh600000')
check('service caches quote (one fetch)', fetchCount, 1)
check('service returns same quote', q1 === q2, true)
check('service config defaults', resolveMarketDataConfig(), { quoteTtlMs: 5000, klineTtlMs: 300000, minRequestIntervalMs: 500, maxRetries: 3, retryBaseMs: 1000, requestTimeoutMs: 5000, maxConcurrency: 3 })
let threw = false
try { resolveMarketDataConfig({ quoteTtlMs: 0 }) } catch { threw = true }
check('service rejects non-positive config', threw, true)
check('service allows maxRetries 0', resolveMarketDataConfig({ maxRetries: 0 }).maxRetries, 0)
let threwNeg = false
try { resolveMarketDataConfig({ maxRetries: -1 }) } catch { threwNeg = true }
check('service rejects negative maxRetries', threwNeg, true)

// 9. Retry: transient 5xx is retried then succeeds; 4xx (429) is never retried.
let rAttempts = 0
globalThis.fetch = async () => {
  rAttempts += 1
  if (rAttempts < 3) return { ok: false, status: 502 }
  return { ok: true, status: 200, arrayBuffer: async () => iconv.encode(realtimeBody, 'gbk').buffer }
}
const rSvc = new MarketDataService(resolveMarketDataConfig({ minRequestIntervalMs: 1, retryBaseMs: 1, requestTimeoutMs: 1000 }))
const rQuote = await rSvc.quote('sh600000')
check('retry succeeds after transient 5xx', [rQuote.price, rAttempts], [9.1, 3])

rAttempts = 0
globalThis.fetch = async () => { rAttempts += 1; return { ok: false, status: 429 } }
const rSvc2 = new MarketDataService(resolveMarketDataConfig({ minRequestIntervalMs: 1, retryBaseMs: 1, requestTimeoutMs: 1000 }))
let threw429 = false
try { await rSvc2.quote('sh600000') } catch { threw429 = true }
check('4xx (429) is not retried', [threw429, rAttempts], [true, 1])

rmSync(tmpDir, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
