# 执行环境与版本快照

状态：项目级可复用执行环境、不可变变量/密文引用版本、批次版本引用、执行快照、按 lease 领取密文和执行前逐项预检已在 Lite/Full 实现。

## 模型

`ExecutionEnvironment` 保存项目、名称、说明、启停状态、当前版本号和用于条件写的 `revision`。`ExecutionEnvironmentVersion` 是不可变的非密文变量与密文版本引用集合；修改变量或重新绑定密文只新增版本，不覆盖旧行。项目内规范化名称唯一，停用环境不能创建新批次，但历史版本和引用它的批次继续可读。

环境管理 API 位于 `/api/v1/execution-environments`，读取使用 `environment.read`，创建、编辑和启停使用 `environment.manage`。列表和详情在仓储查询中应用项目作用域；跨项目 ID 返回不存在。审计只包含环境 ID、版本号、变量/密文引用数量和变更类别，不记录变量值。

## 执行密文

`ExecutionSecret` 只公开项目、名称、说明、状态、当前版本号、revision 和时间等元数据。`/api/v1/execution-secrets` 的创建与轮换请求接收一次明文值，响应、列表、详情和审计均不返回该值。值使用首次启动生成并保存在私有 `platform.json` 中的主密钥通过 AES-256-GCM 加密，密文版本 ID 作为 AAD 用途绑定；SQLite/PostgreSQL 只保存加密结果。主密钥不可读或配置校验失败时，平台拒绝启动，不会退化为明文。

环境版本保存 `{ name, secretId, secretVersionId }`，不会复制密文。创建环境版本时，服务端在同一项目内解析密文的当前启用版本；轮换密文不会改写已有环境版本，只有显式更新绑定才引用新版本。停用密文后不能创建新环境引用、创建新批次或由 Agent 领取；历史元数据和引用仍可审计。

## 批次固化

创建批次可以提交 `environmentVersionId`，也可暂时使用兼容的内联非密文变量，两者不能混用。服务端确认该版本属于批次项目、环境和所引用密文均处于启用状态，然后将排序后的非密文变量与密文版本引用复制到批次，同时保存环境与版本 ID。含密文批次只允许选择上报 `secrets:on-demand-v1` capability 的 Runner；调度时会再次过滤不再具备该能力的节点。assignment 从批次快照生成，后续环境编辑、密文轮换或停用不会改变已创建批次、重试或历史执行。

SQLite 与 PostgreSQL 分别通过 `0013_execution_environments.sql`/`0012_execution_environments.sql` 增加环境表，并通过 `0014_execution_secrets.sql`/`0013_execution_secrets.sql` 增加密文表与引用列。升级为已有环境版本和批次补入空引用数组，不把旧的内联快照反推成共享环境，也不修改其执行语义。

## Lease 领取边界

`ExecutionSpec` 只包含密文版本引用。Agent 领取 assignment 后，使用 Runner 身份、attempt ID、有效 lease token 和请求 ID 调用 `POST /api/v1/run-attempts/{attemptId}/secrets`。控制面核对 Runner、attempt、未过期 lease、项目、密文状态及精确版本后才解密；成功解密后写入 `execution_secret.access` 审计，详情仅含密文 ID 和数量。无效 lease、停用密文或解密失败均不产生成功访问审计。

Agent 校验返回名称必须与 assignment 完全一致且总大小有界，将值标为敏感变量后只合并到本次内存中的执行规格和子进程环境。持久化 claim、`ExecutionSpec`、日志、产物元数据与磁盘 spool 都不保存明文；服务端日志入口也使用对应密文值再次脱敏。Go 字符串不能保证主动清零，因此当前安全边界是受控 Agent 进程内存与子进程生命周期，不宣称具备硬件密钥隔离。

## 执行前预检

`POST /api/v1/run-batches/preflight` 与正式批次创建复用 `RunBatchSchedulingService` 的同一预检规则。结构不完整时也返回 `{ ready, blockers[] }`，不会只报告第一个错误；每个 blocker 具有稳定 `code`、类别、消息和可选字段路径、Runner、用例或来源 ID。页面保留已填内容并逐条显示，只有 `ready=true` 才提交创建。

预检覆盖必需批次参数和超时范围、普通/密文变量名与重复项、环境项目/状态、每个密文版本可用性、Runner 协议/平台/标签/capability、Java/TestNG 版本、来源 JAR 状态/摘要/大小和对象存在性，以及 JAR 是否超过当前固定 attempt 磁盘限制。任务策略中的参数模板与用例参数在服务端合并并固化到执行快照；策略并发度、重试、超时、Runner 标签和产物规则也由同一预检及调度路径校验，不能由浏览器自行声明为已满足。

预检不把 Runner 当前离线、指标暂缺或暂时过载视为配置错误，这些状态允许批次进入持久队列并由资源调度器恢复。对象、密文或 Runner 状态仍可能在预检后改变，因此调度写入、assignment claim、JAR 下载和密文领取继续各自执行权威复核；预检不是安全授权的替代品。
