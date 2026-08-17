// Real-load smoke test: boots a minimal Cordis runtime (SystemPrompt + ToolRuntime),
// mounts the dsh-markets plugin, and asserts its two tools registered through the
// real tool registry. Run from the prototype dir with:
//   node --import tsx/esm smoke.mjs
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as MarketQuote from './src/index.ts'

const ctx = new Context()
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(MarketQuote)

const names = ctx.tools.schemas().map(schema => schema.name).sort()
console.log('registered tools:', names.join(', '))

const want = ['market_kline', 'market_quote']
const missing = want.filter(name => !names.includes(name))
if (missing.length > 0) {
  console.error('FAIL: missing tools', missing)
  process.exit(1)
}
console.log('OK: market_quote + market_kline registered through the real registry')
// No explicit teardown: registrations are in-memory and the process exits cleanly.
