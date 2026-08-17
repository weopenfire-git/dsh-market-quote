# Changelog

本项目的所有显著变更都会记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

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
