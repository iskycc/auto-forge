# DDT 管理与 ddt-insight 融合说明

AutoForge `1.1.0` 将 `iskycc/ddt-insight` 在提交 `705f552` 中的差异化数据驱动测试能力并入主平台。融合遵循一个原则：DDT 用例是新的用例资产形态，但身份、权限、项目层级、审计、对象存储、异步任务和运维事实仍由 AutoForge 的共享核心负责。

## 数据作用域与身份

每条 DDT 用例都绑定 `projectId + projectVersionId + testStageId`。`CaseID` 只在这个完整作用域内唯一；列表、详情、历史、模板、回收站、导入任务、导出和 `/api/v1/ddt/**` 全部在服务端重复校验这个层级，不能通过切换前端上下文读取或修改其他版本的数据。

读取使用 `case.read`，编辑、批量操作、模板、导入和回收站操作使用 `case.manage`。浏览器会话沿用同源 CSRF 保护；服务账号通过现有 `af_api_` 令牌和相同的项目权限访问 `/api/v1/ddt/**`。所有写操作进入 AutoForge 审计日志，记录友好的动作名、项目、版本、阶段和有界计数，不保存表格内容或令牌。

## 已融合能力

| ddt-insight 能力                           | AutoForge 1.1.0 落点                                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| 动态字段、全局 CaseID、srNum 分组          | “用例管理 → DDT 管理”；动态字段详情、前缀/分组/字段条件筛选；任务树按 SR 展开                                                  |
| `data` 普通表格、`step1…stepN` 用户旅程    | 共享 DDT 领域模型；身份字段自动同步到每个 Step                                                                                 |
| XLSX/XLS/XLSB/CSV/ODS                      | 离线内置 `@autoforge/ddt-import` 解析器                                                                                        |
| ZIP、中文文件名、常见中文 CSV 编码         | 有界 ZIP64/CRC/路径校验和 UTF-8、UTF-16、GB18030、Windows-1252 解码                                                            |
| 局部预检和覆盖/跳过/报错策略               | 导入浮窗逐文件预检；确认后进入持久异步任务                                                                                     |
| 导入取消、恢复、来源追踪、任务 CaseID 导出 | Lite SQLite 队列或 Full outbox/JetStream；原始上传保存在 ObjectStore；文件写入与成功状态同事务；可导出每次任务的 CaseID 与结果 |
| 分页、业务分组、动态字段高级搜索           | 有界游标页、srNum 排名、JSON 动态字段操作符；不会一次渲染全部 DOM                                                              |
| 单条/批量更新、删除和导出                  | 修订号冲突保护、最多 5,000 条单次变更、XLSX 导出                                                                               |
| srNum 字段模板                             | 当前版本/阶段内的必填、类型、枚举和默认值规则                                                                                  |
| 永久历史与恢复                             | 修改前后快照和字段差异；恢复会生成新的历史记录，不覆盖旧记录                                                                   |
| 回收站恢复与永久清除                       | 软删除快照、CaseID 冲突保护、明确二次确认                                                                                      |
| 仪表盘                                     | 总量、业务组、来源、用户旅程、当日变化和近七日图表                                                                             |
| CoTest `classDataFile` 执行                | DDT 用例批量绑定同版本、同阶段的普通 TestNG 类；批次为每个 CaseID 固化独立 JSON 数据文件                                       |
| Open API 与示例                            | 融入已认证、项目隔离的 `/api/v1/ddt/**`，不保留匿名全局接口                                                                    |

## 经确认不重复迁移的能力

以下功能不是遗漏，而是已经由 AutoForge 提供覆盖范围更完整的实现，因此不会复制第二套页面、表或身份事实：

- 本地用户、会话、LDAP、角色与权限：复用统一身份/RBAC、LDAPS/StartTLS、组映射、锁定和会话撤销。
- 审计：复用 Lite/Full 共享的不可变审计事件及项目权限过滤。
- 备份恢复：复用数据库与对象目录一致性备份、Full 依赖恢复和升级回滚手册。
- 系统诊断：复用 liveness/readiness、平台诊断、容量和依赖检查。
- 独立 API Key：复用服务账号/API Token 的权限范围、到期和撤销能力。

这避免了同一个人、权限或备份状态在两个子系统中产生冲突。若上游以后增加这些平台能力的差异行为，应先扩展 AutoForge 的共享端口，而不是恢复一套 DDT 专用实现。

## 导入、恢复与存储

上传边界为单文件 128 MiB、单请求 200 个文件、总计 512 MiB、ZIP 10,000 个目录项；压缩包内容还受单文件和总解压大小约束。文件名只用于展示，ObjectStore 键由项目、任务、服务端 ID 和 SHA-256 构造。原始上传作为来源证据保留，随项目备份；业务记录与对象清理不假设跨存储事务。

Lite 的预检、确认和导入状态保存在 SQLite，确认事务同时写入 SQLite 持久队列。Full 的确认事务同时写 PostgreSQL outbox，再由 relay 发送到 JetStream。工作器续租队列消息；若进程中断，重投可重新领取 `running` 任务，只处理 `valid/importing` 文件。单个文件的用例写入、覆盖历史、CaseID 结果和文件成功状态在同一数据库事务内完成，因此恢复不会把半个文件误报为成功。

## DDT 执行快照

DDT 数据本身不是 Java class。管理员在 DDT 列表中选择一条或多条 CaseID，批量绑定当前
`projectId + projectVersionId + testStageId` 下权威、可用来源中的普通 TestNG 类。平台保存的是
`CaseDefinition` 标识，不接受任意 JAR 路径；类被停用、归档或移出当前版本后，任务预检会明确
阻止执行。DDT 用例可与普通用例加入同一个任务，任务详情将普通用例按包路径、DDT 用例按 SR
分别展示。

`case_suite_ddt_items` 对 DDT 资产使用限制删除。回收操作会先检查任务成员关系，并以
`DDT_CASE_IN_USE` 拒绝仍在任务中的 CaseID；用户必须通过任务成员接口移除，使任务版本快照记录
这次范围变化后才能删除资产，不能依赖外键级联静默改写任务。

创建批次时，控制面把每条 DDT 用例的动态字段固化为独立 UTF-8 JSON 快照，并保存字节数和
SHA-256。`ExecutionRun.caseDefinitionId` 继续标识 DDT 资产，`executionCaseDefinitionId` 与
`caseVersion` 标识真正加载的 TestNG 类版本。assignment 只携带受租约保护的 `class-data` 输入
描述；Runner 从控制面下载到本次执行工作目录，经大小和摘要复核后调用现有 Adapter 的
`--class-data`。不同 CaseID 使用包含 `executionRunId` 的目标路径，不会共享或串用数据文件。
派生的单用例诊断重跑和最后失败重跑继续继承原批次中的不可变 JSON、类版本与 Adapter 快照。

Lite 将映射、任务成员与执行快照持久化在 SQLite，JSON 由已认证的控制面输入接口直接读取；
Full 使用同一领域和协议语义持久化到 PostgreSQL。两种模式都不要求 Runner 访问数据库、MinIO
或本地数据目录，也没有新增运行时公网依赖。

## API 概览

所有请求都必须带 `projectId`、`projectVersionId`、`testStageId` 查询参数：

- `GET /api/v1/ddt/dashboard|groups|cases|templates|recycle|imports`
- `GET/PATCH/DELETE /api/v1/ddt/cases/{CaseID}`
- `GET /api/v1/ddt/execution-classes`
- `POST /api/v1/ddt/cases/search|bulk-update|bulk-delete|execution-class`
- `GET /api/v1/ddt/cases/{CaseID}/history`
- `POST /api/v1/ddt/cases/{CaseID}/history/{historyId}/restore`
- `POST /api/v1/ddt/imports/preview`（`multipart/form-data` 的 `files`）
- `POST /api/v1/ddt/imports/{jobId}/confirm|cancel`
- `GET /api/v1/ddt/imports/{jobId}/case-ids`
- `POST/PATCH/DELETE /api/v1/ddt/templates/{templateId?}`
- `POST/DELETE /api/v1/ddt/recycle/{recycleId}/restore?`
- `GET/POST /api/v1/ddt/export`
- `POST/DELETE /api/v1/case-suites/{suiteId}/ddt-cases`

API 响应继续使用 AutoForge 的稳定错误码、`requestId`、游标分页和显式 DTO；不会返回 ORM 行或对象存储凭据。
