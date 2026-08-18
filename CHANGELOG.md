# Changelog

本项目的所有显著变更都会记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.6.1] - 2026-08-18

### Fixed

- npm 包 README 中的三张截图改为 GitHub raw 绝对链接，修复 npm 包页面上相对路径图片失效的问题（`docs/` 不进 npm 包，相对路径在 npm 页面无法解析）。

## [0.6.0] - 2026-08-17

### Fixed

- 网络错误归一化：`fetchWithTimeout` 把网络失败包成 `NetworkError`，`isTransientError` 不再把一切 `TypeError`（含代码 bug）当瞬时重试。
- 实时行情 `high`/`low` 回退只在主字段为空时生效（`priceField`），修复停牌股 `high=0` 被误回退到别的字段。
- `week`/`month` 区间同样改为向后翻页，修复 >12/53 年区间静默只返回最新 640 根的截断。
- `end` 缺省改为交易所本地「今天」（CN/HK 精确 UTC+8；US 近似 UTC-5、忽略 DST）。

### Added

- `cacheMaxSize`（默认 1000）缓存条目上限、最旧淘汰，防长进程内存无界增长。
- 美股历史在解析不到交易所后缀时 fail-loud（清晰报错），替代此前的含糊下游错误。

## [0.5.0] - 2026-08-17

### Changed

- 重试下沉到数据层、改为「单次 HTTP 请求」粒度：分页查询中某一页失败只重试该页，不再重跑整个分页（避免请求数被重试放大）。
- 引入 `Transport` 打包（`requestTimeoutMs` / `maxRetries` / `retryBaseMs` / `acquire` / `signal`），统一每个请求的传输参数。

### Added

- 接入工具调用的取消信号（`exec.signal`）：取消 / 超时会真正中断 in-flight 请求（`AbortSignal.any` 组合每尝试超时信号），且已取消的请求不再重试。

## [0.4.1] - 2026-08-17

### Fixed

- 修复 `day` 大区间分页方向错误：腾讯对区间查询返回「最新 640 根」，此前代码按「最早 640 根」向前翻页，导致超大区间静默只返回最新 640 根、旧数据全部丢失；现改为向后翻页并反转。
- 修复限速门控顺序：先取并发槽、再取时间槽，避免被并发信号量排队延迟的请求与实际请求间距 <500ms、破坏限速保证。
- 修复实时行情解析正则：`\w+` 无法匹配带点的美股代码（如 `BRK.B`），改为 `[\w.]+`。

## [0.4.0] - 2026-08-17

### Added

- 并发上限：新增 `maxConcurrency`（默认 3）信号量，除时间间隔限速外另设并发在途请求硬上限。
- 超大区间发出前确认：`market_kline` 检测到 `day` 区间 `count > 640`（会分页）时，经可选 `ctx.userQuestions` 询问用户；无 provider / 非 live root 时静默放行。

### Changed

- `Acquire` 门控改为「acquire → fetch → release」，每个请求既过时间限速、又占并发槽并随用随放。

## [0.3.0] - 2026-08-17

### Changed

- 限速下探：每个 HTTP 请求（含日线分页的每一页、重试的每次尝试）都经全局限速器排队，修复此前超大 `day` 区间分页时连发请求、绕过限速的漏洞。

### Added

- 会话启动注入「使用建议」systemPrompt 块，建议合理区间 / 周期与点数，减少等待与封禁风险。
- `market_kline` 工具描述与参数增加成本提示；结果超过 640 根时回显分页次数与耗时。
- 输出 schema 新增 `elapsedMs` 字段。

## [0.2.0] - 2026-08-17

### Added

- 安全重试策略：仅对临时错误（HTTP 5xx / 网络失败 / 超时）做指数退避 + 全抖动（1s→2s→4s）重试，最多 3 次；4xx（含 429）绝不重试；每次重试同样经全局限速器排队，不放大 QPS。
- 单次尝试 `AbortController` 超时（`requestTimeoutMs`，默认 5s），挂死请求快速失败并进入重试。
- 新增 `maxRetries` / `retryBaseMs` / `requestTimeoutMs` 三个配置项。
- 新增 `HttpError` 与 `isTransientError` 错误分类，供重试层判断可重试性。
- 单元测试与 `validate.mjs` 覆盖重试行为（5xx 重试成功 / 429 不重试 / 次数上限）。

### Changed

- 工具 `timeoutMs` 由 15000 调整为 30000（容纳最多 4 次尝试 + 退避）。

## [0.1.0] - 2026-08-17

首个可发布版本。

### Added

- `market_quote` 工具：A股 / 港股 / 美股单只股票实时行情（现价、昨收、今开、最高、最低、涨跌额、涨跌幅、成交量、报价时间、是否延迟）。
- `market_kline` 工具：A股 / 港股 / 美股历史日 / 周 / 月 K 线（开、收、高、低、量，最旧在前），支持日期区间、`start=end` 单日查询、最近 N 根、数量上限与日线分页。
- 数据源层：腾讯公开行情接口（`qt.gtimg.cn` 实时、`web.ifzq.gtimg.cn` 历史），GBK 解码 + 容错解析 + 美股历史自动补交易所后缀。
- 缓存与限流：实时报价 5s TTL、K 线 5min TTL、同 key 单飞、请求间隔 ≥500ms（≤2 QPS），均可在插件 `config` 覆盖。
- 单元测试（vitest）、免 vitest 的独立运行时校验（`validate.mjs`）、真实加载冒烟测试（`smoke.mjs`）、示例 preset 片段。

### Fixed

- 修复单元测试中三处对「已百分号编码的 K 线 URL」未做 `decodeURIComponent` 就断言、导致误报的用例（`tests/market-quote.spec.ts`）。

### Notes

- 数据源为腾讯公开接口，非官方授权；合规 / 分发请自行评估，生产环境建议评估付费行情源。
- 缓存为进程内内存缓存，重启即失效；多实例 / 多进程不共享。
