# 批跑动态调度

状态：资源感知调度、Lite/Full 持久化、批跑页面和初始 `RunAttempt` 分配已实现；Agent claim、lease、实际 TestNG 执行、结果上报和失败重跑触发尚未实现。

## 输入与快照

管理员创建批次时必须选择一个 `CaseSuite`、至少一台 Runner、失败重跑次数和可选的非密文测试环境变量。平台在同一事务中保存：

- `CaseSuite` ID、名称与版本；
- 每个启用 `CaseDefinition` 的 ID、当前版本、类名和显示名；
- 允许参与本批次的 Runner ID；
- `retryLimit` 和按名称排序的环境变量快照；
- 一个用例对应一个 `ExecutionRun`，一次实际调度对应一个 `RunAttempt`。

当前环境变量按明文业务数据保存，页面和 API 明确禁止把密码、令牌或其他密文放入其中。密文引用必须等平台密钥管理和 Agent 注入协议落地后再实现。

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
2. 心跳在线，资源快照未超过配置的最长年龄；
3. `maxConcurrency - max(Agent busySlots, 平台活动 RunAttempt 数) > 0`；
4. CPU 使用率不超过阈值；
5. 内存使用率不超过阈值；
6. `loadAverage1m / logicalCpuCount` 不超过阈值。

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

## 并发与双模式

- SQLite 在短写事务内重新读取 Runner、活动 attempt 和等待 run，使用条件更新防止重复分配。
- PostgreSQL 按 Runner ID 固定顺序取得行锁，再重新执行同一准入规则和容量计算，避免并发批次超卖同一执行机。
- `busySlots` 与平台活动 attempt 可能描述同一工作，容量计算取二者最大值而不是相加，避免重复扣减。
- 当前 Full 调度事实只写 PostgreSQL；NATS 调度消息会在 assignment/dispatcher 阶段通过 outbox 接入，Redis 不参与正确性判断。

## 失败重跑边界

`retryLimit` 表示首次执行之外允许的重跑次数。例如配置 2 时，attempt 1 和 attempt 2 失败后重新排队，attempt 3 失败后进入最终失败。该边界规则已经由领域测试固化，但本阶段没有结果上报端点，因此不会伪造失败或自动创建后续 attempt。
