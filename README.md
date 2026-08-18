# dsh-market-quote

DeepSeek Harness 行情工具插件：为 Agent 注册 `market_quote` / `market_kline` 两个只读工具，用**一个数据源**覆盖 **A股 / 港股 / 美股** 的实时行情与历史日 / 周 / 月 K 线。**无需额外 API**：数据来自腾讯公开行情接口（免费、免 key、免注册）。**专为机器使用**：只返回结构化 OHLCV 数据，依赖 DSH 通用工具卡片渲染，不附带冗余的图形界面。

> 使用说明（含截图与实测示例）：[docs/USAGE.md](./docs/USAGE.md) ｜ 设计记录：[docs/design.md](./docs/design.md)

> 简体中文 · [English](./README.en.md)

## 核心亮点

- **两工具、三市场、单一源**：实时报价 + 历史 K 线；A股 / 港股 / 美股统一裸代码入口（`600000` / `00700` / `AAPL`），前缀后缀自动补齐。
- **零凭证、零配置**：腾讯公开行情接口，免 API key、免 Referer；Node ≥22.19 内置 `fetch` 与 GBK `TextDecoder`，无第三方运行时依赖。
- **内置限流防封**：全局限速 ≤2 QPS（两次请求间隔 ≥500ms）+ 同 key 单飞 + 报价 5s / K 线 5min 缓存，把并发突发摊平为低频串行请求，避免「一次性要太多」触发上游封禁 / IP 封锁；均可配置。
- **安全重试**：只对临时错误（5xx / 网络失败 / 超时）做指数退避重试（1s→2s→4s + 全抖动，≤3 次）；4xx（含 429「停」信号）绝不重试；重试同样排队走全局限速，不放大 QPS。
- **超大区间发出前确认**：`day` 区间超过 640 根（会分页、等待变长）时，先询问用户是否继续；无 UI / headless 时自动放行。
- **只读、并发安全、30s 超时**：工具无副作用，可安全并发调用。

## 技术设计

- **单一数据源 + 字节级解码**：实时接口 `qt.gtimg.cn` 返回 GBK 编码、`~` 分隔的字段串，按字节解码（`TextDecoder('gbk')`）而非按 UTF-8 字符串；只读稳定核心字段（[0..53]），容忍上游字段变体与未知尾部，解析不因尾字段变化而崩。
- **K 线分页游标**：腾讯单请求上限 640 根，且对区间查询返回「最新 640 根」。`day` 周期因此**向后翻页**（每页最旧一根的前一日作为下一页终点），最后反转成最旧在前；`week` / `month` 640 根 ≈ 12 / 53 年，单请求覆盖；总返回量硬上限 2000 根。
- **美股历史自动补交易所后缀**：腾讯美股历史要求 `usAAPL.OQ` 之类带后缀的代码，插件先从实时报价解析出权威代码再喂给 K 线接口，用户只传裸代码 `AAPL`。
- **限流防封（三层，下探到每个 HTTP 请求）**：进程内 TTL 缓存（报价 5s / K 线 5min）去重；同 key 并发合并为一次在途请求（single-flight）；全局限速器保证任意两次 HTTP 请求——含日线分页的每一页、重试的每次尝试——间隔 ≥500ms（≤2 QPS），并发调用排队到未来时隙、逐个放行——从源头避免「短时间大量请求」触发上游封禁 / IP 封锁。配合 K 线单请求 640 根、总量 2000 根的上限，单次查询的请求数也有硬边界。时钟与睡眠可注入，单测可确定性驱动时间。
- **安全重试策略（单请求粒度）**：每次尝试带 `AbortController` 超时（挂死请求快速失败）并接入工具调用的取消信号；只重试临时错误（HTTP 5xx、网络失败、超时），4xx（含 429「停」信号）绝不重试；指数退避 + 全抖动（1s→2s→4s）+ 最多 3 次；分页查询只重试失败的那一页、不重跑整段；每次重试先经全局限速器排队，绝不插队、不放大 QPS。
- **并发上限（信号量）**：除时间间隔限速外，另设 `maxConcurrency`（默认 3）在途请求上限，极端并发下内存与上游负载也有硬边界，每次请求用后释放。
- **大区间发出前确认**：检测到 `day` 区间会分页（`count > 640`）时，经可选 `ctx.userQuestions` 询问用户；无 provider / 非 live root 时静默放行，不阻塞。
- **无 UI 定制**：不写 `presentCall` / `presentResult`，复用 DSH 通用工具卡片，减少前端耦合。

## 工具

| 工具 | 参数 | 说明 |
|---|---|---|
| `market_quote` | `symbol`、`market`（cn/hk/us） | 最新价、昨收、今开、最高、最低、涨跌额、涨跌幅、成交量、报价时间、是否延迟 |
| `market_kline` | `symbol`、`market`、`period`（day/week/month）、`start`/`end`、`count` | 历史日 / 周 / 月 K 线（开/收/高/低/量，最旧在前）；不带区间返回最近 N 根，`start=end` 查单日 |

- `market`：`cn` = A股、`hk` = 港股、`us` = 美股。
- `symbol` 用裸代码：A股 `600000` / `000001`、港股 `00700`、美股 `AAPL`。
- `day` 超 640 根自动分页；总返回上限 2000 根。

**使用示例**（Web GUI 实测）：

![market_quote 实时报价示例](https://raw.githubusercontent.com/weopenfire-git/dsh-market-quote/main/docs/screenshots/1.png)

![market_kline 历史K线示例](https://raw.githubusercontent.com/weopenfire-git/dsh-market-quote/main/docs/screenshots/2.png)

## 安装

### `dsh plugin add`（推荐）

```sh
dsh plugin add dsh-market-quote                        # npm
dsh plugin add github:weopenfire-git/dsh-market-quote  # GitHub
```

### 预设挂载（本地 / 源码开发）

复制一份 `standard` 预设，在 `agent.cordis.yml` 末尾加一行（源码经 tsx 直接加载；或先 `pnpm run build` 后指向 `lib/index.js`）：

```yaml
- id: dsh-market-quote
  name: 'file:///D:/path/to/dsh-market-quote/src/index.ts'
```

新建会话选该预设，即可看到两个工具。

### Web GUI：新建会话选「行情模式」

Web 界面新建会话时，从预设下拉选择「行情模式」（前面四个是官方内置模式）即可加载本插件：

![选择行情模式](https://raw.githubusercontent.com/weopenfire-git/dsh-market-quote/main/docs/screenshots/0-mode-dropdown.png)

## 配置

八个 tunable（`maxRetries` 为次数、非负；`maxConcurrency`、`cacheMaxSize` 为正整数；其余为毫秒、正整数），经插件 `config` 覆盖：

| 键 | 默认 | 说明 |
|---|---|---|
| `quoteTtlMs` | 5000 | 实时报价缓存 TTL |
| `klineTtlMs` | 300000 | K 线缓存 TTL（5 分钟） |
| `minRequestIntervalMs` | 500 | 请求最小间隔（≤2 QPS） |
| `maxRetries` | 3 | 单请求最大重试次数（0 关闭重试） |
| `retryBaseMs` | 1000 | 退避基数（1s → 2s → 4s，全抖动） |
| `requestTimeoutMs` | 5000 | 单次尝试的 fetch 超时 |
| `maxConcurrency` | 3 | 并发在途请求上限 |
| `cacheMaxSize` | 1000 | 缓存条目上限（最旧淘汰） |

非法值（`maxRetries` 为负、`maxConcurrency`/`cacheMaxSize` 非正、其余非正整数）在插件激活时抛错。注意：`requestTimeoutMs` 应小于工具 `timeoutMs`（30s），否则工具超时会先触发。

## 使用建议（推荐区间与点数）

腾讯接口单请求上限 640 根、请求间隔 ≥500ms；超大 `day` 区间会分页（最多 2000 根 ≈ 4 页），等待变长、请求变多、更易触发限流。插件会在会话启动时（systemPrompt）注入同样的建议：

| 需求 | 推荐用法 | 请求数 |
|---|---|---|
| 最新价 | `market_quote` | 1 次 |
| 短期走势（≤约 2.5 年） | `market_kline` `period=day`、`count ≤ 640` | 1 次 |
| 长期走势（跨年） | `market_kline` `period=week`（单请求约 12 年）或 `period=month`（约 53 年） | 1 次 |

- 避免一次性请求超大 `day` 区间（>640 根）：会分页、等待变长、请求数变多。
- 需要多年日线时，宁可分多次小区间查询，也不要一次拉满 2000 根。
- 超大 `day` 区间（`count > 640`）会在发出前弹确认，取消后可改用 `week` / `month`。

## 数据源

- 实时：`GET https://qt.gtimg.cn/q=sh600000,hk00700,usAAPL`（GBK，`~` 分隔）。
- 历史：`GET https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=<code>,day,,,<count>,qfq`（JSON）。

边界：A股单请求 640 行；美股历史须带交易所后缀（插件自动处理）；港股 / 美股无复权；美股延迟行情。数据源为腾讯公开接口，非官方授权，生产环境建议评估付费行情源（见[已知限制](#已知限制)）。

## 开发与测试

```sh
pnpm install
pnpm run typecheck && pnpm run test && pnpm run build   # test OK then push
npm pack --dry-run    # 发布前检查包内容
```

另有免 vitest 的运行时校验 `node validate.mjs`（26 项断言）与真实加载冒烟 `node --import tsx/esm smoke.mjs`。

## 目录

```
dsh-market-quote/
├── src/                 # index.ts / tencent.ts / cache.ts / service.ts
├── tests/               # vitest 用例
├── preset/              # 示例 preset 片段
├── docs/                # design.md（设计记录）/ USAGE.md（使用说明）/ screenshots/（本机截图，未提交）
├── validate.mjs         # 免 vitest 运行时校验
├── smoke.mjs            # 真实工具注册表冒烟
├── tsdown.config.ts
├── tsconfig.json
├── vitest.config.ts
├── package.json
├── CHANGELOG.md
├── LICENSE
└── README.md / README.en.md
```

## 已知限制

- 缓存为进程内内存，重启即失效，多实例 / 多进程不共享。
- 未做复权选择（A股默认不复权；港股 / 美股无复权）。
- 数据源为腾讯公开接口（非官方授权），合规 / 分发自行评估；生产建议付费行情源。
- 重试只覆盖临时错误（5xx / 网络 / 超时）；遇到 429 直接失败（尊重上游「停」信号），不解析 `Retry-After` 头做自适应退避。

## 发布

1. GitHub 仓库加 `dsh-plugin` topic（可选 `deepseek-harness`），被[官方 topic 页](https://github.com/topics/dsh-plugin)收录。
2. npm + GitHub 双发布，版本一致（tag `vX.Y.Z` ↔ npm `X.Y.Z`）。
3. `pnpm publish`（`prepare` 自动 build；需 2FA）。scoped 包需先建 npm org。
4. 稳定后向 [awesome-deepseek-harness](https://github.com/0xsline/awesome-deepseek-harness) 提 PR。

## License

[MIT](./LICENSE)
