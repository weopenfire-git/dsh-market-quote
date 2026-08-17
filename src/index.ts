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
import { qqCode, type FetchKlineOptions, type Market } from './tencent.ts'
import { MarketDataService, resolveMarketDataConfig, type MarketDataConfig } from './service.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-market-quote'

/** Services required by the plugin's tools. */
export const inject = ['tools']

/** Plugin config: cache lifetimes and request spacing (all positive integers in ms). */
export interface Config extends MarketDataConfig {}

/**
 * Register the `market_quote` and `market_kline` tools.
 * @param ctx - context whose `tools` registry receives the registrations.
 * @param config - cache/throttle tunables; omitted fields take service defaults.
 */
export function apply(ctx: Context, config?: Config): void {
  const service = new MarketDataService(resolveMarketDataConfig(config))
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
    timeoutMs: 15_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const rawCode = qqCode(args.symbol, args.market)
      const q = await service.quote(rawCode)
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
      + 'it returns bars in that date range, oldest first. Set start=end to query one specific day.',
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
        description: 'Bar interval; defaults to day',
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
        description: 'Max bars to return; defaults to 30 (recent) or 640 (range), hard cap 2000',
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          symbol: { type: 'string', required: true },
          market: { type: 'string', required: true },
          period: { type: 'string', required: true },
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
        if (value.bars.length === 0) {
          return [{ type: 'text', text: `${value.symbol} (${value.market.toUpperCase()}): no bars returned` }]
        }
        const head = value.bars.slice(-3).map(b =>
          `${b.date} ${b.close} ${b.high}/${b.low} vol=${b.volume}`).join('\n')
        return [{ type: 'text', text:
          `${value.symbol} (${value.market.toUpperCase()}) ${value.period}: ${value.bars.length} bars `
          + `(${value.bars[0]?.date}..${value.bars.at(-1)?.date})\n${head}` }]
      },
    },
    timeoutMs: 15_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const market: Market = args.market
      const period = args.period ?? 'day'
      const baseRaw = qqCode(args.symbol, market)
      // US history requires the exchange suffix (e.g. AAPL.OQ); resolve it from
      // the live quote, which returns the canonical market-qualified code.
      const rawCode = market === 'us'
        ? 'us' + ((await service.quote(baseRaw)).code)
        : baseRaw
      const options: FetchKlineOptions = { period }
      if (args.start !== undefined) options.start = args.start
      if (args.end !== undefined) options.end = args.end
      if (args.count !== undefined) options.count = args.count
      const bars = await service.kline(rawCode, options)
      return {
        symbol: args.symbol,
        market,
        period,
        bars: bars.map(b => ({ ...b })),
      }
    },
  }))
}
