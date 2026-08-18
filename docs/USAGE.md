# 使用说明（dsh-market-quote）

本插件给 DeepSeek Harness 的 AI Agent 提供两个只读行情工具：`market_quote`（实时报价）与 `market_kline`（历史 K 线），覆盖 **A股 / 港股 / 美股**。本文含安装、工具用法、真实查询示例、界面截图与配置说明。

## 1. 主要用途

**让 AI Agent 在对话里直接查行情、做简单分析**，不需要人开行情软件、也不需要写代码。**无需额外 API**：数据来自腾讯公开行情接口（免费、免 key、免注册）。**专为机器使用**：只返回结构化 OHLCV 数据，不附带冗余的图形界面。典型用法：

- 「茅台现在多少钱？」→ `market_quote 600519`
- 「中国移动港股近一年走势如何？」→ `market_kline 00941`（`period=week`）
- 「苹果过去 5 年的最高最低价？」→ `market_kline AAPL`（`period=month`，取区间内 high/low 极值）

定位：**给 Agent 用的行情工具插件**——不是给人看盘的终端、不是数据分析库、不是要 key 的数据 API（对比详见仓库讨论）。

## 2. 安装

### 2.1 一键安装（发布后）

```sh
dsh plugin add dsh-market-quote                        # npm
dsh plugin add github:weopenfire-git/dsh-market-quote  # GitHub
```

### 2.2 预设挂载（本地 / 源码）

复制一份 `standard` 预设，在 `agent.cordis.yml` 末尾追加一行（源码经 tsx 加载；或先 `pnpm run build` 后指向 `lib/index.js`）：

```yaml
- id: dsh-market-quote
  name: 'file:///D:/path/to/dsh-market-quote/src/index.ts'
```

**新建会话记得选模式**：建新会话时，从预设下拉选择「行情模式」（前面四个是官方内置模式）。选对模式后新会话才有 `market_quote` / `market_kline`；若用默认模式，Agent 不会有行情工具（实测会退回 web 搜索，见 [§5 截图 03](#5-界面截图)）。

## 3. 工具用法

| 工具 | 参数 | 说明 |
|---|---|---|
| `market_quote` | `symbol`、`market`（cn/hk/us） | 最新价、昨收、今开、最高、最低、涨跌额、涨跌幅、成交量、报价时间、是否延迟 |
| `market_kline` | `symbol`、`market`、`period`（day/week/month）、`start`/`end`、`count` | 历史日/周/月 K 线（开/收/高/低/量，最旧在前）；不带区间返回最近 N 根，`start=end` 查单日 |

- `symbol` 用裸代码：A股 `600000`/`000001`、港股 `00700`、美股 `AAPL`；前缀/后缀自动补齐（A股自动判沪/深，美股历史自动补交易所后缀）。
- `day` 超过 640 根自动向后翻页（每页 640，总上限 2000）；`week`/`month` 单请求覆盖约 12/53 年。
- 两个工具只读、并发安全、30s 超时；超大 `day` 区间（`count > 640`）会先弹确认，避免长时间等待。

## 4. 真实查询示例（本会话实测）

以下都是本插件实际返回的数据（2026-08-17 前后）。

**market_quote（实时报价）**

```
可口可乐 (US) (delayed): 87.11 (-0.68%, -0.6)  open=87.3 high=88.01 low=86.91 prevClose=87.71
贵州茅台 (CN): 1293.09 (-3.64%, -48.9)  open=1295 high=1301 low=1280.34 prevClose=1341.99
腾讯控股 (HK): 446.4 (+1.45%, +6.4)  open=444.8 high=450.4 low=442.6 prevClose=440
苹果 (US) (delayed): 304.27 (-0.54%, -1.66)  open=306.21 high=307.66 low=302.94 prevClose=305.93
```

**market_kline（历史 K 线）**

```
600519 (CN) day: 30 bars (2026-07-07..2026-08-17)
  2026-08-14 1341.99 1359/1338.14 vol=29853
  2026-08-17 1293.09 1301/1280.34 vol=78430

00941 (HK) week 近一年抽样（周K）：2025-08 89.80 → 2026-02 78.50 → 2026-05 86.20 → 2026-08-17 82.40；区间约 76.10~89.95
AAPL (US) month: 30 bars (2024-03-28..2026-08-17)，2026-08-17 收 304.29
```

**解读示例（Agent 可基于结构化 OHLCV 直接算）**：中国移动近一年在 76~90 港币箱体震荡，78 附近多次获得支撑，当前 82.4 处于区间中下部。

## 5. 界面截图

以下为 Web GUI 实测截图，保存在**本机** `docs/screenshots/`（含本机会话标题等个人数据，**未随仓库提交**；如需公开发布请自行替换为干净截图）：

| 截图（本机路径） | 说明 |
|---|---|
| `docs/screenshots/00-landing.png` | GUI 首页：会话列表（含「查询美股行情示例」） |
| `docs/screenshots/01-new-session.png` | 新建会话 |
| `docs/screenshots/10-mode-dropdown.png` | **关键**：新建会话时从预设下拉选择「行情模式」（前面四个是官方内置模式） |
| `docs/screenshots/20-market-mode-selected.png` | 已选「行情模式」 |
| `docs/screenshots/02-typed.png` | 输入问题「查一下A股贵州茅台（600519）的最新价」 |
| `docs/screenshots/21-market-tool-result.png` | **market_quote 生效**：贵州茅台 600519 最新价 1297.99（+0.38%），含今开/最高/最低/昨收 |
| `docs/screenshots/22-kline-result.png` | **market_kline 生效**：中国移动 00941 周K；模型注意到渲染只显示末 3 根后自动带日期区间重查 |
| `docs/screenshots/03-result.png` | 反面示例：新建会话**未选行情模式**（默认模式），Agent 退回 web 搜索而非 `market_quote` |
| `docs/screenshots/10-market-session.png` | 本会话（含真实行情工具调用与结果） |
| `docs/screenshots/11-market-session-top.png` | 同上，滚动查看上部工具行 |

## 6. 配置

八个 tunable，经插件 `config` 覆盖（`maxRetries` 非负，`maxConcurrency`/`cacheMaxSize` 正整数，其余毫秒正整数）：

| 键 | 默认 | 说明 |
|---|---|---|
| `quoteTtlMs` | 5000 | 实时报价缓存 TTL |
| `klineTtlMs` | 300000 | K 线缓存 TTL（5 分钟） |
| `minRequestIntervalMs` | 500 | 请求最小间隔（≤2 QPS） |
| `maxRetries` | 3 | 单请求最大重试次数（0 关闭） |
| `retryBaseMs` | 1000 | 退避基数（1s→2s→4s，全抖动） |
| `requestTimeoutMs` | 5000 | 单次尝试 fetch 超时（须 < 工具 30s 超时） |
| `maxConcurrency` | 3 | 并发在途请求上限 |
| `cacheMaxSize` | 1000 | 缓存条目上限（最旧淘汰） |

## 7. 实测记录

- **2026-08-17 实测**：A股 600519 / 港股 00700、00941 / 美股 AAPL、KO 的实时与日/周/月 K 线全部正常；`day` 大区间向后翻页实测返回完整区间（如 2020-01-01..2026-08-17 共 1605 根，而非旧逻辑的 640 根）。
- **防封链路实测**：限流 ≤2 QPS、逐请求重试、取消信号、超大区间确认均生效；`429` 不重试、4xx 不重试。
- **GUI 端到端（无头 Chrome 实测）**：新建会话 → 预设下拉选「行情模式」→ 问「茅台最新价」→ Agent 调用 `market_quote`（返回 1297.99 +0.38%）；问「中国移动近一年周K」→ 调用 `market_kline`。选默认模式（未选行情模式）时 Agent 会退回 web 搜索（见 §5）。
- **模式选择（重要）**：新建会话需在预设下拉选择「行情模式」才有行情工具（见 §2.2 与截图 `10-mode-dropdown.png`）；选默认模式时 Agent 会退回 web 搜索。

## 8. 已知限制

- 数据源为腾讯公开接口（非官方授权），无盘口/逐笔/财务/基本面；美股为延迟行情。
- A股默认不复权（无复权选择）；港股/美股无复权。
- 缓存为进程内内存，重启失效，多进程不共享。
- 只读行情，无交易/下单能力。
