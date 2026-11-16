# PostgreSQL 执行锁竞争

## 已复现的问题

2026-11-13 排查 Full 多任务运行期间的 `55P03`。用户环境为一个 Web、两个 Worker、四个任务，总执行并发约 90；另有单个普通 TestNG 批次在第五轮末尾超时后，第六轮多例日志停止并最终超时，暂停后继续调度可恢复。没有访问用户部署，以下分别记录本地证实的锁缺陷和仍需现场证据的执行停滞。

1. 项目额度预留和批次控制使用 `FOR UPDATE`。审计、历史和版本写入的外键检查会对同一父行取得 `KEY SHARE`；两者冲突，即使引用方没有修改项目额度或批次状态，也会阻塞调度、领取、暂停和收尾。真实 PostgreSQL 测试通过未提交的外键 INSERT 复现了 `55P03`。
2. 预留先锁批次、再等待项目额度。其他任务占用项目锁时，等待方同时占有自身批次锁，使该批次的控制请求被连带阻塞。测试通过 `pg_blocking_pids` 确认调度确实等待项目锁，此时暂停同一批次在旧实现中超时。
3. 完成上报保留了快速事务束，但没有沿用其他控制写入的有限锁重试。结果写入前或者结果已提交、批次收尾尚未提交时，瞬时 `55P03` 都会使请求失败。真实 PostgreSQL 触发器分别对两个阶段注入一次锁错误，旧实现均不能在当前请求内恢复。
4. 用户进一步提供 `read-model-worker` 的 `analytics.rebuildFacts / 55P03`。多个 Web／Worker 的分析事实重建共用一把事务 advisory lock，后台连接只等待 50ms，正常发布者尚未提交就可能让其他后台进程触发锁超时和运行保护。该警告描述的是等待方，不能直接认定它就是阻塞用例执行的持锁方。
5. 根据这条线索，实际复现了上一轮事实 INSERT 引用同一个 `ExecutionRun`，而下一轮完成上报、取消使用 `FOR UPDATE` 的冲突。即使前一轮 attempt 已经结束，两轮仍引用同一 run，事实写入取得的外键 `KEY SHARE` 仍会使下一轮控制请求超时。回归在上一轮实际事实事务未提交期间进行下一轮完成和取消：旧实现均报 `55P03`，开始上传则原本可用。

## 修复及不变量

- 项目额度、批次生命周期及轮次推进使用 `FOR NO KEY UPDATE`。这些操作不修改被引用的键，仍与其他状态写入互斥，同时允许普通外键引用。assignment、attempt、lease 的执行权锁保持原规则。
- 预留先取得项目额度锁，再锁定并重新校验批次暂停、终止、轮次及实际容量；等待项目额度时不持有批次锁。节点按 ID 锁定，跨节点领取涉及多个批次时也统一按批次 ID 顺序更新。
- 完成上报复用既有六次上限的锁冲突退避，只处理 `55P03`、`40P01`、`40001`。失败先回滚并释放连接，再等待重试；回滚失败时丢弃连接并保留两个错误，不继续重放。
- 结果已提交后的重试读取原有持久完成回执，只补做收尾，不重复完成事件、结果或重跑次数。非锁错误仍直接上报；持续竞争超过预算仍明确失败。
- 完成和取消只对 `execution_runs` 使用非键更新锁，仍与其他状态写入互斥，允许上一轮事实的普通外键引用。完成上报对当前 attempt 的执行权锁不变，不允许重复结果覆盖。
- 后台事实生成使用非阻塞的 `pg_try_advisory_xact_lock`。已有发布者时返回明确的 `deferred`，释放事务并按原有上限 30 秒的退避重试，不发送数据库故障事件。`updated: 0` 与暂缓不同；需要准确结果的前台读取／导出仍执行原有有界等待，不能把暂缓误当成扫描完成而发布不完整统计。
- 只有发布者才扫描及提交事实；整页事务、按 attempt 去重、版本升级和保留清理保护保持不变。Lite 实现相同端口并沿用 SQLite 短事务，不引入 PostgreSQL 依赖。真正的行锁、SQL 期限或连接错误仍会上报，不笼统吞掉 `55P03`。
- 不放宽数据库锁等待、SQL 期限或用例超时，不改变资源额度、两轮窗口、Jenkins 屏障和结果归属。SQLite 不需要这些 PostgreSQL 锁语法，继续走原有短事务及相同调度规则。
- 没有新增迁移、配置、生产依赖、Runner 协议或 UI。更新时 Web 与所有 Worker 应使用同一版本。

## 异常超时的证据边界

`TestNG exceeded the configured execution timeout.` 来自 Runner 的本地进程执行期限；`Execution exceeded its configured timeout.` 来自平台按该 attempt 的开始时间恢复。它们与领取期限、lease 过期有不同语义，不能仅凭出现 `55P03` 就认定 Java 进程停滞的原因已找到。

暂停停止新的调度，不重启已领取的 Java，不清除已有尝试，也不延长其执行期限。暂停后正常是重要线索，但不能单独证明轮次串号、节点资源不足或者业务线程锁死。

双库边界回归将真实领取的相邻两轮推进到第五／第六轮：第五轮最后一例到达自身 600 秒期限时，仅回收该例；第六轮已运行尝试保持自己的开始时间和轮次，旧轮失败加入第六轮而不开放第三个窗口。再暂停／恢复，第六轮仍可正常完成，旧轮迟到成功不能覆盖超时结果。

若再次出现“已有 stdout、随后停止”，应在超时杀进程前保存该 Java 的线程栈，并对齐 batch、attempt、节点和时间。可在节点使用该 JDK 的 `jstack -l <Java进程PID>`，重点观察业务线程所等待的锁、远端接口或文件操作。线程栈应在节点受控保存，不粘贴凭据、业务参数或完整日志到公共渠道。

数据库等待可先只查会话与阻塞关系，不导出 SQL 正文：

```sql
SELECT pid, state, wait_event_type, wait_event,
       now() - xact_start AS transaction_age,
       pg_blocking_pids(pid) AS blocking_pids
FROM pg_stat_activity
WHERE datname = current_database()
  AND (wait_event_type = 'Lock' OR cardinality(pg_blocking_pids(pid)) > 0)
ORDER BY xact_start NULLS LAST;
```

## 本地验证

- 真实 PostgreSQL 回归覆盖独立外键引用、项目额度竞争期间暂停、三个独立仓储连接池模拟一个 Web／两个 Worker、四个任务同时预留和领取 90 例、续租、恢复、并发完成及继续补槽。测试锁期限为 30ms，没有通过增加等待时间绕过竞争。
- 两阶段故障注入断言结果及完成事件各写入一次，收尾失败后可从持久回执继续完成。
- SQLite／PostgreSQL 共同覆盖第五／第六轮超时、暂停／恢复、迟到结果以及原有取消、轮次恢复、Jenkins 和并发约束。
- 上一轮真实事实 INSERT 持有外键引用时，下一轮完成、进入上传及取消均能返回；后台持锁竞争、真正的行锁失败、错误阶段、失败回滚后恢复、重复生成及统计一致性有独立 PostgreSQL 回归。双库均验证后台空扫描与成功更新的区分。

这些验证能确认上述锁缺陷已修复，不能替代用户真实 Java 用例和长时间混合负载的停滞复现。

后续用户提供的日志 POST 429 又定位了上传限流与上传阶段登记过晚的问题；相关修复、诊断入口、验证记录及 Agent 更新要求见[执行超时与日志上传诊断](../operations/execution-timeout-diagnostics.md)。它们与这里的数据库锁修复一起交付，不能把所有本地 JVM 超时归因于数据库或上传限流。

## 分析事实警告的进一步定位

新版本对真实失败附加有界阶段标识，保留原始错误码及 cause，不记录 SQL 或凭据：

| 操作 | 含义 |
| --- | --- |
| `analytics.facts.wait-owner` | 要求准确结果的读取等待现有发布者失败 |
| `analytics.facts.try-owner` | 后台非阻塞探测本身发生数据库错误；正常未取得锁不报警 |
| `analytics.facts.read-completions` | 读取待生成的已完成 attempt 失败 |
| `analytics.facts.write-facts` | 写入事实失败，需排查外键引用行或事实写入竞争 |

仅凭旧版本的 `analytics.rebuildFacts / 55P03` 无法区分这些阶段。修复证明了实际存在的锁冲突，并不等于已经解释现场所有 Java 线程停止输出的原因；同一时间的日志上传 429 和超时前 JVM 快照仍需一起核对。

## 分析事实修复验收

定向回归使用真实 PostgreSQL 与 SQLite，11 个文件共 260 项通过。测试文件涵盖 `postgres-scheduling-locks`、`analytics-snapshot-consistency`、`sqlite-platform-operations`、`postgres-platform`、`postgres-concurrent-completions`、`scheduling-refill`、`read-model-snapshots`、`analytics-fact-index-migration`、Web 的 `analytics-fact-refresh`、`read-model-thread` 和 Worker 的 `read-model-bundle`。

进一步重跑 `pnpm exec vitest run apps/worker/src/read-model-bundle.integration.test.ts --maxWorkers=1 --no-file-parallelism`，三个生产构建线程测试通过：Lite 与 Full 均能生成快照并关闭，三个 Full 后台线程在已有事实发布者持锁时分别完成冷快照，未产生数据库故障警告。共享优先级信号使已预热线程退让，确保每个新线程都实际完成一次工作，而不是由第一个线程代替所有线程生成。

实际通过的类型及构建命令：

```text
pnpm --filter @autoforge/application typecheck
pnpm --filter @autoforge/db typecheck
pnpm --filter @autoforge/web typecheck
pnpm --filter @autoforge/worker typecheck
pnpm exec tsc --noEmit -p tsconfig.tests.json
pnpm --filter @autoforge/web build
pnpm --filter @autoforge/worker build
```

本次变更文件的 ESLint（`--max-warnings=0`）、Prettier 检查和 `git diff --check` 均通过。事实刷新模块只由后台线程打包，其类型在 `tsconfig.worker.json` 中检查，和既有 AI 线程等模块一样，不进入直接 NodeNext 服务入口的编译范围。

Full 使用真实 PostgreSQL、Redis、NATS、MinIO 和一个 Web、两个独立 Worker，`scheduling-refill.spec.ts` 的即时补槽／暂停继续／终止收尾 Playwright 场景通过（49.4 秒）。首次启动因上轮清理了本地测试数据库而失败，修正测试准备流程、从管理库创建独立测试库后重跑通过；该失败不属于平台代码错误。本次补充没有修改 UI，沿用前一轮已经检查的 1024px／1536px 深浅色截图。
