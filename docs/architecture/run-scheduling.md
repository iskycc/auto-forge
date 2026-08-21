# 批跑动态调度

状态：任务快照执行、资源感知调度、Lite/Full 持久化、`RunAttempt` 分配、Agent claim/lease、实际 TestNG 执行、结果上报、失败重跑与基础设施异常重调度均已实现；优先级公平性、项目配额和完整故障注入仍待验收。

## 输入与快照

管理员先在 `CaseSuite` 中保存完整执行配置；顶栏快捷执行、计划任务与 Jenkins API 创建批次时都只提交 `suiteId`，不能临时覆盖任务策略。单用例快捷执行仍提交一次性的显式配置。平台在同一事务中保存：

- `CaseSuite` ID、名称与版本；
- 每个启用 `CaseDefinition` 的 ID、当前版本、类名和显示名；
- 任务指定的 Runner ID，或任务指定 Runner Group 当时的成员快照；
- `retryLimit`、重跑方式、项目版本与 Adapter 环境地址；
- 排队、领取和上传收尾三个任务级恢复时限，以及平台全局“单用例执行超时”的快照；
- 一个用例对应一个 `ExecutionRun`，一次实际调度对应一个 `RunAttempt`。

任务和单用例手工参数覆盖、产品级执行环境、内联环境变量和执行密文已从新建链路移除；TestNG 导入发现的只读参数元数据仍随用例版本固化。历史数据库列只用于旧库可升级和历史记录可读取，新批次固定为空。创建用例先执行相同的服务端预检，逐项检查任务状态、用例输入、Runner/工具链、项目版本的权威 JAR 对象和固定资源上限，预检通过后才创建权威批次。

## Runner 资源快照

Linux Agent 每次心跳读取：

- `/proc/stat`：相邻采样差值计算 CPU 使用率；首次采样只建立基线，不参与调度；
- `/proc/meminfo`：以 `MemTotal - MemAvailable` 计算内存使用率；
- `/proc/loadavg`：读取 1 分钟系统负载；
- `runtime.NumCPU()`：逻辑 CPU 数。

控制面使用接收心跳的服务端 UTC 时间作为指标时间，避免 Agent 时钟偏差影响新鲜度判断。资源采集失败时 Agent 仍发送心跳，但不附带快照；该节点保持在线，却不会获得新的执行分配。

## 准入规则

候选 Runner 必须同时满足：

1. 位于用户勾选范围内且没有被禁用；
2. Runner Protocol v1、Linux `amd64/arm64`、TestNG executor v1、Java 11+ 和 TestNG 7.11.0 兼容；cgroup v2 缺失只产生降级隔离提示，不阻塞调度；
3. 心跳在线，资源快照未超过配置的最长年龄；
4. `maxConcurrency - max(Agent busySlots, 平台活动 RunAttempt 数) > 0`；
5. CPU 使用率不超过阈值；
6. 内存使用率不超过阈值；
7. `loadAverage1m / logicalCpuCount` 不超过阈值。

领域调度结果为每个候选节点保留 `runner_incompatible`、指标缺失/过期、容量不足和各资源阈值超限等稳定阻塞原因。仓储在真正写 assignment 前使用同一兼容性规则再次校验，Agent 领取后还会以不可变快照中的运行时要求做本地校验。

阈值由首次启动引导或“系统设置 → 平台配置”写入私有 `platform.json`，包括 CPU/内存百分比、
每 CPU load、指标最大年龄、项目最大并发和优先级老化间隔。Lite 与 Full 读取同一 schema 并使用
相同领域算法；修改需要 revision 条件且在明确重启后生效。

## 评分与分配

准入后的节点按 0–100 分评分：

```text
score = 100 × (
  0.40 × 空闲槽位比例 +
  0.25 × CPU 阈值余量 +
  0.20 × 内存阈值余量 +
  0.15 × 单位 CPU 负载阈值余量
)
```

调度器依次处理稳定排序的等待用例，每分配一个用例就立即减少该 Runner 的模拟空闲槽位并重新评分，因此会自然向更空闲的节点扩散。分数相同时按 Runner ID 排序，保证相同输入得到确定结果。

创建批次后立即运行一轮调度；之后每次认证心跳会有界扫描等待批次，使暂时过载或离线导致的未分配用例在资源恢复后继续分配。批次状态为：全部等待时 `queued`，部分分配时 `dispatching`，全部生成分配时 `scheduled`。

任务容量不以 UI 或单条 SQL 的参数上限定义。当前 Lite/Full 均支持至少 100,000 个任务成员和同规模 `ExecutionRun`：成员校验、关联查询和写入按固定批次执行，批次摘要使用数据库聚合；每轮调度只读取按创建顺序排列的前 4,096 个可调度 run 及其 attempt 历史。这个窗口覆盖当前 Runner 总槽位上限，完成或心跳会继续触发下一窗口，因此不会为一次补调度把 10 万行及全部 attempt 载入内存，也不会改变稳定顺序、重试或租约语义。

`RunBatch`、`ExecutionRun`、`RunAttempt`、assignment 和 lease 都使用正整数版本。批次创建、调度、领取、完成、超时回收和取消在短事务中以当前版本做条件更新；版本冲突会中止事务，不以最后写入覆盖并发结果。批次每次状态变化同时追加不可变 `run_batch_status_events`，记录前后状态、变更后版本、原因和服务端 UTC 时间；从旧库升级时为已有批次写入 `history.baseline`，因此详情可以从创建或升级基线开始审计完整状态路径。

## 并发与双模式

- SQLite 在短写事务内重新读取 Runner、活动 attempt 和等待 run，使用条件更新防止重复分配；批次状态也使用版本条件写。
- PostgreSQL 按 Runner ID 固定顺序取得行锁，再重新执行同一准入规则和容量计算，避免并发批次超卖同一执行机。
- `busySlots` 与平台活动 attempt 可能描述同一工作，容量计算取二者最大值而不是相加，避免重复扣减。
- Full 在同一 PostgreSQL 事务中保存调度事实和 outbox，独立 Dispatcher 将消息幂等发布到 JetStream；SQLite 与 JetStream 运行相同的至少一次投递契约，Redis 不参与正确性判断。

## 失败重跑边界

`retryLimit` 表示首次执行之外允许的用例失败重跑次数。例如配置 2 时，TestNG 失败的 attempt 1 和 attempt 2 后重新排队，attempt 3 失败后形成该用例最终结果。Runner/传输异常使用独立的两次恢复预算并优先换机，不消耗这里的重跑次数。Agent 完成上报在权威事务中固化终态、状态事件和下一次 attempt；重复或迟到上报不会覆盖新租约持有者的结果。

批次终态描述生命周期是否完整，而不是用例断言结果：全部用例按策略正常执行完毕为 `succeeded`（界面“执行完成”），即使其中仍有最终失败用例；Runner/控制面等非正常异常耗尽恢复预算为 `failed`（“执行异常”）；用户取消或中断为 `cancelled`（“执行中断”）。用例通过/失败只在批次计数、总结轮次和分析事实中表达。

## 超时与恢复

任务可配置 `queueTimeoutMs`、`claimTimeoutMs` 和 `uploadTimeoutMs`，入口分别限制在 7 天、1 小时和 1 小时以内。任务不再保存 `executionTimeoutMs`；批次创建统一读取平台配置的 `caseExecutionTimeoutSeconds`，避免同一概念出现两份冲突配置。所有 deadline 由控制面 UTC 时钟计算并持久化，恢复扫描不依赖 Web/worker 进程内定时器：

- queued run 越过排队期限后进入最终 `failed/timed_out`，原因码为 `QUEUE_TIMEOUT`；assignment 条件更新也检查排队期限，防止扫描前的竞态领取。
- pending assignment 越过领取期限后 attempt 使用 `ASSIGNMENT_CLAIM_TIMEOUT`，并按已固化重试策略回排或终结。
- 已领取 attempt 在上传阶段开始前使用 `EXECUTION_TIMEOUT`；lease 提前失效仍使用独立 `LEASE_EXPIRED`。
- Agent 完成进程执行后总会调用产物声明，零产物时发送空数组。服务端首次声明原子记录 `upload_started_at`，此后恢复扫描停止计算执行期限并改用 `UPLOAD_TIMEOUT`。

四类裁决都先条件写入权威状态和状态历史，再允许重复扫描返回零变更；迟到完成上报不会覆盖已确认的超时终态。

## Jenkins 与只读进展

Jenkins Pipeline 使用服务账号签发的最小权限 `af_api_` API Key。`POST /api/v1/jenkins/runs` 需要项目级 `run.create`，只接受 `suiteId`，返回批次 ID、30 秒建议轮询周期、鉴权 API 地址和带批次绑定 HMAC 的只读进展地址。Jenkins 步骤必须轮询到批次终态才结束，并打印当前轮次、本轮完成/通过/失败、累计通过、最终失败和进展链接；正常用例失败不使 Jenkins 步骤失败，执行异常或中断才失败。

`GET /api/v1/run-batches/{batchId}/progress` 可使用 `run.read` API Key，或使用七天有效、只绑定该批次的签名参数。`/progress/{batchId}` 只渲染进度卡片，不渲染应用顶栏、侧栏或其他业务数据。签名参数不能访问日志、产物或其他 API。
