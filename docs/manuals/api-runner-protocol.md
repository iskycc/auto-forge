# HTTP API 与 Runner Protocol v1

所有业务端点位于 `/api/v1`。浏览器使用 HttpOnly/SameSite 会话 Cookie 和同源 CSRF 检查；
自动化使用 `Authorization: Bearer af_api_…` 服务账号令牌。权限由稳定目录校验，项目资源同时做
作用域过滤。Runner 使用独立可轮换凭据，不能作为用户/API 令牌使用。

写请求使用 JSON schema 和请求体上限；幂等操作要求 `Idempotency-Key` 或协议内稳定 request ID。
列表使用有界 `limit` 与不透明 `cursor`。错误格式固定为：

```json
{"error":{"code":"STABLE_MACHINE_CODE","message":"可操作说明","requestId":"trace-id"}}
```

Runner Protocol v1 包含注册、heartbeat、claim、lease renew、输入领取、日志、产物、完成、
reconcile 和凭据轮换。产品级密文领取端点已经移除；历史 v1 执行快照中的 `environment` 与
`secretReferences` 仅保留空值解析兼容，新任务携带非空值会被 Agent 拒绝。每个 DTO 携带
`schemaVersion: 1`；不兼容版本明确拒绝。每条 assignment
关联 attempt、稳定 claim request ID 和短期 lease；心跳不延长 lease。日志以
`(attemptId, stream, sequence)` 去重，完成以 completion ID 与结果摘要幂等。

Runner 端点均执行 Bearer 身份校验、协议 schema、流式请求体限制和按 Runner/操作限速。claim、
完成、日志、产物和 reconcile 的稳定 ID 提供重放安全；同 ID 不重复产生副作用，冲突内容返回
稳定错误。对象下载/上传必须同时满足 Runner 身份、有效 lease、执行快照声明、大小与 SHA-256。

契约源位于 `packages/contracts/src/execution.ts`、`management.ts` 和 `jobs.ts`；控制面解析与
错误分类位于 `packages/runner-sdk`。示例必须通过这些 schema 构造，禁止维护无版本约束的第二份
DTO。版本兼容见根 [COMPATIBILITY.md](../../COMPATIBILITY.md)。
