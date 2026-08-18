/**
 * dsh-market-quote tool plugin.
 *
 * Registers two model-facing tools backed by Tencent's public quote API:
 * `market_quote` for realtime quotes and `market_kline` for historical
 * daily/weekly/monthly bars. Both cover A-share, HK, and US symbols from one
 * data source.
 *
 * Mount this as an agent-preset row (see README) so its tools join whatever
 * preset an agent runs on. Registration is effect-scoped: disposing the preset
 * fiber unregisters both tools.
 * @module dsh-market-quote
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PromptContext } from '@deepseek-ai/dsh-system-prompt'
import { qqCode, type FetchKlineOptions, type Market } from './tencent.ts'
import { MarketDataService, resolveMarketDataConfig, type MarketDataConfig } from './service.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-market-quote'

/** Services required by the plugin's tools and usage guidance. */
export const inject = ['tools', 'systemPrompt']

/** Plugin config: cache lifetimes, request spacing, retry, and concurrency (all in MarketDataConfig). */
export interface Config extends MarketDataConfig {}

/** Minimal structural answer from the optional `ctx.userQuestions` service. */
interface UserQuestionAnswer {
  answers: Array<{ id: string; selected: string[] }>
}

/** Minimal structural view of the optional `ctx.userQuestions` service. */
interface UserQuestionsLike {
  ask(request: {
    questions: Array<{
      id: string
      question: string
      header?: string
      options?: Array<{ label: string; description?: string }>
    }>
    agent?: unknown
    signal?: AbortSignal
  }): Promise<UserQuestionAnswer>
}

/**
 * Ask the user to confirm a paginated (slow) large-range query before issuing
 * it. Resolves `true` when there is no provider or the caller is not a live
 * root, so headless / delegated callers proceed without blocking.
 */
async function confirmLargeRange(
  ctx: Context,
  exec: { agent?: unknown; signal?: AbortSignal },
  pages: number,
): Promise<boolean> {
  const userQuestions = ctx.get('userQuestions') as UserQuestionsLike | undefined
  if (userQuestions === undefined) return true
  try {
    const answer = await userQuestions.ask({
      questions: [{
        id: 'confirm-large-range',
        header: '大区间查询确认',
        question: `该查询需分页约 ${pages} 次（每次请求间隔 ≥500ms），可能等待较久。是否继续？`,
        options: [
          { label: '继续', description: '接受较长等待，立即查询' },
          { label: '取消，改用周线/月线', description: 'period=week/month 单请求覆盖多年，更快' },
        ],
      }],
      agent: exec.agent,
      signal: exec.signal,
    })
    const choice = answer.answers.find(item => item.id === 'confirm-large-range')
    return choice?.selected[0] === '继续'
  } catch {
    // No provider / not a live root: fall back to proceeding without confirmation.
    return true
  }
}

/**
 * Register the `market_quote` and `market_kline` tools.
 * @param ctx - context whose `tools` registry receives the registrations.
 * @param config - cache/throttle tunables; omitted fields take service defaults.
 */
export function apply(ctx: Context, config?: Config): void {
  const service = new MarketDataService(resolveMarketDataConfig(config))
  const usage: PromptContext = {
    name: 'dsh-market-quote:usage',
    order: 100,
    text: '【行情查询建议】dsh-market-quote 走腾讯公开接口：每个 HTTP 请求间隔 ≥500ms（≤2 QPS），'
      + '日线超过 640 根会分页（每页 640 根，单次最多 2000 根 ≈ 4 页），分页越多等待越长、请求越多、越易触发限流。'
      + '建议：查最新价用 market_quote（单请求）；短期走势用 market_kline 的 period=day 且 count ≤640（单请求）；'
      + '跨年长期走势优先用 period=week（单请求约 12 年）或 period=month（约 53 年），'
      + '避免超大 day 区间分页，以减少等待、降低被封风险。',
  }
  ctx.systemPrompt.context(usage)
  ctx.tools.register(defineTool({
    name: 'market_quote',
    description:
      'Get a realtime quote for one stock on the A-share (China), Hong Kong, or US market. '
      + "Use a bare symbol without prefix: for example '600000' (A-share), '00700' (Hong Kong), 'AAPL' (US). "
      + 'Returns the latest price, prev close, open, high, low, change, and trading volume.',
    parameters: {
      symbol: { type: 'string', required: true, description: 'Bare stock symbol, e.g. 600000 / 00700 / AAPL' },
      market: {
        type: 'string', required: true,
        enum: ['cn', 'hk', 'us'],
        description: 'cn = A-share (China), hk = Hong Kong, us = United States',
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          symbol: { type: 'string', required: true },
          name: { type: 'string', required: true },
          price: { type: 'number', required: true },
          prevClose: { type: 'number', required: true },
          open: { type: 'number', required: true },
          change: { type: 'number', required: true },
          changePct: { type: 'number', required: true },
          high: { type: 'number', required: true },
          low: { type: 'number', required: true },
          market: { type: 'string', required: true },
          quoteTime: { type: 'string', required: true },
          delayed: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => {
        const flag = value.delayed ? ' (delayed)' : ''
        return [{
          type: 'text',
          text: `${value.name} (${value.market.toUpperCase()})${flag}: ${value.price} `
            + `(${value.changePct >= 0 ? '+' : ''}${value.changePct}%, ${value.change >= 0 ? '+' : ''}${value.change})`
            + `  open=${value.open} high=${value.high} low=${value.low} prevClose=${value.prevClose}`,
        }]
      },
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const rawCode = qqCode(args.symbol, args.market)
      const q = await service.quote(rawCode, exec.signal)
      return {
        symbol: q.code,
        name: q.name,
        price: q.price,
        prevClose: q.prevClose,
        open: q.open,
        change: q.change,
        changePct: q.changePct,
        high: q.high,
        low: q.low,
        market: args.market,
        quoteTime: q.time,
        delayed: q.delayed ?? false,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'market_kline',
    description:
      'Get historical price bars (daily, weekly, or monthly candles) for one stock across '
      + 'A-share (cn), Hong Kong (hk), or US (us) markets. '
      + "Use a bare symbol without prefix: for example '600000' (A-share), '00700' (Hong Kong), 'AAPL' (US). "
      + 'Without start/end it returns the most-recent bars; with start (and optionally end, YYYY-MM-DD) '
      + 'it returns bars in that date range, oldest first. Set start=end to query one specific day. '
      + 'Daily ranges over 640 bars paginate (each request is spaced ≥500ms), so very large day ranges are slow; '
      + 'prefer period=week/month for multi-year spans, or keep count ≤640.',
    parameters: {
      symbol: { type: 'string', required: true, description: 'Bare stock symbol, e.g. 600000 / 00700 / AAPL' },
      market: {
        type: 'string', required: true,
        enum: ['cn', 'hk', 'us'],
        description: 'cn = A-share (China), hk = Hong Kong, us = United States',
      },
      period: {
        type: 'string',
        enum: ['day', 'week', 'month'],
        description: 'Bar interval; defaults to day. Prefer week or month for multi-year spans (~12/~53 years in one request)',
      },
      start: {
        type: 'string',
        description: 'Inclusive start date YYYY-MM-DD; omit for most-recent bars',
      },
      end: {
        type: 'string',
        description: 'Inclusive end date YYYY-MM-DD; defaults to today when start is given',
      },
      count: {
        type: 'integer',
        description: 'Max bars to return; defaults to 30 (recent) or 640 (range), hard cap 2000. Keep ≤640 to avoid pagination',
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          symbol: { type: 'string', required: true },
          market: { type: 'string', required: true },
          period: { type: 'string', required: true },
          elapsedMs: { type: 'number', required: true },
          cancelled: { type: 'boolean', required: true },
          bars: {
            type: 'array',
            required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                date: { type: 'string', required: true },
                open: { type: 'number', required: true },
                close: { type: 'number', required: true },
                high: { type: 'number', required: true },
                low: { type: 'number', required: true },
                volume: { type: 'number', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.cancelled) {
          return [{ type: 'text', text: `${value.symbol} (${value.market.toUpperCase()}): cancelled — large-range query not confirmed` }]
        }
        if (value.bars.length === 0) {
          return [{ type: 'text', text: `${value.symbol} (${value.market.toUpperCase()}): no bars returned` }]
        }
        const head = value.bars.slice(-3).map(b =>
          `${b.date} ${b.close} ${b.high}/${b.low} vol=${b.volume}`).join('\n')
        const pages = Math.ceil(value.bars.length / 640)
        const note = pages > 1
          ? `\n(paginated ${pages} requests, took ${value.elapsedMs}ms; prefer week/month or a smaller range to reduce waiting)`
          : ''
        return [{ type: 'text', text:
          `${value.symbol} (${value.market.toUpperCase()}) ${value.period}: ${value.bars.length} bars `
          + `(${value.bars[0]?.date}..${value.bars.at(-1)?.date})\n${head}${note}` }]
      },
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const market: Market = args.market
      const period = args.period ?? 'day'
      // A day-range query over 640 bars paginates (up to ~4 requests); confirm first.
      const pages = Math.ceil(Math.min(2_000, args.count ?? 640) / 640)
      if (period === 'day' && pages > 1 && (args.start !== undefined || args.end !== undefined)) {
        const ok = await confirmLargeRange(ctx, exec, pages)
        if (!ok) {
          return {
            symbol: args.symbol,
            market,
            period,
            elapsedMs: 0,
            cancelled: true,
            bars: [],
          }
        }
      }
      const baseRaw = qqCode(args.symbol, market)
      // US history requires the exchange suffix (e.g. AAPL.OQ); resolve it from
      // the live quote, which returns the canonical market-qualified code.
      const rawCode = market === 'us'
        ? 'us' + ((await service.quote(baseRaw, exec.signal)).code)
        : baseRaw
      const options: FetchKlineOptions = { period }
      if (args.start !== undefined) options.start = args.start
      if (args.end !== undefined) options.end = args.end
      if (args.count !== undefined) options.count = args.count
      const startedAt = Date.now()
      const bars = await service.kline(rawCode, options, exec.signal)
      return {
        symbol: args.symbol,
        market,
        period,
        elapsedMs: Date.now() - startedAt,
        cancelled: false,
        bars: bars.map(b => ({ ...b })),
      }
    },
  }))
}
