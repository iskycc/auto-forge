# ADR 0003：Runner Protocol v1

- 状态：已接受
- 日期：2026-08-09

## 背景

平台已经可以注册 Runner、接收心跳和生成初始 `RunAttempt`，但没有 assignment 领取、租约或完成上报。协议必须同时服务 Lite 与 Full，并允许相邻 Agent/Server 版本兼容。

## 决策

1. 基线传输是 Agent 主动发起的 HTTPS JSON；领取使用有界长轮询。WebSocket 仅用于已实现的低延迟终端，不承担执行正确性。
2. 所有请求和响应携带 `schemaVersion: 1`。新增兼容字段必须可选；破坏性变更发布新的 schema 版本并明确拒绝不兼容客户端。
3. Runner 使用注册后签发的可撤销凭据。控制面按 Runner ID 与凭据摘要共同认证，并对请求体、频率和幂等键设限。
4. assignment 是已持久化的待领取执行规格；claim 原子地创建 lease。heartbeat 只表示节点活性，lease 才表示 attempt 的有效执行权。
5. lease 包含随机 token、版本、过期时间和续租时间。续租返回 `continue`、`cancel` 或 `drain` 指令；失去 lease 的 Agent 不得继续普通结果上报。
6. 完成上报以 `(attemptId, completionId)` 幂等。相同结果重复提交返回原确认，冲突终态返回稳定错误并写审计事件。
7. 日志块以 `(attemptId, stream, sequence)` 去重，只确认连续水位。产物先声明元数据和摘要，再获取单对象、短期、限大小上传目标。
8. Agent 重启后必须 reconcile 本地 attempt；服务端决定继续、停止、重传或清理，Agent 不自行重跑。

## 端点

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| `POST` | `/api/v1/runner-agents/{runnerId}/claims` | 长轮询并原子领取 assignment |
| `POST` | `/api/v1/runner-agents/{runnerId}/leases/{leaseId}/renew` | 续租并获取控制指令 |
| `POST` | `/api/v1/runner-agents/{runnerId}/reconcile` | 启动恢复协商 |
| `POST` | `/api/v1/run-attempts/{attemptId}/logs` | 幂等写入日志块并返回确认水位 |
| `POST` | `/api/v1/run-attempts/{attemptId}/artifacts` | 声明产物并获取受控上传目标 |
| `POST` | `/api/v1/run-attempts/{attemptId}/complete` | 幂等上报终态 |

日志、产物与完成端点还必须携带 `X-AutoForge-Runner-Id`，并用该 Runner 注册后凭据作为 Bearer token；控制面同时校验 Runner、attempt 和 lease 的归属关系。

## 确认和恢复顺序

调度消息在 assignment 持久化后确认；远程执行期间不持有队列 ack。完成结果、状态历史和重试决定在同一事务提交后，才向 Agent 确认完成。迟到结果不能覆盖新的有效 attempt。
