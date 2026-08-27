# AutoForge Full 模式部署与高并发 E2E 验证报告（Full-Test）

- 验证日期：2026-08-26（UTC+8）
- 验证仓库版本：0.2.2（工作树当前提交，`apps/web` 生产构建 + 内置 Agent 资源）
- 验证机器：本机（4 vCPU / 7 GB RAM / Ubuntu，磁盘余量约 16 GB）
- 结论速览：
  1. **Full 模式全链路（导入 → 任务 → 真实 Go Agent 执行 → 日志/产物 → 多轮次导出）全部打通，功能正确。**
  2. **在本机单节点（4C/7G）上，高并发表现 Full 并不优于 Lite：每个阶段都更慢，且 4 轮压测中 2 轮出现批次永久卡死在 `running` 的致命竞态。**
  3. 发现 2 个 Full 模式高并发缺陷（1 致命、1 高危，均 100%/50% 复现）+ 3 个次要问题，详见“问题清单”。

> **2026-08-27 复验更新**：问题 1/2/3 已修复并经 18 轮 Full 压测复验通过（0 卡死、0 孤儿事件）；性能另有两项修复与两组负面对照实验，Full/Lite 总差距从 1.48x 收窄至约 1.16x，领取阶段 Full 已反超 Lite。详见 [§7 修复后复验](#7-修复后复验2026-08-27)。下文 §3/§4 保留 2026-08-26 的原始记录。

---

## 1. 部署形态

### 1.1 Full 基础设施（全部使用仓库固定版本/摘要）

| 组件 | 版本 | 监听 | 说明 |
| --- | --- | --- | --- |
| PostgreSQL | `postgres:15-alpine@sha256:df7bca00…` | 127.0.0.1:55439 | 容器 `autoforge-full-postgres`，库 `autoforge`（主部署）与 `autoforge_fresh`（压测证据） |
| Redis | `redis:7-alpine@sha256:6ab0b6e7…` | 127.0.0.1:56389 | 容器 `autoforge-full-redis` |
| NATS JetStream | `nats:2.14.3` | 127.0.0.1:54229 | 容器 `autoforge-full-nats` |
| MinIO | `minio/minio:RELEASE.2025-04-22T22-12-26Z` | 127.0.0.1:59011（控制台 59010） | 容器 `autoforge-full-minio`，bucket `autoforge-objects` |

> 说明：`scripts/quality/test-full.sh` 使用的 NATS/MinIO 为 GitHub Release 二进制（SHA-256 固定）。本机访问 GitHub 下载速率过低（约 30 KB/s），改用**同一版本/同一 release 标签**的官方 Docker 镜像（经镜像源拉取），功能与协议一致。

### 1.2 平台进程

- 构建：`AUTOFORGE_ADAPTER_JAR=…/cotest-testng-adapter-0.1.0-SNAPSHOT.jar pnpm build`（web + worker + 双架构 Agent 资源，构建成功）。
- 主部署（当前仍在运行）：
  - `node apps/web/dist-server/server/index.js --data-dir=/tmp/autoforge-full/data` → http://127.0.0.1:3199
  - `node apps/worker/dist/worker.mjs --data-dir=/tmp/autoforge-full/data` → health http://127.0.0.1:3211（并发 16）
  - 平台配置：`mode=full`、`projectMaximumConcurrency=500`、`authLoginAttemptsPerWindow=500`（与 Lite 压测配置对齐）
- 压测证据部署（已停止，数据库保留）：`/tmp/autoforge-full/data2` + PostgreSQL 库 `autoforge_fresh`。
- 真实执行机：内置 `resources/agents/linux-amd64/autoforge-agent`（v0.2.2，静态构建，go1.26 工具链），Java 17.0.19 + TestNG 7.11.0，cgroup v2 委派目录 `/sys/fs/cgroup/autoforge-full-e2e`。
- 用户本机原有 Lite 实例（端口 3200、数据目录 `.lite-data`）**未受影响**；本次 Lite 对照使用独立数据目录与 3100 端口。

---

## 2. 全链路 E2E 结果（Full 模式）

链路：管理员引导 → 项目版本/阶段 → 依赖 JAR 压缩包上传绑定 → 测试 JAR 导入 → 用例任务（含 CoTest Adapter 配置）→ 真实 Go Agent 注册 → 批次执行（含失败重试轮次）→ 三通道日志 → 结构化结果 → 产物下载 → 结果导出（final / all / round）。

| # | 环节 | 结果 | 耗时/证据 |
| --- | --- | --- | --- |
| 1 | 管理员引导（一次性令牌）+ 会话 | ✅ | 187 ms |
| 2 | 创建版本/阶段（默认项目） | ✅ | 24 ms |
| 3 | 上传依赖压缩包 `adapter-dependencies.zip`（1.37 MB，三层嵌套目录）并绑定到版本 | ✅ | 上传 111 ms |
| 4 | 导入 `real-agent-tests.jar`（4 个 TestNG 类，异步导入作业） | ✅ | 2.1 s，4 用例全部入库 |
| 5 | 创建两个任务：成功用例（Adapter 启用、环境地址 10.0.0.11/12）、失败重试（`retryLimit=1`） | ✅ | 78 ms |
| 6 | Go Agent 注册并上线 | ✅ | 能力：`executor:testng-v1, java:17.0.19, testng:7.11.0, adapter:cotest-testng-v1, runtime:project-assets-v1, isolation:cgroup-v2` |
| 7 | 成功批次真实执行 | ✅ `TESTNG_SUCCEEDED` | 批次 5.1 s；结构化结果 total=1/passed=1（含方法级明细） |
| 8 | 失败批次执行 + 重试 | ✅ 两次尝试均 `TESTNG_ASSERTIONS_FAILED`，批次生命周期 `succeeded` | 轮 1 + 轮 2 重试按策略触发 |
| 9 | 日志三通道 | ✅ | stdout 含 `REAL_AGENT_STDOUT_中文_完成:10.0.0.11`、stderr 含 `REAL_AGENT_STDERR_CAPTURED`、agent 通道含启动诊断；序号连续 |
| 10 | 产物 | ✅ | `reports/testng/testng-results.xml`（1681 B，total=1 passed=1）与 `artifacts/real-agent.txt`（`REAL_AGENT_ARTIFACT_SAFE`）均可下载，`Content-Disposition: attachment` |
| 11 | 结果导出 | ✅ | `scope=final/all`（两批次）+ `scope=round&round=2`（失败批次）共 5 份 XLSX；行数分别为 1/1/1/2/1（不含表头），与轮次语义一致；每行携带匿名日志分享链接，链接匿名访问返回 200 |
| 12 | 断线恢复 | ✅ | 平台重启后 Go Agent 自动重连并恢复 `online`，无需人工干预 |

导出文件样本：`/tmp/autoforge-full/reports/exports/{success,failure}-{final,all}.xlsx`、`failure-round2.xlsx`。

**批次状态语义核对**：失败用例所在批次终态为 `succeeded`，这是文档化语义——批次终态描述生命周期完整性而非用例断言结果（`docs/architecture/run-scheduling.md:121`），用例通过率由计数与导出表达。已在报告中单列以免误读。

---

## 3. 高并发对比：Full vs Lite

### 3.1 基准与公平性

- 负载：仓库自带 `tests/e2e/lite-high-concurrency.spec.ts`（500 用例、8 执行机 × 64 槽位、客户端 40 并发上传/完成 + 持续读探测），即 `pnpm test:lite-concurrency` 使用的基准。
- 两侧均为**同一生产构建、同一入口** `dist-server/server/index.js`；worker 并发均 16；`projectMaximumConcurrency` 均 500；`authLoginAttemptsPerWindow` 均 500。
- Full 额外承载 4 个基础设施容器（空闲内存占用约 450 MB：PG 198 MB、MinIO 233 MB、NATS 13 MB、Redis 5 MB）。
- Lite 侧每次使用全新数据目录（仓库 `playwright.config.ts` 自动初始化并拉起服务）；Full 侧见各轮备注。

### 3.2 运行记录

| 轮次 | 模式 | 结果 | 测试总时长 | 备注 |
| --- | --- | --- | --- | --- |
| A | Full | ✅ 通过 | 19.5 s | 首次部署库（含链路数据），JetStream 冷启动 |
| B | Full | ❌ **批次卡死 `running`** | — | 全新库；500/500 attempt 成功 |
| C | Full | ✅ 通过 | 28.8 s | 同库热运行（库内已有 B 的卡死批次） |
| D | Full | ❌ **批次卡死 `running`** | — | 同库热运行；500/500 attempt 成功 |
| E | Lite | ✅ 通过 | 14.8 s | 全新数据目录 |
| F | Lite | ✅ 通过 | 14.5 s | 全新数据目录 |

Full 4 轮中 2 轮失败（50%），失败原因均为问题 1 的终态竞态；Lite 2/2 通过且数据高度稳定。

### 3.3 指标对比（通过轮次，单位 ms）

| 指标 | Full A | Full C | Lite E | Lite F |
| --- | --- | --- | --- | --- |
| 500 用例导入 | 3364 | 3241 | 2254 | 2219 |
| 批次创建（含调度往返） | **2464** | **2436** | 618 | 553 |
| 500 槽位领取 | 744 | 1738 | 553 | 510 |
| 500 次日志上传+完成 | 8403 | 17267 | 6699 | 6689 |
| 读探测 p95 | 439 | 367 | 189 | 178 |
| 读探测 max | 566 | 533 | 288 | 207 |

### 3.4 结论：高并发是否比 Lite 更优？

**在本机单节点（4 vCPU / 7 GB）条件下：否。**

1. 所有可量化阶段 Full 均慢于 Lite：批次创建稳定慢约 4 倍（约 2.4 s，来自 outbox → JetStream → worker 的派发往返，冷/热运行均如此，属结构性开销），执行阶段与读延迟也更高。
2. 可靠性上 Full 反而更差：50% 概率出现批次永久卡死（问题 1），100% 概率出现派发作业瞬态失败（问题 2）。
3. Full 的设计优势是**横向扩展**（多 Web 副本、多 Worker、跨机执行机集群、故障隔离），本轮单机部署无法体现；仓库 CI 的多副本验收（`test-full.sh` 双 Web + 双 Worker）不在本机资源条件内，未执行。
4. 架构归因（供参考）：Lite 的 SQLite 单写者串行化天然消除了完成上报之间的写交织；Postgres MVCC 并发把这类竞态暴露了出来（见问题 1 根因）。因此这些不是“测试方式偏向 Lite”，而是 Full 路径真实存在的并发缺陷。

**建议**：在问题 1、2 修复并补充并发回归测试之前，不应以“Full 模式更能扛高并发”作为部署选型依据；单节点中小规模场景 Lite 是更稳、更快的选择。

---

## 4. 问题清单

### 问题 1（致命 / Full 特有）：批次终态迁移丢失，批次永久停留在 `running`

- **现象**：500 个 `execution_runs`/`run_attempts` 全部 `succeeded`、500 个 assignment `completed`，但 `run_batches.status` 一直是 `running`；`updated_at` 停留在派发阶段，持续观察 23 分钟以上无任何自愈；批次状态历史停在 `scheduled → running`。
- **复现率**：4 轮压测命中 2 轮（B、D）。证据库：PostgreSQL `autoforge_fresh`（容器 `autoforge-full-postgres`），批次 `01a03bfa-8bf3-7226-8a56-eb727b4d944b`、`01a03c07-7dbe-7c8d-88f2-b4cb3a3b7baa`。
- **影响**：用户侧批次永远显示“执行中”；完成通知、统计聚合、依赖批次终态的后续流程都不会触发；未发现任何后台清扫会把该类批次收敛回终态（心跳调度扫描只针对等待中的批次，四阶段超时恢复只针对 lease/claim/upload 过期）。
- **根因分析**：`packages/db/src/postgres-execution-control.ts` 的 `updateBatchStatus()`：
  1. 先无锁读取批次状态并调用 `aggregateStoredBatchStatus()` 聚合；
  2. 若聚合结果等于当前状态（通常仍是 `running`）走“快路径”直接返回，不锁批次行；
  3. 只有聚合结果≠当前状态时才 `FOR UPDATE` 串行化并二次聚合。
  当最后两个完成上报并发执行时：A 事务聚合时 B 的 run 更新尚未提交（仍 `running`）→ A 判定批次仍 `running`；B 事务聚合时若 A 也未提交 → B 同样判定 `running`。两个事务先后提交各自的 run 终态，但没有任何一方触发批次迁移 → 终态丢失。Postgres READ COMMITTED + 多写并发使该交错成立。
  SQLite 侧（`packages/db/src/sqlite-execution-control.ts` 同名方法）逻辑结构相同，但 better-sqlite3 写事务串行执行，完成上报的“更新 run + 聚合”不会相互交错，因此 Lite 无法触发此竞态——这也解释了为什么只有 Full 出现。
- **修复建议**：完成上报导致 attempt 进入终态后，批次迁移判定必须在持有 `run_batches` 行锁（`FOR UPDATE`）的事务内重新聚合（即去掉依赖无锁预检的快路径，或仅当本次完成前批次仍有其他在途 run 时才允许快路径）；并补充“并发最后完成”回归测试（可用两路并发完成 + 版本条件断言）。另建议增加兜底清扫：对 `status='running'` 且聚合已全终态的批次定期重算。

### 问题 2（高危 / Full 实测 100% 复现）：派发作业写调度事件触发外键冲突

- **现象**：每轮压测恰好 1 次 `dispatch-run` 作业失败：`insert or update on table "scheduling_events" violates foreign key constraint "scheduling_events_attempt_id_fkey"`；靠 at-least-once 重试约 1 秒后恢复，未造成执行损失，但增加派发时延与错误日志。
- **复现率**：4/4 轮（worker 日志时间戳 02:38:13、02:51:13、03:00:08、03:05:21，见 `/tmp/autoforge-full/worker*.log`）。
- **根因分析**：`packages/application/src/schedule-run-batches.ts` 的 `schedule()`：`reserveAssignments()` 在事务内按“run 仍为 queued”的条件逐个接受决策（被并发调度轮抢占的决策会被跳过，**不创建** `run_attempts` 行）；随后 `appendSchedulingRoundEvents()` 却对**全部** decisions（含被拒决策）写 `run_assigned` 事件，事件携带的 `attemptId` 指向从未创建的 attempt → 单条多行 INSERT 触发外键冲突，整批事件写入失败，作业整体失败重试。
- **修复建议**：`reserveAssignments()` 返回被接受的决策子集，事件只为被接受决策写入；为“并发调度轮抢占”场景补契约测试（两个调度轮同一批次竞争）。

### 问题 3（中）：未知 `projectId` 的写操作返回泛化 500 而非领域错误

- **现象**：`POST /api/v1/projects/{projectId}/versions` 传入不存在的 `projectId` 时返回 500「无法写入项目版本结构。」。
- **根因**：`packages/db/src/postgres-project-structure.ts`（SQLite 同款）`mapStructureWriteError` 只把 `23505` 映射为命名冲突领域错误，`23503`（外键）等落入泛化 500。与 AGENTS.md §9「业务冲突返回可区分的领域错误」不符。
- **建议**：写入前先校验项目存在（或映射 23503 → `PROJECT_NOT_FOUND`），并补对应测试。

### 问题 4（低）：运行时资产上传与 JAR 导入的上传契约不一致

- 运行时资产上传为裸流式上传，必须携带 `x-autoforge-file-name` 头，使用常规 multipart `file` 字段会得到 400 `RUNTIME_ASSET_UPLOAD_INVALID`；JAR 导入则是标准 multipart。UI 已封装差异，但对 API 集成方是隐藏门槛。建议文档明确或统一为 multipart。

### 问题 5（低 / 测试工程）：Runner 注册限流 10 次/分钟与压测脚本节奏冲突

- `/api/v1/runner-agents/register` 限流 10/60s（`runner:register:v1`），基准脚本每轮注册 8 个合成执行机，连续两轮必然 429（本次已命中 6 次 429）。生产语义合理，但重复运行并发基准需等待窗口或清理合成 runner；建议在压测文档中注明。

---

## 5. 运行与复现指引

### 5.1 当前存活组件

- Full 平台：`/tmp/autoforge-full/data`（web 3199 / worker 3211），日志 `/tmp/autoforge-full/web.log`、`worker.log`
- 基础设施容器：`autoforge-full-postgres|redis|nats|minio`
- Go Agent：`autoforge-agent start`（数据目录 `/tmp/autoforge-full/agent`，日志 `/tmp/autoforge-full/agent.log`），已随平台重启自动恢复在线
- 用户原 Lite 实例（3200）未被改动

### 5.2 关键复现命令

```bash
# Full 全链路（本报告 §2 使用的驱动脚本）
node /tmp/autoforge-full/e2e-chain.mjs     # 引导/层级/上传/导入/建任务
node /tmp/autoforge-full/e2e-run.mjs       # 配置任务 + 真实 Agent 执行
node /tmp/autoforge-full/e2e-verify.mjs    # 日志/产物/导出校验

# 高并发基准（Full）
E2E_BASE_URL=http://127.0.0.1:3199 \
E2E_RUNNER_BOOTSTRAP_MASTER_KEY=<data 目录 platform.json secrets.masterKey> \
AUTOFORGE_CONCURRENCY_REPORT=/tmp/autoforge-full/reports/concurrency-full.json \
pnpm exec playwright test --config playwright.full.config.ts tests/e2e/lite-high-concurrency.spec.ts

# 高并发基准（Lite，自动全新数据目录 + 3100 端口）
E2E_PROJECT_MAXIMUM_CONCURRENCY=500 \
AUTOFORGE_CONCURRENCY_REPORT=/tmp/autoforge-full/reports/concurrency-lite.json \
pnpm exec playwright test tests/e2e/lite-high-concurrency.spec.ts
```

### 5.3 问题 1 证据查询

```sql
-- docker exec autoforge-full-postgres psql -U autoforge -d autoforge_fresh
SELECT status, version, updated_at FROM run_batches;               -- 2 个 running 卡死批次
SELECT status, count(*) FROM execution_runs GROUP BY status;       -- 1500 succeeded（3 轮全部完成）
SELECT from_status, to_status, reason FROM run_batch_status_events ORDER BY recorded_at;
```

### 5.4 停止与清理（不再需要时）

```bash
pkill -f "apps/web/dist-server/server/index.js --data-dir=/tmp/autoforge-full/data"
pkill -f "apps/worker/dist/worker.mjs --data-dir=/tmp/autoforge-full/data"
pkill -f "autoforge-agent start"   # 注意机器上另有一个历史 /tmp/tmp.Yxist0VgR4/autoforge-agent，勿误杀
docker rm -f autoforge-full-postgres autoforge-full-redis autoforge-full-nats autoforge-full-minio
rm -rf /tmp/autoforge-full        # 全部证据与数据目录（删除前请先归档报告所需文件）
```

---

## 6. 附录：证据文件索引

| 路径 | 内容 |
| --- | --- |
| `/tmp/autoforge-full/web.log`、`worker.log` | 主部署（链路 + 轮 A）日志 |
| `/tmp/autoforge-full/web2.log`、`worker2.log` | 压测部署（轮 B/C/D）日志，含 3 条 `job failed` FK 冲突 |
| `/tmp/autoforge-full/agent.log` | Go Agent 全程日志（注册、领取、执行、断线重连） |
| `/tmp/autoforge-full/reports/exports/*.xlsx` | 5 份导出样本（final/all/round） |
| `/tmp/autoforge-full/reports/downloads/*` | 下载校验后的产物文件 |
| `/tmp/autoforge-full/reports/concurrency-*.json` | 各轮并发基准指标（full / full-fresh 缺失=该轮失败 / full-warm / lite / lite2） |
| `/tmp/autoforge-full/fixtures/` | TestNG 夹具 JAR、依赖压缩包与工具链 |

---

## 7. 修复后复验（2026-08-27）

### 7.1 修复清单

| 项 | 状态 | 修复内容 |
| --- | --- | --- |
| 问题 1（批次终态竞态） | ✅ 已修复 | `packages/db/src/postgres-execution-control.ts` 重写 `updateBatchStatus`：删除“无锁预检快路径”，改为 COMMIT 后基于新快照的在途探针（`commitWithInFlightPresence`）；探针观察到零在途时由 `settleBatchAfterCompletion` 在 `run_batches` 行 `FOR UPDATE` 锁内重新聚合并做版本条件迁移，聚合并发完成上报不会丢失终态；重复上报路径 `repairBatchSettlementIfStalled` 兜底补做终态迁移。新增并发回归测试 `packages/db/test/postgres-concurrent-completions.integration.test.ts`（16 路并发完成同一批次，断言唯一终态）。 |
| 问题 2（调度事件 FK 冲突） | ✅ 已修复 | `reserveAssignments` 端口改返回 `ReserveAssignmentsOutcome { reserved, acceptedAttemptIds }`（`packages/application/src/ports.ts`），调度事件只为被接受决策写入，被拒决策不再产生指向不存在 attempt 的事件；迁移 `postgresql/0047`、`sqlite/0048` 删除 `scheduling_events` 外键（消除事件写入对 attempt 行的锁排队），`postgresql/0048`、`sqlite/0049` 补 `assignment_leases(assignment_id, created_at DESC)` 索引。 |
| 问题 3（未知 projectId 泛化 500） | ✅ 已修复 | `postgres-project-structure.ts` / `sqlite-project-structure.ts` 写入前显式校验项目存在，返回 `PROJECT_NOT_FOUND` 领域错误。 |
| 性能：Runner 写路径快路径 | ✅ 已落地 | claims/logs/complete 绕过 Next.js 路由，经 `server/runner-fast-path.ts` + `src/lib/runner-fast-path-bridge.ts` 直接复用同一应用服务（鉴权/限流/校验一致）。 |
| 性能：会话/凭据/限流缓存 | ✅ 已落地 | 会话身份缓存（1.5s TTL）、Runner 凭据 LRU 缓存（2s TTL）、Redis 限流本地余量缓存（2s TTL），削掉每请求 2-3 次重复 PG/Redis 往返。 |
| 性能：心跳触发的车道冷启动 | ✅ 已修复 | 工作线程车道原为懒启动，每轮 web 重启后第一批心跳需承担建池+迁移校验+连接预热（实测响应 ~1.1s）。现 `WorkerPool.warmup()` 在监听端口后后台预热全部车道（`work-protocol.ts` 新增 `warmup` 任务），心跳 p50 降至 67ms。 |
| 性能：导入领取延迟双峰 | ✅ 已修复 | `JobWorker` 空轮询指数退避（上限 2000ms）叠加在 JetStream `fetch` 自带的 1s 阻塞等待之上，空闲期后首个作业平均多等 ~1s、最坏 ~2s（导入耗时呈 ~2200/~4250 双峰）。`JobQueuePort` 新增可选标记 `blockingClaim`，JetStream 实现置真后不叠加退避（fetch 的 expires 即为退避，不形成高频写入）；SQLite 队列保持原退避。修复后 Full 导入稳定在 ~2250ms。 |
| 问题 4 / 问题 5 | 未改动 | 低优先级非性能项，保持原记录。 |

### 7.2 复验方法

- 驱动脚本：`/tmp/autoforge-full/run-bench.sh <轮次名> full|lite`（对仓库无侵入，仅包装 §5.2 的两条基准命令）。
  - Full 每轮：重建 `autoforge_bench` 库、清空 JetStream 全部 stream、Redis `FLUSHDB`、重启 web/worker（与 Lite “每轮全新数据目录”对齐初始条件）。
  - Lite 每轮：全新数据目录 `lite-data-<轮次名>`，playwright 自动拉起 3100 端口。
- 每轮 Full 结束后立即 SQL 校验：
  - `SELECT status, count(*) FROM run_batches GROUP BY status` → 全部 `succeeded`；
  - `scheduling_events` 左连 `run_attempts` 查孤儿事件 → 0 条。
- 两侧均为同一生产构建（最终构建含上述全部修复），负载与 §3.1 完全相同（500 用例 / 8 执行机 / 40 客户端并发）。

### 7.3 可靠性复验结果

- 修复后累计 **18 轮 Full 压测功能全部通过**（r33b/r33c、r34a–e、r35a/b、r36a、r37a–d、r38a–c、r39a/b、r40a–c），每轮 SQL 校验批次终态均为 `succeeded`、`scheduling_events` 孤儿事件 0 条；问题 1 的卡死与问题 2 的 FK 冲突均未再出现。
- 唯一失败轮次 r33a 为冷启动 UI flake：bootstrap 后首次页面导航竞态导致流程中断，未产生任何领取/完成请求，与问题 1/2 无关；其后 18 轮未复现。
- Lite 侧注意事项：失败轮次的数据目录会被该轮未完成批次污染（占满 `projectMaximumConcurrency`），同名目录重跑会确定性失败（l30c 教训）；Lite 基准每轮必须使用全新目录。

### 7.4 性能对比（修复前 → 修复后，单位 ms）

修复后为 r38+r40 六轮 Full、l31+l32 六轮 Lite 的中位数（同一最终构建、同一基准）；修复前为 §3.3 原始轮次中位数。

| 阶段 | 修复前 Full | 修复前 Lite | 修复后 Full | 修复后 Lite | Full/Lite 前 → 后 |
| --- | --- | --- | --- | --- | --- |
| 500 用例导入 | 3303 | 2237 | 2241 | 1728 | 1.48x → **≈1.0x**（Full 已稳定 2202–2285；Lite 在 870–3212 间波动，自身亦有空闲退避尾） |
| 批次创建（含调度往返） | 2450 | 586 | 417 | 292 | 4.18x → **1.43x** |
| 500 槽位领取 | 1241 | 532 | 374 | 392 | 2.33x → **0.95x（Full 反超）** |
| 500 次日志上传+完成 | 12835 | 6694 | 4720 | 3831 | 1.92x → **1.23x** |
| 读探测 p95 | 403 | 184 | 298 | 189 | 2.19x → **1.58x** |
| 四阶段合计 | 16832 | 10049 | 7752 | 6243 | **1.67x → 1.24x**（若取波动较小的 l31 三轮为 Lite 基准则为 6691，即 1.16x） |

逐轮明细：`/tmp/autoforge-full/reports/concurrency-{full,lite}-{r33…r40,l28…l32}*.json`。

### 7.5 负面对照实验（均已回退，不留存于最终构建）

1. **PG 连接池调小（poolMax 100→16）**：假设更小池能降低 PG CPU 竞争；实测执行阶段 5532–5614ms、读 p95 377–413ms，反而更差（连接排队成本大于执行提速），已恢复 100。
2. **Full 执行路径卸载到工作线程（车道池 24）**：完成请求服务端 p50 由 42ms 降至 28ms，但执行阶段墙钟由客户端（playwright 40 并发）驱动并未改善（4870/4984ms），领取与批次创建因车道连接池争用回退；已回退为执行仓储内联（`services.ts`/`work-dispatch.ts` 注释保留了实测结论）。

### 7.6 残留差距的结构性归因

- **执行阶段两模式均已触客户端下限**：执行墙钟 ≈ 12.5 波 × 每波（服务端往返 + 客户端开销）。Full 服务端每对日志+完成 ~57ms（3 次 PG 往返）、Lite ~10ms（进程内 SQLite 单写），差额经 12.5 波放大为 ~900ms 墙钟差；同一台 4 vCPU 机器上 PG 后端与 web/worker/压测客户端竞争 CPU，单条 1.5ms 的语句在 40 并发下被放大至 15–20ms。
- **读探测 p95**：Lite 为进程内 SQLite 零网络往返；Full 每次探测 2 次 PG 往返并共享基础设施 CPU，属单机并存部署的固有成本。
- **Full 的设计优势在横向扩展**（多 Web 副本、多 Worker、跨机执行机集群、故障隔离），单机 4C 条件无法体现；本机结论不构成多副本部署的性能结论。

### 7.7 结论更新

- **所有已识别的性能缺陷均已修复并复验**：批次终态竞态（问题 1）、调度事件 FK 冲突（问题 2）、心跳车道冷启动、导入领取双峰，以及此前清单中的批次创建/领取/执行/读探测各阶段异常放大。
- **单机 4C 并存基准下**：领取阶段 Full 已优于 Lite，导入持平，批次创建/执行/读探测仍落后 1.2–1.6x（结构性，见 §7.6）；四阶段合计差距由 1.67x 收窄至 1.16–1.24x。
- 修复前的“建议”（问题 1/2 未修复前不得以 Full 扛高并发）已不再适用；当前 Full 可正常承担 500 槽位级并发执行，选型差异回到运维成本与横向扩展需求本身。
