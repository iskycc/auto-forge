# ADR 0004：执行状态机与竞争裁决

- 状态：已接受
- 日期：2026-08-09

## 背景

批次、单次执行、尝试、assignment 和 lease 的生命周期存在重复投递、取消、超时、网络分区和迟到完成竞争。直接更新字符串状态会产生多个终态或重复重试。

## 决策

### ExecutionRun

```text
queued -> assigned -> running -> succeeded
   |          |          |  \-> failed
   |          |          |  \-> timed_out
   |          |          \----> cancelled
   |          \---------------> queued     （租约回收/可重试）
   \--------------------------> cancelled
```

### RunAttempt

```text
assigned -> running -> succeeded
   |          |  \----> failed
   |          |  \----> timed_out
   |          \-------> cancelled
   \------------------> cancelled
```

1. `RunAttempt` 的终态不可改变。`ExecutionRun` 只有当前有效 attempt 可以推进，旧 attempt 的迟到结果只写审计。
2. 状态更新携带期望版本并使用条件写。第一个成功写入终态的操作获胜；后续相同操作幂等返回，冲突操作返回领域错误。
3. 失败或超时后，当 `attemptNumber <= retryLimit` 时 `ExecutionRun` 回到 `queued`；超过上限进入 `failed`。取消、协议拒绝和输入校验失败不自动重试。
4. lease 过期由 Reconciler 条件更新。仍被有效续租的 lease 不得回收；回收后旧 token 失效。
5. `RunBatch` 状态从其 `ExecutionRun` 权威聚合，不由消息计数累加。任何 run 运行时为 `running`；全部终态后按结果计算 `succeeded`、`failed` 或 `cancelled`。
6. 排队、领取、执行和收尾超时使用服务端 UTC 截止时间持久化，进程重启后可以重新扫描。

## 后果

- 领域层暴露命名状态转换函数，适配器只执行条件写和事务，不自行发明迁移。
- 重复消息、HTTP 重试和 Agent 重传不能重复创建 attempt、分析事实或产物元数据。
- 所有竞争路径必须有确定性单元测试和 SQLite/PostgreSQL 集成测试。
