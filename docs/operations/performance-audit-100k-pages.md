# AutoForge 10 万级数据全页面性能验收报告

- 日期：2026-09-06（Asia/Shanghai）
- 代码：`origin/main` @ `0d62110`（fix: preserve refreshed dialogs and stabilize release acceptance），部署前已 `git pull` 至最新
- 模式：Lite（SQLite + 本地对象存储），独立实例端口 **3400**，数据目录 `/opt/auto-forge/.perf-data`（验收后已清理）
- 宿主机：4 vCPU / 7.1GB RAM / 同盘 SQLite（2.49GB 主库 + 54MB WAL）
- 浏览器：Playwright Chromium（headless，`chromium-1234`），主视口 1536×1024
- 被测页面：**46 个路由变体，覆盖 `apps/web/src/app` 下全部 33 个 `page.tsx`**（含匿名页、分享页、设置页、1024px 以下不验收的桌面约束内的两种桌面视口中的主视口）

---

## 1. 结论摘要

**在 10 万级用例 / 34.8 万执行记录 / 108 万状态事件的数据规模下，没有页面出现“永久卡死”（渲染进程无响应或崩溃后无法恢复），但有 1 个页面存在用户可明确感知的明显卡顿，1 个页面存在轻微卡顿 + 极高的内存/流量压力，另有 3 个页面承载了不可持续的客户端载荷（数十 MB 级快照下载 + 100~200MB JS 堆）。**

| 判定 | 页面数 | 页面 |
| --- | ---: | --- |
| 卡死（渲染进程崩溃/无响应） | 0 | —（但在**未做内存隔离**的首轮运行中，`/case-suites/{100k}` 曾导致整个浏览器进程死亡，见 §4.3） |
| **明显卡顿** | **1** | **用例管理·关键字筛选 `/cases?...&query=Perf`**：51,613 个 DOM 节点、冷/热加载主线程最长阻塞 **1,958ms / 1,933ms**、长任务累计 4,971ms、客户端快照 58.5MB |
| 轻微卡顿 | 1 | 用例管理（全量目录）`/cases`：客户端快照 **114MB**、JS 堆 **200MB**、长任务累计 1,999ms |
| 可感知延迟（200~500ms 级阻塞，可用但不丝滑） | 27 | 见 §5 全量表 |
| 流畅 | 17 | 登录、初始化、首页、用例导入、用例详情、来源详情、任务列表、批次列表、多数执行详情、分析、对象、设置、账号、无权限页等 |

**服务端另有 3 个与页面冻结直接相关或潜在相关的问题**（§6）：

1. `GET /api/v1/run-batches/{100k批次}` 返回 **143.7MB** JSON、耗时 8~9s（无界响应，违反 AGENTS.md §9 分页约束；当前 UI 未调用，属 API 契约风险）。
2. `GET /api/v1/case-suites/{100k任务}` 返回 **149.9MB** JSON、耗时 7~8s（同上）。
3. **`GET /api/v1/run-batches/{id}/scheduling-events` 耗时 5~6s 却只返回 305B**——根因已定位：应用层 `listSchedulingEvents()` 先 `await this.get(batchId)` 加载整批 10 万 run 的完整详情（即上面 143.7MB 的对象）做存在性校验后丢弃，再执行一条 2ms 的索引查询。**该接口被执行详情页“调度日志”面板直接调用**，是真实用户路径上的服务端卡顿。

---

## 2. 数据集规模（SQLite 实测计数）

| 实体 | 行数 | 说明 |
| --- | ---: | --- |
| `case_definitions` | 100,800 | 10 万级用例 |
| `case_versions` | 114,300 | 不可变版本快照 |
| `test_methods` | 165,591 | |
| `case_sources` | 12 | 含 40,000 / 30,000 / 12,000 / 6,000 类的 JAR 来源 |
| `case_suites` | 421 | 其中 MEGA 任务 = **100,000 成员 + 5,000 DDT** |
| `case_suite_items` | 178,045 | |
| `case_suite_schedules` | 84 | |
| `run_batches` | 1,409 | 含 100k 失败三轮、20k 进行中、12k 轮次重试、6k 已取消、3k DDT |
| `execution_runs` | 348,139 | MEGA 批次 100,000 run；LIVE 批次 20,000 run |
| `run_attempts` | 362,793 | |
| `attempt_state_events` | 1,082,357 | 108 万状态事件 |
| `scheduling_events` | 1,838 | |
| `analytics_facts` | 357,633 | |
| `attempt_artifacts` / 对象文件 | 8,046 / 8,058 | |
| `failure_analysis_claims` | 10,779 | MEGA 批次 2,150 认领 |
| `audit_events` | 140,003 | |
| `notifications` / `webhook_deliveries` | 25,017 / 2,373 | |
| `users` / `runners` | 321 / 260 | LIVE 批次 2,860 条 assignment + lease |
| `read_model_snapshots` / parts | 37 / 897 | 读模型快照与分片 |
| 每批次日志库 | 268 个 SQLite | 209,085 日志块 |

数据由 `.local/perf-audit/seed-01..07.mjs` 幂等生成（3,013,382 行，主库 2.49GB）。

---

## 3. 方法

1. **HTTP 层分诊**（`probe-http.mjs`，3 次/路由）：测量全部页面文档与关键 API 的 TTFB/总时长/字节数，区分冷（读模型未建）与热（读模型已建）。
2. **浏览器层冻结审计**（`probe-browser.mjs`，本次验收的权威依据）：每个路由独立 Chromium 上下文 + 独立浏览器进程（崩溃隔离），`addInitScript` 注入：
   - 16ms 心跳计时器测**主线程最长阻塞**（>60ms 记为一次阻塞）；
   - PerformanceObserver 采集 `longtask`、FCP、LCP、CLS、`resource`（全部 fetch/XHR 的时长与解码字节）；
   - DOM 节点数、`performance.memory` 堆占用（`--enable-precise-memory-info`）；
   - 交互探针：页签切换、折叠展开、搜索输入、筛选下拉、翻页、滚动到底，逐项测阻塞；
   - 冷加载后再同上下文热加载一次，区分“首次读模型构建成本”与“稳态成本”。
3. **判定阈值**（`summarize.mjs`，与原始 JSON 同源计算）：
   - 卡死：渲染进程崩溃/无响应，或单次阻塞 ≥3000ms；
   - 明显卡顿：单次阻塞 ≥1000ms，或长任务累计 ≥3000ms，或 DOM ≥15,000，或堆 ≥400MB，或 load ≥10s；
   - 轻微卡顿：单次阻塞 ≥500ms，或 DOM ≥5,000，或堆 ≥250MB，或 load ≥5s；
   - 可感知延迟：单次阻塞 ≥200ms；其余为流畅。
   - 客户端快照载荷、分片数、409 冲突等作为**风险列**单独报告，不单独决定冻结判定。
4. **服务端 API 复测**：curl 3 次取中位，验证无界接口与慢接口的稳态耗时。
5. **仓库自带性能回归**：`pnpm test:performance`（4 文件通过 / 1 跳过=PostgreSQL，10 用例通过）。

---

## 4. 明显卡顿与高风险页面详析

### 4.1 用例管理·关键字筛选 `/cases?...&query=Perf` —— 明显卡顿（唯一）

| 指标 | 冷 | 热 |
| --- | ---: | ---: |
| load / FCP / LCP | 1342 / 1312 / 2456 ms | 225 ms |
| 主线程最长阻塞 | **1,958 ms** | **1,933 ms** |
| 长任务 次数/累计 | 44 / **4,971 ms** | 3,819 ms |
| DOM 节点 | **51,613** | 51,613 |
| JS 堆 | 126 MB | — |
| 客户端快照载荷 | 58.5 MB（160 分片） | — |
| 交互最差 | 筛选下拉 862ms | — |

**现象**：页面提示“正在载入用例目录 19,000 / 40,000，已载入部分可先查看”，边下载边把**整个项目目录树（4 万用例）一次性展开渲染**，产生 5.1 万 DOM 节点；冷、热两次加载都出现约 2 秒的主线程冻结（展开/筛选时再叠加 0.9~2.3 秒阻塞）。（页面截图已随验收产物清理，现象可由附录 A 指标复现。）

**根因**：`apps/web/src/components/cached-case-directory.tsx` 以 250 条/分片把**整个读模型快照**流式下载到浏览器（`for (let ordinal = 0; ordinal < partCount; ordinal += 4)`），在内存中重建全量目录树后交给工作台渲染；筛选只是在已下载的全量数据上做客户端过滤，因此筛选并不能减少下载与渲染量。

### 4.2 用例管理（全量目录）`/cases` —— 轻微卡顿 + 最高载荷

- 客户端快照 **114.0MB**（312 次分片请求 = 160 个分片 × **2 个 generation**），JS 堆 **200MB**，长任务累计 1,999ms；目录树默认折叠时 DOM 仅 391，交互尚流畅，但**内存与流量压力为全产品最高**。
- 双 generation 下载的原因见 §4.4。

### 4.3 任务详情（100,000 成员）`/case-suites/{megaSuite}` —— 可感知延迟，但曾致浏览器进程死亡

- 隔离运行（每路由独立浏览器 + 每渲染进程 3GB 堆上限）：load 405ms、阻塞 262ms、DOM 2,271（渲染侧有 250 组/100 条分页，“加载更多”按钮），**但客户端快照 72.6MB（800 次分片请求 = 400 分片 × 2 generation）、JS 堆 185MB**。
- **首轮未隔离运行中，该页加载期间整个 Chromium 浏览器进程死亡**（当时宿主可用内存约 1.1GB），后续路由全部报 `Target page, context or browser has been closed`。即：在内存紧张的机器上，该页足以拖垮整个浏览器；在内存充足的机器上表现为数十 MB 下载 + 近 200MB 堆。
- 根因同 §4.1：`cached-suite-directory.tsx` 全量下载 400 个分片（10 万成员）后在内存拼装，再交给 `case-suite-details.tsx` 分页渲染——**渲染分页了，下载没有分页**。

### 4.4 横切问题：读模型 generation 抖动导致整份快照重复下载

- `cases` 与 `suite-100k` 的冷加载都下载了**两个不同 generation** 的全部分片（312/800 次请求），服务端日志同时存在 `GET /api/v1/read-models/{id}/parts → 409`（03:15、03:36 CST）。
- 机制：分片请求遇 409（快照正在重建）时组件调用 `router.refresh()`，服务端以新 generation 重渲染，`useEffect` 依赖变化后**从头重下整份快照**；`suite-3k` / `suite-small` 页面也观察到 4 次 409 console 错误。
- 影响：本已数十 MB 的载荷在最坏情况下 ×2，且用户会看到加载进度回退重来。

### 4.5 慢但不至冻结的页面

- `/share/run/{token}/attempt/{id}` 与 `/share/attempt-log/{token}`：冷 load **2.3~2.4s**（日志块回放），热 2.1s；DOM 很小、无长阻塞，属“慢加载”而非卡顿。
- `/case-analysis/{batch}`（2,150 认领）：冷 load 1,626ms（SSR），交互流畅。

---

## 5. 全量页面结果表（1536×1024，冷/热 + 交互）

完整 46 行指标表固化于附录 A（验收时由浏览器探针原始指标自动生成）。要点摘录：

- 所有页面 SSR 文档 TTFB ≤ 300ms（首页 96ms、审计 43ms、100k 批次详情 27ms），**服务端渲染层不是瓶颈**。
- 27 个“可感知延迟”页面的冷加载主线程阻塞集中在 160~310ms，主要为 React 水合 + 首屏数据请求，属可接受但可优化区间。
- `/insights`、`/runners` 出现 React 水合错误（Minified React error #418 / #441），不影响冻结判定但属正确性缺陷，建议单独修。
- `/progress/{batchId}` 不带 `access_token` 时按设计显示“页面不存在”（需时效令牌）；带令牌后正常（load 165~211ms，DOM 62~64）。
- `/case-sources`（无列表页）返回 404 属**预期**：产品只有 `/case-sources/{id}` 详情页与 `/objects` 列表入口，UI 无指向 `/case-sources` 的链接。

---

## 6. 服务端 API 性能问题（热态，curl ×3 中位）

| 接口 | 热态耗时 | 响应体 | 是否 UI 调用 | 结论 |
| --- | ---: | ---: | --- | --- |
| `GET /api/v1/run-batches/{100k}` | 8.0~9.3s | **143.7MB** | 否（UI 用 `/overview`、`/cases`、`/progress`） | 无界响应，违反 §9；建议废弃或强制分页 |
| `GET /api/v1/case-suites/{100k}` | 7.2~8.6s | **149.9MB** | 否（UI 用 PATCH + 读模型分片） | 同上 |
| `GET /api/v1/case-sources/{40k类}` | 1.3~1.7s | **25.6MB** | 否（页面用 `source_preview` 读模型 + 100 类预览上限） | 同上 |
| `GET /api/v1/run-batches/{100k}/scheduling-events?limit=500&latest=true` | **4.9~6.5s** | **305B** | **是（执行详情“调度日志”面板）** | **真实用户路径上的服务端卡顿**，根因见下 |
| `GET /api/v1/run-batches/{100k}/cases?scope=all&page=1&pageSize=50`（直查 DB） | 2.1~2.3s | 61KB | 兜底路径 | 偏慢 |
| `GET /api/v1/run-batches/{100k}/cases?cached=1&...`（读模型） | 0.11~0.23s | 61KB | **是（主路径）** | 良好 |
| `GET /api/v1/failure-analysis/statistics` | 6~12ms | 15KB | 是 | 良好（冷态曾 3.6s，为读模型首建） |
| `GET /api/v1/analytics` | 10~79ms | 39KB | 是 | 良好（冷态 503 READ_MODEL_PENDING 5.7s 后自愈） |
| `GET /api/v1/run-batches?limit=50` | 11~18ms | 70KB | 是 | 良好（冷态 503 10s 后自愈） |
| `GET /api/v1/case-definitions?limit=50` | 164~928ms | 69KB | 是 | 可接受 |

**`scheduling-events` 根因（已定位到代码）**：`packages/application/src/schedule-run-batches.ts:888-900`

```ts
async listSchedulingEvents(batchId, input) {
  await this.get(batchId);          // ← 加载整批 RunBatchDetails（10 万 run，143.7MB）
  return this.batches.listSchedulingEvents({ batchId, ...input });  // ← 实际查询仅 2ms（有 batch_id 索引）
}
```

`this.get()` 仅为存在性/权限校验却物化整批详情。SQLite 直测该 SQL 为 **0.002s**（`scheduling_events_batch_idx` 命中），证明 5~6s 全部消耗在 `get()`。同文件 `:898` 的 `getSummary()`/`getMetadata()` 才是应有的轻量校验。

**冷态 503 READ_MODEL_PENDING**：`/run-batches?limit=50`、`/analytics` 首次访问返回 503（后台快照未建），10s 内自愈为 200。属设计内的“读模型预热”，但首用户体验为一次失败请求，建议在 UI 上以骨架屏/重试提示表达。

---

## 7. 仓库自带性能回归基线（`pnpm test:performance`，本次实跑）

```
jar-discovery            246ms   2,000 类 / 10,000 方法
scheduler                626ms   100,000 run 调度窗口
sqlite-run-batch       10,138ms  100,000 run 写入
sqlite-run-batch-detail   879ms  100,000 run 批次详情（返回 50 行）
sqlite-terminate-100k   1,480ms
sqlite-500-concurrency    178ms  500 assignment / 25 runner
sqlite-case-suite       6,811ms  100,000 成员任务
sqlite-queue            5,847ms  10,000 积压 / 8 竞争 worker / 100 回收周期
sqlite-logs             4,572ms  20,000 日志块 / 43.5MB
read-model(sqlite)      2,294ms 建 100k 目录快照(400 分片)；100 次重复读 44ms
suite+casePage          2,780ms / 501ms；100 次热读 262ms
failure-analysis-*      181~324ms（10 万 run 各排序/搜索/认领页）
run-batch-export       10,155ms  50,000 行 xlsx（5.8MB）
结果：4 文件通过 / 1 跳过（PostgreSQL），10 用例通过 / 2 跳过
```

服务端仓储层在 10 万级下总体健康；**瓶颈集中在“把整份快照/整批详情物化”的两类调用**（读模型全量分片下发、`listSchedulingEvents` 的 `get()`）。

---

## 8. 限制与说明

- 单机 4C/7G Lite 模式；Full 模式（PG/NATS/MinIO/Redis）未在本次执行（docker 编排存在但未起）。
- 浏览器探针为 headless Chromium，无 GPU 合成差异；心跳法测阻塞存在 ±16ms 粒度误差。
- 隔离运行对每个渲染进程加了 `--js-flags=--max-old-space-size=3072` 保护宿主；首轮无保护运行中 `/case-suites/{100k}` 曾致浏览器进程死亡，两种证据均已记录。
- `resource` 日志上限首轮为 400 条，导致首轮 `cases`/`suite-100k` 载荷被低估（58MB/33MB）；复跑已提至 4,000 条，本报告采用复跑值（114MB/72.6MB）。
- 冷/热定义：冷=新上下文首次访问（读模型可能首建）；热=同上下文二次访问。

---

## 9. 建议（按优先级）

1. **P0 `listSchedulingEvents` 去掉 `await this.get(batchId)`**，改用 `getMetadata()`/`getSummary()` 校验；为“调度日志”面板消除 5~6s 服务端等待（一行级修复，收益最大）。
2. **P0 读模型快照改为服务端分页/窗口下发**：`cached-case-directory` / `cached-suite-directory` 目前“渲染分页、下载不分页”。建议目录树按展开层级懒加载分片，或提供 `offset/limit` 的窗口读模型；目标：首屏客户端载荷 < 2MB。
3. **P1 抑制 generation 抖动下的全量重下**：409 时保留已下载分片做增量续传，或仅在 generation 真正影响已读窗口时 refresh；避免 ×2 载荷与进度回退。
4. **P1 用例目录树虚拟滚动**：筛选态 5.1 万 DOM 节点是 2 秒冻结的直接原因；按可见窗口渲染可把 DOM 降回千级。
5. **P2 废弃/收敛无界 GET**：`run-batches/{id}`、`case-suites/{id}`、`case-sources/{id}` 三个百 MB 级接口与 AGENTS.md §9“限制 page size”冲突；即便 UI 未调用，也应改为 metadata + 分页子资源。
6. **P2 修复 `/insights`、`/runners` 的 React 水合错误（#418/#441）**；为读模型 503 预热期提供骨架屏语义。
7. **P3 分享日志页（2.3s）日志块回放做窗口化加载**。

---

## 10. 验收产物与复现说明

- 验收原始产物（浏览器指标 JSON、探针与种子脚本、页面截图、探针日志、2.8GB 种子数据目录）
  已在验收结论确认后按仓库整洁要求清理；**本文与附录 A 为唯一保留记录**。
- 复现路径：按 §3 方法重建浏览器探针（Playwright Chromium，`addInitScript` 注入主线程心跳、
  `longtask`/`paint`/`layout-shift`/`resource` 观察器），对 Lite 实例逐路由做冷/热两轮采集与交互探针；
  服务端指标以 curl 三次取中位复测；仓储层基线直接运行仓库既有门禁 `pnpm test:performance`。
- 种子数据可按 §2 的表与规模约束重建；关键目标实体为 100,000 成员任务、100,000 run 批次、
  20,000 run 进行中批次与 40,000 用例的默认项目目录。
- 本文只记录已实测的证据与已定位的代码根因；所有耗时数字均标注冷/热与测量层级，
  未复现的现象（如 Full 模式）在 §8 中明确声明未覆盖。

---

## 附录 A：全量页面指标表（1536×1024，冷/热 + 交互）

| 页面 | 路由 | 冷 load | 冷 FCP | 冷主线程阻塞 | 冷长任务 | 冷 DOM | 冷堆 | 客户端载荷 | 热 load | 热阻塞 | 交互数 | 交互最差 | 判定 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
登录页 | `/login` | 367 | 740 | 187ms | 4/442ms | 46 | 8.1MB | 0.0MB | 115 | 126ms | 0 | - | 流畅
初始化引导页 | `/setup` | 123 | 156 | 165ms | 1/151ms | 46 | 35.8MB | 0.0MB | 84 | 167ms | 0 | - | 流畅
工作概览（首页 Bento） | `/` | 360 | 344 | 193ms | 3/288ms | 801 | 13.3MB | 0.2MB | 286 | 171ms | 5 | 0ms | 流畅
用例管理（10 万用例目录） | `/cases?projectId=00000000-0000-7000-8000-00000…` | 424 | 524 | 298ms | 24/1999ms | 391 | 200MB | 114.0MB | 520 | 156ms | 5 | 179ms | 轻微卡顿
用例管理（关键字筛选） | `/cases?projectId=00000000-0000-7000-8000-00000…` | 1342 | 1312 | 1958ms | 44/4971ms | 51613 | 126MB | 58.5MB | 225 | 1933ms | 5 | 862ms | 明显卡顿
DDT 数据驱动管理 | `/cases?tab=ddt&projectId=00000000-0000-7000-80…` | 429 | 764 | 248ms | 3/438ms | 408 | 9.9MB | 0.2MB | 172 | 156ms | 9 | 101ms | 可感知延迟
用例导入（JAR） | `/cases/import` | 316 | 604 | 191ms | 2/283ms | 301 | 9.3MB | 0.1MB | 163 | 131ms | 5 | 60ms | 流畅
用例详情（3 个版本） | `/cases/019f3f74-1500-7000-8000-000000000200` | 582 | 564 | 188ms | 3/339ms | 647 | 10.2MB | 0.1MB | 590 | 216ms | 5 | 73ms | 可感知延迟
用例详情（已归档） | `/cases/019f3f74-1536-7000-8000-00000000c600` | 536 | 520 | 180ms | 3/318ms | 551 | 9.7MB | 0.1MB | 566 | 134ms | 5 | 65ms | 流畅
文件来源详情（40,000 类） | `/case-sources/019f3f74-1500-7000-8000-00000000…` | 264 | 244 | 198ms | 2/251ms | 346 | 11.3MB | 0.2MB | 470 | 176ms | 5 | 0ms | 流畅
文件来源详情（6,000 类） | `/case-sources/019f6dcd-5100-7000-8000-0000048e…` | 224 | 204 | 229ms | 1/210ms | 332 | 11.5MB | 0.2MB | 162 | 160ms | 5 | 71ms | 可感知延迟
任务列表（421 个任务） | `/case-suites` | 278 | 260 | 193ms | 2/231ms | 1798 | 14MB | 0.2MB | 244 | 172ms | 5 | 0ms | 流畅
任务详情（100,000 成员 + 5,000 DDT） | `/case-suites/019f8cb3-7900-7000-8000-000000000…` | 405 | 576 | 262ms | 7/918ms | 2271 | 185.1MB | 72.6MB | 442 | 235ms | 5 | 222ms | 可感知延迟
任务详情（3,000 成员） | `/case-suites/019eed0e-5500-7000-8000-0000019bc…` | 384 | 732 | 256ms | 4/418ms | 1874 | 15.4MB | 2.2MB | 301 | 233ms | 5 | 0ms | 可感知延迟
任务详情（小任务） | `/case-suites/019f25b4-4900-7000-8000-000001ad5…` | 513 | 868 | 256ms | 4/457ms | 1875 | 14MB | 1.5MB | 356 | 252ms | 5 | 0ms | 可感知延迟
执行记录（34.8 万 run） | `/execution-records` | 384 | 696 | 214ms | 3/308ms | 2449 | 11.3MB | 0.1MB | 278 | 185ms | 5 | 61ms | 可感知延迟
执行批次列表（1,409 批次） | `/run-batches` | 351 | 312 | 198ms | 3/296ms | 2449 | 42.5MB | 0.1MB | 258 | 152ms | 5 | 0ms | 流畅
执行详情（100,000 run / 3 轮） | `/run-batches/01a06edd-6c00-7000-8000-000000000…` | 350 | 660 | 219ms | 3/351ms | 2055 | 10.6MB | 0.1MB | 355 | 249ms | 6 | 88ms | 可感知延迟
执行详情（进行中 20,000 run） | `/run-batches/01a0744d-0600-7000-8000-000008b4a…` | 293 | 576 | 206ms | 2/263ms | 1806 | 13MB | 0.2MB | 301 | 194ms | 6 | 99ms | 可感知延迟
执行详情（轮次重试 12,000 run） | `/run-batches/01a06edd-6c00-7000-8000-000000000…` | 324 | 672 | 215ms | 2/281ms | 2055 | 10.8MB | 0.1MB | 283 | 196ms | 6 | 139ms | 可感知延迟
执行详情（已取消 6,000 run） | `/run-batches/01a064fe-9100-7000-8000-00000a60a…` | 325 | 632 | 181ms | 2/284ms | 1994 | 11.6MB | 0.1MB | 213 | 162ms | 6 | 114ms | 流畅
执行详情（DDT 3,000 run） | `/run-batches/01a06a24-ed00-7000-8000-00000c963…` | 309 | 612 | 197ms | 2/266ms | 2016 | 10.6MB | 0.1MB | 226 | 149ms | 6 | 0ms | 流畅
执行详情（34 run） | `/run-batches/01a06e38-a080-7000-8000-000012994…` | 376 | 672 | 231ms | 4/467ms | 260 | 9.6MB | 0.1MB | 171 | 207ms | 5 | 62ms | 可感知延迟
公开进度页（100,000 run） | `/progress/01a06edd-6c00-7000-8000-000000000100…` | 211 | 592 | 207ms | 3/353ms | 64 | 8.1MB | 0.0MB | 128 | 126ms | 0 | - | 可感知延迟
公开进度页（进行中） | `/progress/01a0744d-0600-7000-8000-000008b4a000…` | 165 | 476 | 256ms | 2/239ms | 62 | 8.1MB | 0.0MB | 129 | 121ms | 0 | - | 可感知延迟
用例分析列表 | `/case-analysis` | 381 | 684 | 192ms | 3/355ms | 459 | 10.1MB | 0.1MB | 201 | 155ms | 5 | 0ms | 流畅
用例分析（2,150 认领） | `/case-analysis/01a06edd-6c00-7000-8000-0000000…` | 1626 | 1608 | 216ms | 3/360ms | 257 | 9.4MB | 0.1MB | 196 | 152ms | 5 | 0ms | 可感知延迟
分析统计（全局） | `/case-analysis/statistics` | 200 | 276 | 191ms | 1/171ms | 459 | 40.3MB | 0.1MB | 327 | 163ms | 5 | 67ms | 流畅
分析统计（按批次） | `/case-analysis/01a06edd-6c00-7000-8000-0000000…` | 315 | 600 | 192ms | 4/406ms | 258 | 9.5MB | 0.1MB | 148 | 145ms | 5 | 0ms | 流畅
质量洞察（35.7 万事实） | `/insights` | 666 | 684 | 208ms | 3/426ms | 1185 | 11.2MB | 0.1MB | 677 | 426ms | 5 | 0ms | 可感知延迟
文件与来源（8,075 对象） | `/objects` | 482 | 516 | 160ms | 2/266ms | 435 | 9.2MB | 0.1MB | 249 | 161ms | 5 | 0ms | 流畅
执行节点（260 台） | `/runners` | 578 | 668 | 200ms | 4/432ms | 267 | 9.4MB | 0.1MB | 369 | 246ms | 5 | 66ms | 可感知延迟
执行机组 | `/runners?section=groups` | 405 | 492 | 172ms | 2/267ms | 2931 | 10.8MB | 0.1MB | 350 | 141ms | 5 | 0ms | 流畅
安全审计（14 万事件） | `/audit` | 412 | 852 | 204ms | 3/362ms | 1134 | 9.8MB | 0.1MB | 275 | 196ms | 5 | 0ms | 可感知延迟
平台设置入口 | `/settings` | 190 | 328 | 206ms | 1/187ms | 376 | 39.4MB | 0.1MB | 146 | 210ms | 5 | 0ms | 可感知延迟
平台设置 | `/settings/platform?section=configuration` | 343 | 744 | 210ms | 3/392ms | 376 | 9.4MB | 0.1MB | 165 | 152ms | 5 | 0ms | 可感知延迟
项目与层级设置 | `/settings/projects` | 286 | 712 | 210ms | 2/278ms | 803 | 9.6MB | 0.1MB | 207 | 167ms | 5 | 62ms | 可感知延迟
访问管理（321 用户 / 自定义角色） | `/settings/access?section=users` | 500 | 700 | 261ms | 3/425ms | 1128 | 10MB | 0.1MB | 256 | 185ms | 5 | 61ms | 可感知延迟
自动化与调度设置 | `/settings/automation` | 385 | 340 | 246ms | 3/299ms | 1798 | 44.3MB | 0.2MB | 319 | 194ms | 5 | 74ms | 可感知延迟
回调通知（2,349 投递） | `/settings/webhooks` | 337 | 788 | 209ms | 2/290ms | 675 | 9.5MB | 0.1MB | 254 | 204ms | 5 | 70ms | 可感知延迟
账号安全 | `/account/security` | 313 | 608 | 197ms | 2/320ms | 315 | 9.3MB | 0.1MB | 154 | 137ms | 5 | 64ms | 流畅
分享：执行详情（100k 批次） | `/share/run/eyJ2ZXJzaW9uIjoxLCJyZXNvdXJjZVR5cGU…` | 201 | 584 | 248ms | 3/322ms | 1275 | 9.5MB | 0.1MB | 170 | 159ms | 0 | - | 可感知延迟
分享：执行日志（attempt） | `/share/run/eyJ2ZXJzaW9uIjoxLCJyZXNvdXJjZVR5cGU…` | 2379 | 508 | 305ms | 3/335ms | 79 | 8.3MB | 0.0MB | 2137 | 119ms | 0 | - | 可感知延迟
分享：用例详情 | `/share/case/eyJ2ZXJzaW9uIjoxLCJyZXNvdXJjZVR5cG…` | 172 | 732 | 225ms | 3/421ms | 100 | 8.1MB | 0.0MB | 178 | 160ms | 0 | - | 可感知延迟
分享：执行日志短链 | `/share/attempt-log/Zqtpsu-gVIW6Z_33TLgZWtNCTxM…` | 2278 | 512 | 310ms | 3/351ms | 263 | 8.5MB | 0.0MB | 2145 | 124ms | 0 | - | 可感知延迟
无权限提示页 | `/forbidden` | 274 | 512 | 183ms | 2/262ms | 254 | 9.1MB | 0.1MB | 145 | 137ms | 5 | 61ms | 流畅
