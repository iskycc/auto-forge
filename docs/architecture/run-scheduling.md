# 批跑动态调度

状态：资源感知调度、Lite/Full 持久化、批跑页面、`RunAttempt` 分配、Agent claim/lease、实际 TestNG 执行、结果上报和失败重跑触发均已实现首版；优先级公平性、项目配额和完整故障注入仍待验收。

## 输入与快照

管理员创建批次时必须选择一个 `CaseSuite`、至少一台 Runner、失败重跑次数和可选执行环境版本。平台在同一事务中保存：

- `CaseSuite` ID、名称与版本；
- 每个启用 `CaseDefinition` 的 ID、当前版本、类名和显示名；
- 允许参与本批次的 Runner ID；
- `retryLimit`、按名称排序的非密文变量快照和密文版本引用；
- 排队、领取、执行和上传收尾四个有界超时策略；
- 一个用例对应一个 `ExecutionRun`，一次实际调度对应一个 `RunAttempt`。

普通环境变量按明文业务数据保存，密码和令牌必须使用项目级执行密文。密文值不进入批次或 assignment；Agent 只在取得有效 attempt lease 后按需领取。创建页面先调用 `/api/v1/run-batches/preflight`，逐项检查输入、环境/密文、Runner/工具链、权威 JAR 对象和固定资源上限，预检通过后才创建权威批次。

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
2. Runner Protocol v1、Linux `amd64/arm64`、TestNG executor v1、Java 11+、TestNG 7.11.0 和 cgroup v2 隔离兼容；
3. 心跳在线，资源快照未超过配置的最长年龄；
4. `maxConcurrency - max(Agent busySlots, 平台活动 RunAttempt 数) > 0`；
5. CPU 使用率不超过阈值；
6. 内存使用率不超过阈值；
7. `loadAverage1m / logicalCpuCount` 不超过阈值。

领域调度结果为每个候选节点保留 `runner_incompatible`、指标缺失/过期、容量不足和各资源阈值超限等稳定阻塞原因。仓储在真正写 assignment 前使用同一兼容性规则再次校验，Agent 领取后还会以不可变快照中的运行时要求做本地校验。

阈值由主平台启动配置统一提供，Lite 与 Full 使用相同领域算法：

```env
AUTOFORGE_SCHEDULER_MAX_CPU_PERCENT=85
AUTOFORGE_SCHEDULER_MAX_MEMORY_PERCENT=85
AUTOFORGE_SCHEDULER_MAX_LOAD_PER_CPU=1
AUTOFORGE_SCHEDULER_METRICS_MAX_AGE_SECONDS=45
```

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

`RunBatch`、`ExecutionRun`、`RunAttempt`、assignment 和 lease 都使用正整数版本。批次创建、调度、领取、完成、超时回收和取消在短事务中以当前版本做条件更新；版本冲突会中止事务，不以最后写入覆盖并发结果。批次每次状态变化同时追加不可变 `run_batch_status_events`，记录前后状态、变更后版本、原因和服务端 UTC 时间；从旧库升级时为已有批次写入 `history.baseline`，因此详情可以从创建或升级基线开始审计完整状态路径。

## 并发与双模式

- SQLite 在短写事务内重新读取 Runner、活动 attempt 和等待 run，使用条件更新防止重复分配；批次状态也使用版本条件写。
- PostgreSQL 按 Runner ID 固定顺序取得行锁，再重新执行同一准入规则和容量计算，避免并发批次超卖同一执行机。
- `busySlots` 与平台活动 attempt 可能描述同一工作，容量计算取二者最大值而不是相加，避免重复扣减。
- Full 在同一 PostgreSQL 事务中保存调度事实和 outbox，独立 Dispatcher 将消息幂等发布到 JetStream；SQLite 与 JetStream 运行相同的至少一次投递契约，Redis 不参与正确性判断。

## 失败重跑边界

`retryLimit` 表示首次执行之外允许的重跑次数。例如配置 2 时，attempt 1 和 attempt 2 失败后重新排队，attempt 3 失败后进入最终失败。Agent 完成上报在权威事务中固化终态、状态事件和下一次 attempt；重复或迟到上报不会覆盖新租约持有者的结果。

## 超时与恢复

创建批次时可配置 `queueTimeoutMs`、`claimTimeoutMs`、`executionTimeoutMs` 和 `uploadTimeoutMs`，入口分别限制在 7 天、1 小时、24 小时和 1 小时以内。所有 deadline 由控制面 UTC 时钟计算并持久化，恢复扫描不依赖 Web/worker 进程内定时器：

- queued run 越过排队期限后进入最终 `failed/timed_out`，原因码为 `QUEUE_TIMEOUT`；assignment 条件更新也检查排队期限，防止扫描前的竞态领取。
- pending assignment 越过领取期限后 attempt 使用 `ASSIGNMENT_CLAIM_TIMEOUT`，并按已固化重试策略回排或终结。
- 已领取 attempt 在上传阶段开始前使用 `EXECUTION_TIMEOUT`；lease 提前失效仍使用独立 `LEASE_EXPIRED`。
- Agent 完成进程执行后总会调用产物声明，零产物时发送空数组。服务端首次声明原子记录 `upload_started_at`，此后恢复扫描停止计算执行期限并改用 `UPLOAD_TIMEOUT`。

四类裁决都先条件写入权威状态和状态历史，再允许重复扫描返回零变更；迟到完成上报不会覆盖已确认的超时终态。
