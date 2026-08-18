# 设计记录与 Bug 排查

本文记录 `dsh-market-quote` 的防封架构、关键实现决策，以及历次 bug 排查的结论。面向维护者。

## 1. 防封架构（四层）

腾讯公开接口无 key、无 Referer，但请求过密会触发封禁 / IP 封锁。插件用四层机制从源头规避：

1. **限流（时间间隔）**：`RateLimiter` 保证任意两次 HTTP 请求间隔 ≥500ms（≤2 QPS），并发调用排队到未来时隙、逐个放行。
2. **并发上限**：`Semaphore`（`maxConcurrency`，默认 3）限制在途请求数，极端并发下内存与上游负载也有硬边界。
3. **单飞 + 缓存**：同 key 并发合并为一次在途请求；报价 5s / K 线 5min TTL 缓存减少重复请求；`cacheMaxSize`（默认 1000）条目上限、最旧淘汰，防长进程内存无界增长。
4. **安全重试**：仅对临时错误（5xx / 网络失败 / 超时）重试，4xx（含 429「停」信号）绝不重试；指数退避 + 全抖动（1s→2s→4s）+ 最多 3 次。

**重试粒度**：重试按「单次 HTTP 请求」粒度，而非整个操作。分页查询中某一页失败只重试该页，不重跑整段分页，避免请求数被重试放大。

**取消信号**：每个请求接入工具调用的 `exec.signal`（`AbortSignal.any` 组合到每尝试超时信号），取消 / 工具超时会真正中断 in-flight 请求，且已取消的请求不再重试。

## 2. 关键实现决策

- **单数据源 + 字节级解码**：`qt.gtimg.cn` 返回 GBK、`~` 分隔字段串，按字节解码（`TextDecoder('gbk')`），只读稳定核心字段 [0..53]，容忍尾部变化。
- **K 线向后翻页**：腾讯对区间查询返回「最新 640 根」（实测确认）。`day` 区间因此**向后翻页**——每页最旧一根的前一日作下一页终点，最后反转成最旧在前。
- **美股历史自动补后缀**：先从实时报价解析权威代码（如 `AAPL.OQ`），再喂给 K 线接口。
- **门控顺序**：先取并发槽、再取时间槽，保证请求间隔从「实际发出时刻」起算。
- **网络错误归一化**：`fetchWithTimeout` 把 fetch 的网络失败统一包成 `NetworkError`，`isTransientError` 不再把一切 `TypeError`（含代码 bug）当瞬时重试。
- **交换时区「今天」**：`end` 缺省用交易所本地日期（CN/HK UTC+8 精确；US 近似 UTC-5、忽略 DST）。
- **缓存上限**：`cacheMaxSize`（默认 1000）最旧淘汰，防无界增长。
- **超大区间发出前确认**：`day` 区间 `count > 640`（会分页）时经可选 `ctx.userQuestions` 询问用户；无 provider / 非 live root 时静默放行（fail-open）。
- **可选服务软集成**：`userQuestions` 用 `ctx.get()` + 最小结构类型，不引入硬依赖（遵循 dsh-plugin-skeleton §3）。
- **Transport 打包**：`requestTimeoutMs / maxRetries / retryBaseMs / acquire / signal` 打包为 `Transport`，统一每个请求的传输参数。

## 3. Bug 排查记录

### 已修复

| 版本 | 问题 | 影响 | 修复 |
|---|---|---|---|
| 0.4.1 | `day` 大区间分页方向错误 | 静默只返回最新 640 根，旧数据全丢 | 改为向后翻页（实测 1605 根 vs 修复前 640） |
| 0.4.1 | 限速门控顺序（先限速后并发） | 被并发排队延迟的请求与实际请求间距 <500ms | 先并发槽、后时间槽 |
| 0.4.1 | 解析正则 `\w+` 不匹配带点代码 | `BRK.B` 等美股解析失败 | 改为 `[\w.]+` |
| 0.5.0 | 重试按「整个操作」粒度 | 分页某页失败会重跑全部页，请求数放大 | 重试下沉到数据层、按单请求粒度 |
| 0.5.0 | 未接入取消信号 | 取消/超时不中断请求；AbortError 被无谓重试 | 接入 `exec.signal` + `AbortSignal.any`，已取消不重试 |
| 0.6.0 | `isTransientError` 把一切 `TypeError` 当瞬时 | 代码 bug 被无谓重试 3 次、被掩盖 | 网络失败归一化为 `NetworkError`，不再按 `TypeError` 判瞬时 |
| 0.6.0 | `high/low` 用 `\|\|` 回退 | 停牌股 high=0 被误回退到别的字段 | 改为 `priceField`：仅主字段为空才回退 |
| 0.6.0 | `week/month` >12/53 年静默截断 | 旧数据静默丢失 | 所有周期统一向后翻页 |
| 0.6.0 | `end` 缺省用 UTC「今天」 | 北京时间凌晨差一天 | 改用交易所本地「今天」 |
| 0.6.0 | 缓存无上限 | 长进程内存无界增长 | `cacheMaxSize`（默认 1000）最旧淘汰 |

### 剩余近似（可接受，非 bug）

- US `end` 缺省的「今天」用 UTC-5 近似（忽略夏令时），US 当地时间午夜前后可能差 1 小时、极端情况差 1 天。
- 美股历史依赖实时报价 `f[2]` 提供交易所后缀（实测 AAPL/KO/BRK.B 均带后缀）；解析不到时现在 fail-loud 报错，不会静默出错。

## 4. 发布记录

- **2026-08-18**：npm `dsh-market-quote@0.6.1`（`latest`）发布成功，维护者 `yinging`；GitHub tag `v0.6.1` 与 npm 版本一致（双发布完成）。
- npm 包内容（`files` 白名单）：`lib/index.js` + `lib/types/**/*.d.ts` + README（中英）+ LICENSE + CHANGELOG；`docs/` 与 `src/` 不进包。
- README 中三张截图用 **GitHub raw 绝对链接**（`docs/screenshots/` 已提交仓库；`docs/` 不进 npm 包，相对路径在 npm 页面会裂图——0.6.1 修复）。
- 依赖形态：`peerDependencies`（cordis / dsh-system-prompt / dsh-tools），无运行时 `dependencies`（腾讯公开接口免 key，无第三方运行时依赖）。
- 后续：可向 [awesome-deepseek-harness](https://github.com/0xsline/awesome-deepseek-harness)（Domain & Specialist Skills 分类）提 PR 收录。
