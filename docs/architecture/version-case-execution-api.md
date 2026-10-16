# 版本单用例执行 API 与执行记录分类

每个项目版本通过固定地址创建一次单用例执行，不依赖浏览器当前选中范围：

```text
POST /api/v1/projects/{projectId}/versions/{versionId}/case-executions
POST /api/v1/projects/{projectId}/versions/{versionId}/stages/{stageId}/case-executions
GET  /api/v1/projects/{projectId}/versions/{versionId}/case-executions/{batchId}
```

调用采用现有 `Authorization: Bearer af_api_…` 服务账号令牌，或已登录浏览器的同源会话。
创建需要当前项目 `run.create`；查询需要 `run.read`；读取返回的日志 API 需要 `log.read`。
令牌权限与账号、项目授权取交集，显式无效令牌不会回退到浏览器身份。拉起人来自认证身份，不能由请求指定。
与公开 DDT 查询不同，此执行 API 需要上述认证和权限。

## 必填参数

路径中的 `projectId`、`versionId` 指定项目版本；请求体默认仅需用例定位与被测环境 IP：

| 参数                   | 说明                                                                                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `className` / `caseId` | 二选一。普通用例推荐传完整类路径 `className`（如 `com.example.CheckoutTest`）；DDT 传原始业务 `caseId`，支持中文。根据字段自动识别类型，不需要 `kind` 或 `selection`。 |
| `environmentIp`        | 单个被测环境 IPv4 或 IPv6 地址。自动用于本次 Adapter 环境地址。                                                                                                        |

普通用例最小请求：

```json
{ "className": "com.example.CheckoutTest", "environmentIp": "10.0.0.21" }
```

DDT 最小请求：

```json
{ "caseId": "订单支付_001", "environmentIp": "10.0.0.21" }
```

## 默认行为

- 普通用例和 DDT 均默认启用 Adapter，使用当前项目版本已配置的运行资产；需预先配置完整依赖包，缺失时沿用现有执行校验明确拒绝。
- Suite Name 默认取项目名，Test Name 默认取“版本名 - 测试阶段名”。阶段来自最终定位到的用例范围，API 与已有任务/快捷执行表单复用同一命名实现。
- 省略执行资源时，从在线、身份有效、协议/平台兼容且具备所需标签和能力的执行机中形成最多 64 台的候选快照，再由原有资源感知调度器选择节点。普通用例需要 Adapter 能力，DDT 还需中文 CaseID / DDT API 地址能力。读取采用主键游标分页，不受列表页首屏数量影响；无合适节点返回 `RUNNER_AUTO_SELECTION_EMPTY`，不创建执行记录。忙碌节点仍可进入候选池，按原有并发/负载/排队规则等待。
- 执行资源、名称和环境地址写入本次快照，后续重试、恢复和日志诊断重跑沿用已有规则；不读取调用者浏览器的执行偏好。

## 选填参数

| 参数                                                                                | 省略行为与用途                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| URL 中的 `/stages/{stageId}`                                                        | 默认自动定位。普通用例按完整类路径、DDT 按完整 CaseID 在有效阶段中查找；使用兼容平台 ID 时直接读取所属阶段。相同类路径或 CaseID 在多个有效阶段存在时，需要使用带阶段的 URL；请求体不接受 `testStageId`。 |
| `caseDefinitionId`                                                                  | 兼容普通用例的平台 ID，可替代 `className` 作精确定位；`className`、`caseDefinitionId`、`caseId` 只能提供一个。普通调用无需先查询平台 ID。                                                                |
| `execution.runnerIds` / `execution.runnerGroupId`                                   | 可显式限制执行机/机组，二者不能同时提供；省略则自动选取。显式资源继续使用原有校验与排队行为。                                                                                                            |
| `execution.adapter.suiteName`、`execution.adapter.testName`                         | 可覆盖默认名称；空白值仍使用默认名称。                                                                                                                                                                   |
| `execution.adapter.enabled`                                                         | 默认 `true`；普通用例可显式关闭，DDT 不允许关闭。环境地址始终来自必填的 `environmentIp`，不接受第二份 `environmentAddresses` 覆盖。                                                                      |
| `execution.retryLimit`、`execution.retryMode`                                       | 默认不重跑（`retryLimit: 0`），重跑方式默认 `round`。                                                                                                                                                    |
| `execution.delaySeconds`                                                            | 默认立即进入调度，可设置延迟秒数。                                                                                                                                                                       |
| `execution.priority`                                                                | 默认 0，可指定 -100 到 100。                                                                                                                                                                             |
| `execution.queueTimeoutMs`、`execution.claimTimeoutMs`、`execution.uploadTimeoutMs` | 分别默认 86,400,000、300,000、600,000 毫秒；不属于用例进程执行超时。                                                                                                                                     |
| `execution.artifactPatterns`                                                        | 沿用已有单用例采集规则，受平台产物采集开关约束。                                                                                                                                                         |

普通用例按完整 Java 类路径精确匹配，区分大小写；不按显示名称、简单类名、方法名、子串或通配符推测。嵌套类保留 `$`，例如 `com.example.CheckoutTest$Nested`。
同一版本不同有效阶段存在相同类路径或 DDT CaseID 时，分别返回 HTTP 409、`CASE_CLASS_SCOPE_CONFLICT` 或 `DDT_CASE_SCOPE_CONFLICT`，提示使用带阶段的 URL，不随机选择第一条，也不创建执行记录：

```text
POST /api/v1/projects/项目ID/versions/版本ID/stages/阶段ID/case-executions
```

正文仍只需 `className`（或 DDT 的 `caseId`）与 `environmentIp`。指定阶段必须属于路径版本且有效；跨项目/版本、归档或用例阶段不匹配时拒绝。
类路径查找仅考虑未归档定义及已就绪、未归档的同项目来源，停用定义继续交给原有执行预检明确拒绝；未匹配返回 `CASE_DEFINITION_NOT_FOUND`。
如果历史数据在同一阶段有多条相同类路径定义，返回 `CASE_CLASS_SCOPE_CONFLICT`，提示整理重复用例或使用兼容的 `caseDefinitionId` 精确指定。
`caseDefinitionId` 是平台普通用例标识，`caseId` 是 DDT 原始业务 CaseID，不是 DDT 内部 ID。
DDT 使用正式库及既有 SR 执行类关联，不读取个人调试库。不接受手工参数覆盖、独立执行超时、环境变量或密文。
版本、阶段、用例、SR 关联、运行资产及执行机能力在权威执行路径重新检查；停用、归档或跨范围资源不能执行。

成功返回 HTTP 201：

```json
{
  "batchId": "新批次ID",
  "sequenceNumber": 123,
  "status": "running",
  "statusUrl": "/api/v1/projects/项目ID/versions/版本ID/case-executions/新批次ID",
  "recordsUrl": "/execution-records?view=single"
}
```

客户端使用相同身份 GET `statusUrl`，建议间隔至少两秒。响应包含批次生命周期 `status`、单用例的
执行结果和最新 attempt，以及创建 attempt 后可读取的鉴权 `logsUrl`。批次生命周期不能代替用例结果：
判断用例通过/失败读取 `execution.status`、`execution.attempt.outcome` 与 `resultCode`。
每次成功 POST 都创建新执行记录；查询进度使用 GET，不重复 POST。
未分配时 attempt 和日志地址为空；接口保留稳定错误码及 request ID，不生成新的匿名执行权限。

执行记录页提供“任务执行”“单用例执行”“执行 API”三个标签。任务保留原来的表格、列宽调整、详情、公开、分析及终止操作。
单用例视图直接展示结果、拉起人和日志按钮，结果在独立弹框显示，不提供批次详情按钮；活动记录每三秒刷新，隐藏页面暂停刷新，并保留手动刷新入口。
状态以当前 ExecutionRun 为准，避免重试排队或取消时仍显示上一轮失败；结束后的超时明细读取最新 attempt。
API 说明随当前项目版本生成，提供普通/DDT 调用示例。标签和筛选进入 URL，分页保留当前分类。

Lite/Full 根据已持久化的 `batch_kind` 与 `single:` 标识在 SQL 分页前分类，不在前端过滤分页结果；
原有单用例、调试与 API 执行进入单用例视图，日志诊断重跑继续保留在原日志历史，最后失败批次重跑仍属于任务执行。
原有列表 API 不传 `executionKind` 时保持兼容，调用者可显式传 `task` 或 `single` 分类读取。
单用例页只批量读取当前最多 200 个批次对应的用例摘要与最新 attempt，排除 DDT 正文和 TestNG 报告。
列表摘要 SQL 通过既有隔离只读进程执行。普通类路径与 DDT 自动定位在调度工作线程中分别复用既有层级/类路径索引和阶段/CaseID 索引；类路径每阶段只投影最多两个 ID，DDT 只读摘要，发现第二个匹配即拒绝；不批量读取全部用例或 DDT 正文，不增加迁移。创建快照和首次调度也沿用调度工作线程，不回到 Web 事件循环。

复用现有双数据库、持久调度队列、对象存储和 Runner 协议；不新增迁移、配置、生产依赖或外部服务。

## 验证与兼容边界（2026-10-16）

默认请求仅含普通用例完整类路径（DDT 使用业务 CaseID）与被测环境 IP。测试覆盖参数互斥、IPv4/IPv6、类路径大小写及嵌套类、缺失/停用/归档资源、跨范围拒绝、同名阶段歧义、阶段 URL、默认 Adapter 名称、自动节点分页、项目权限和工作线程隔离。
十二文件 174 项定向测试通过；真实 SQLite/PostgreSQL 三文件 29 项回归通过，验证数据库分页前分类、只读取当前页摘要、类路径范围隔离及至多两个匹配 ID 的边界。SQLite 查询计划同时约束项目、版本、阶段和类路径四个字段；不添加无业务需要的 ID 排序，避免退化成阶段扫描。

最终生产构建下普通用例 API 与中文 DDT 两项 Lite Playwright 场景通过，包含类路径/IP 最小执行、平台 ID 兼容、DDT 默认配置、同名类跨阶段拒绝及 URL 指定阶段后完成执行。
执行记录按任务/单用例分别展示，单用例结果、日志、终止及权限拒绝均有浏览器验证；既有全局单用例执行和活动 501 用例批次日志重跑也已回归。
实际查看 1024×768、1536×960 的浅色/深色视图、结果弹框和 API 示例，检查字号、标签、控件对齐、换行、滚动边界与表格布局，未发现新增变形、遮挡或溢出。

格式、许可证、受影响文件 ESLint、应用/数据库/Web/测试类型、E2E 覆盖矩阵与 Web 生产构建均通过。检查使用临时本地数据库及协议模拟执行机，高负载步骤串行限额；本地验证不替代完整 Full 部署、真实 Java Agent 和离线发布验收。
同一 Runner Protocol、队列与对象存储路径继续适用于 Lite/Full；无新增迁移、配置或生产依赖。正式版本的全矩阵验收由发布流水线执行。

主要验证命令如下，数据库回归需先配置独立临时 PostgreSQL 的 `AUTOFORGE_TEST_POSTGRES_URL`：

```sh
pnpm format:check
pnpm --filter @autoforge/application typecheck
pnpm --filter @autoforge/db typecheck
pnpm --filter @autoforge/web typecheck
pnpm exec tsc --noEmit -p tsconfig.tests.json
pnpm test:e2e:matrix
pnpm --filter @autoforge/web build
pnpm exec vitest run \
  packages/contracts/src/version-case-execution.test.ts \
  packages/application/test/single-ddt-run.test.ts \
  packages/application/test/resolve-version-execution-class.test.ts \
  packages/application/test/automatic-execution-runners.test.ts \
  packages/application/test/single-execution-page.test.ts \
  apps/web/src/lib/work-dispatch.test.ts \
  apps/web/src/lib/authorization-paths.test.ts \
  apps/web/src/lib/case-suite-adapter-defaults.test.ts \
  apps/web/src/lib/run-batch-filter.test.ts \
  apps/web/src/lib/case-execution-presentation.test.ts \
  apps/web/server/worker-pool.test.ts \
  apps/web/src/components/ui-usage.test.ts --maxWorkers=1 --no-file-parallelism
pnpm exec vitest run \
  packages/db/test/class-name-execution.integration.test.ts \
  packages/db/test/runner-page.integration.test.ts \
  packages/db/test/attempt-log-snapshot.integration.test.ts \
  --maxWorkers=1 --no-file-parallelism
pnpm exec playwright test tests/e2e/ddt-management.spec.ts tests/e2e/single-case-run.spec.ts \
  --grep 'version execution API authenticates|public logs rerun failed Chinese DDT cases' \
  --workers=1
```

本地证据位于 `/var/tmp/autoforge-version-api-class-name-20261016/`，不进入发布资产。
