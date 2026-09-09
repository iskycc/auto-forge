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
| 局部预检和覆盖/跳过/报错策略               | 导入浮窗逐文件预检；重复列在弹窗中对照内容后改名保留或整列删除并再次预检；确认后进入持久异步任务                               |
| 导入取消、恢复、来源追踪、任务 CaseID 导出 | Lite SQLite 队列或 Full outbox/JetStream；原始上传保存在 ObjectStore；文件写入与成功状态同事务；可导出每次任务的 CaseID 与结果 |
| 分页、业务分组、动态字段高级搜索           | 有界游标页、srNum 排名、JSON 动态字段操作符；不会一次渲染全部 DOM                                                              |
| 单条/批量更新、删除和导出                  | 修订号冲突保护、最多 5,000 条单次变更、XLSX 导出                                                                               |
| srNum 字段模板                             | 当前版本/阶段内的必填、类型、枚举和默认值规则                                                                                  |
| 永久历史与恢复                             | 修改前后快照和字段差异；恢复会生成新的历史记录，不覆盖旧记录                                                                   |
| 回收站恢复与永久清除                       | 软删除快照、CaseID 冲突保护、明确二次确认                                                                                      |
| 仪表盘                                     | 总量、业务组、来源、用户旅程、当日变化和近七日图表                                                                             |
| CoTest `classDataFile` 执行                | SR 统一关联同版本、同阶段候选范围内的 TestNG 类；批次为每个 CaseID 固化独立 JSON 数据文件                                      |
| Open API 与示例                            | 融入已认证、项目隔离的 `/api/v1/ddt/**`，不保留匿名全局接口                                                                    |

## 用例工作台布局

“用例”页按 [ddt-insight `705f552` 的 CaseWorkspace](https://github.com/iskycc/ddt-insight/blob/705f552ab77be489186f47f95088c071fdf954b4/components/workspace-client.tsx)
采用左右分栏。左侧集中 CaseID 搜索、srNum 分组、高级字段筛选和可勾选的用例导航；右侧常驻
当前用例的来源、分组、修订、更新时间、执行类、字段卡片及历史。项目、版本与阶段沿用顶栏，
DDT 页不再重复展示 TestNG 的目录范围说明。列表可收起、拖动分隔线或用左右方向键调宽，双击
分隔线或按 Home 恢复默认宽度；列表内用 ↑/↓ 或 J/K 切换已加载用例。

用例列表默认随工作区宽度伸缩，拖动后的偏好以比例保存，实际宽度受 200–440px 和工作区 40% 上限
共同约束。分隔线的无障碍数值同步实际宽度与当前上限。工作区通过 ResizeObserver 与窗口 resize
合并测量可用宽高，扣除真实顶部内容和页底间距；隐藏的 Tab 不覆盖已保存布局，重新展开后重新测量。
高度至少保留 320px，极矮窗口允许页面滚动；窗口变化不重新请求用例正文或统计数据。
高级筛选浮层按触发按钮下方的剩余空间限制高度，字段与匹配方式选项在浮层内滚动，避免小窗口裁切。

首次进入读取 60 条摘要，只加载当前用例的正文和历史；点击“加载更多”继续读取下一游标窗口，
未选择的用例不预取正文。列表和详情独立滚动，快速切换会取消旧详情请求，旧响应不得覆盖新的
选择。筛选条件写入 `ddtQuery`、`ddtGroup`、`ddtField`、`ddtOperator`、`ddtValue` URL 参数，
刷新与浏览器前进后退可以恢复筛选；有筛选的链接通过 `ddtView=cases` 直接进入用例视图。
现有浏览器摘要缓存与后台统计快照保持复用；统计请求独立完成，不阻塞列表读取或用例保存反馈。

普通字段以卡片展示，支持单字段复制、编辑及文本/数字/布尔/空值类型；整份 JSON 编辑保留，
便于新增或删除字段。用户旅程仅展示所选 Step，身份字段修改复用共享领域规则同步全部步骤。
保存继续提交 `expectedRevision`，并发冲突保留草稿并使用平台统一提示。点击其他用例、筛选、
DDT 功能页签或勾选批量操作前，未保存的编辑需明确放弃；保存期间禁止这些切换。勾选用例后，
右侧切换为所选范围的批量操作区，继续提供修改、导出、回收和加入任务。

Lite 动态字段筛选修正为 SQLite 的点号加带引号对象键路径，并以参数绑定传入；中文、点号、括号、
引号和反斜杠不会被当作嵌套路径。采用 [SQLite JSON 路径语法](https://www.sqlite.org/json1.html#path_arguments)，
通过同一筛选契约验证 SQLite/PostgreSQL 的字面字段匹配。

该调整不修改数据库 schema、API、Runner Protocol 或离线依赖，Lite/Full 使用同一页面和应用用例。

## 经确认不重复迁移的能力

以下功能不是遗漏，而是已经由 AutoForge 提供覆盖范围更完整的实现，因此不会复制第二套页面、表或身份事实：

- 本地用户、会话、LDAP、角色与权限：LDAP 配置和鉴权字段复刻 DDT Insight，复用统一身份/RBAC、LDAPS、锁定和会话撤销；Group 只作为用户资料，不映射权限。
- 审计：复用 Lite/Full 共享的不可变审计事件及项目权限过滤。
- 备份恢复：复用数据库与对象目录一致性备份、Full 依赖恢复和升级回滚手册。
- 系统诊断：复用 liveness/readiness、平台诊断、容量和依赖检查。
- 独立 API Key：复用服务账号/API Token 的权限范围、到期和撤销能力。

这避免了同一个人、权限或备份状态在两个子系统中产生冲突。若上游以后增加这些平台能力的差异行为，应先扩展 AutoForge 的共享端口，而不是恢复一套 DDT 专用实现。

## 导入、恢复与存储

上传边界为单文件 128 MiB、总计 512 MiB、ZIP 10,000 个目录项；单次请求的上传文件数量和单个 ZIP
内可导入表格数量由持久化平台配置分别控制，新安装默认均为 200，可配置范围均为 1–10,000。Web
请求入口、应用服务和隔离解析线程在每次新导入时读取当前配置，保存后无需重启；Lite 与 Full 共享
相同校验，Full 独立 worker 也从同一配置文件读取当前值。压缩包内容仍受单文件和总解压大小约束。
文件名只用于展示，ObjectStore 键由项目、任务、服务端 ID 和 SHA-256 构造。原始上传作为来源证据
保留，随项目备份；业务记录与对象清理不假设跨存储事务。

Lite 的预检、确认和导入状态保存在 SQLite，确认事务同时写入 SQLite 持久队列。Full 的确认事务同时写 PostgreSQL outbox，再由 relay 发送到 JetStream。工作器续租队列消息；若进程中断，重投可重新领取 `running` 任务，只处理 `valid/importing` 文件。单个文件的用例写入、覆盖历史、CaseID 结果和文件成功状态在同一数据库事务内完成，因此恢复不会把半个文件误报为成功。

表格列名按大小写不敏感规则判重。发生冲突时，预检任务在 `uploads_json` 中保存文件、ZIP 条目、
Sheet、零基列位置、建议名称、整列非空数量和最多 8 个、单值最多 256 字符的非空内容样例。页面并排
展示冲突列，提供全部/单组建议改名和“仅保留此列”快捷操作，也允许逐列改名保留或删除整列；每组
至少保留一列，`CaseID`/`srNum` 仍须保留一个规范列名。ZIP 中每个表格独立产生有效、冲突或失败结果，
冲突不会吞掉同一压缩包中的有效/损坏条目，页面同时展示压缩包名和内部路径。处理请求直接读取
ObjectStore 中的原始文件并原子替换同一个预检任务的逐文件结果，不重复上传或创建遗留任务；选择
随任务保存，后台 Worker 再次解析时使用完全相同的保留/删除结果，因此预检结果不会与实际导入分叉。
内容样例只返回给当前有管理权限的导入操作者，不写审计日志。

预检的“处理重复列名”入口位于文件列表下方；解决弹窗的校验错误、请求失败和待应用方案也位于冲突
列表下方，靠近操作按钮。多组卡片在有界区域滚动，底部操作区保持可见。“仅保留此列”保留已输入的
普通列名称；身份列仍规范化为 `CaseID`/`srNum`。“暂不处理”后在同一个导入弹窗重新打开会保留草稿，
应用失败也保留选择以便重试；关闭整个导入弹窗前尚未应用的草稿不持久化。应用期间禁止改动或关闭，
避免客户端显示的方案与提交内容分叉。改名与其他列再次重名时继续展示新冲突，全部解决后才允许确认。
重新预检不会写入用例，仍需操作者明确选择 CaseID 策略并确认后台导入。

## DDT 执行快照

DDT 单用例快捷执行使用 `POST /api/v1/ddt/cases/:caseId/execute`，URL 显式携带项目、版本和阶段，
请求体复用普通单用例执行配置。入口要求 `run.create`，服务端重新读取当前 DDT 数据、SR 关联及可用
测试类，并沿用普通用例的来源、Runner 与 Adapter 预检。创建的 `single:<DDT id>` 批次保留 DDT 身份、
数据修订和独立 `class-data` 快照，不会转成一次裸 TestNG 类执行。Lite/Full 都通过调度工作线程完成
数据读取、JSON 序列化、摘要和批次持久化；Runner 与断线恢复继续使用已有执行协议，无新迁移或依赖。

列表眼睛和字段详情的“查看执行详情”打开共享用例详情组件。`/summary` 只读取元数据和关联类；
`/workspace`、`/executions`、`/failure-analyses` 都按当前 DDT 作用域鉴权，以 DDT 稳定 ID 查询有界
历史窗口，续读游标保留作用域。源码、方法和版本来自关联类，预览不提供修改共享执行类的操作。
预览与执行配置不加载动态字段正文，完整数据仅由字段编辑或实际执行按需读取。

DDT 数据本身不是 Java class。“用例管理 → DDT 管理 → SR 测试类关联”打开独立页面
`/cases/ddt-associations`。先在“配置测试类范围”中维护需要执行 DDT 的少量 TestNG 测试类，
然后按 SR 选择其中一个测试类。候选范围与关联都按 `projectId + projectVersionId + testStageId`
隔离；写操作需要 `case.manage`，查看需要 `case.read`。候选添加与 SR 关联都复核有效权威来源、
启停和归档状态；仍被 SR 使用的候选类不能移除，必须先更换或解除关联。

平台只保存 SR 的关联，不再允许逐 CaseID 覆盖。同 SR 的现有用例、后续导入、回收恢复与
修改 SR 的用例，在读取或创建执行快照时自动继承该 SR 的关联；修改不扇出更新整个 SR 的
DDT 用例，也不增加其数据修订号。关联用独立修订号防止并发覆盖，范围移除与关联写入在同一
作用域内串行化。无关联、旧关联待确认或测试类不可用时，新执行会被预检拒绝。
列表按 SR 前缀搜索，以游标按需读取最多 100 个 SR；只统计当前窗口的分组用例数量，浏览器
会话缓存避免反复进入时重复查询。候选列表也按需加载，TestNG 搜索最多返回 50 个匹配项，
需要时输入更具体类名缩小范围。没有引入 Redis、队列或新后台统计作为关联事实来源。

DDT 用例可与普通用例加入同一个任务，任务详情将普通用例按包路径、DDT 用例按 SR 分别展示。
平台保存的是 `CaseDefinition` 标识，不接受任意 JAR 路径；任务预检、任务详情和导出都读取
SR 的关联。同一次任务读取跨多个 SQL 窗口时，每个 SR 固定首次读取到的关联，避免并发修改
导致同一批次混用该 SR 的新旧测试类；重复测试类 ID 会合并查询。批次一旦创建，后续关联变更不会改变既有执行记录、重试或诊断重跑的快照。

升级迁移为 SQLite `0068_ddt_sr_execution.sql` / PostgreSQL `0066_ddt_sr_execution.sql`，
新增候选范围、范围修订与 SR 映射表。迁移同时检查活动用例和回收站：同一作用域/SR 的非空
旧关联一致时自动继承，出现多个不同测试类时标为“旧关联待确认”，不擅自选择；已有候选类
自动进入范围，原始逐用例字段保留用于升级核对，但不再参与新执行或作为回退。无历史关联的
SR 保持未关联。升级前备份数据库；DDL/迁移数据在事务内，失败会回滚，可修复原因后重试。
需要降级旧程序时必须恢复升级前备份，因为旧程序不能识别新的 SR 配置；不要仅回退二进制。

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
- `POST /api/v1/ddt/cases/search|bulk-update|bulk-delete`
- `GET/POST /api/v1/ddt/execution-range`（候选范围查询／加入移除，写入携带 `expectedRevision`）
- `GET/POST /api/v1/ddt/sr-mappings`（SR 查询／关联或解除，写入携带 `expectedRevision`）
- 原 `POST /api/v1/ddt/cases/execution-class` 返回 `DDT_SR_MAPPING_REQUIRED`，提示改用 SR 关联
- `GET /api/v1/ddt/cases/{CaseID}/history`
- `POST /api/v1/ddt/cases/{CaseID}/history/{historyId}/restore`
- `POST /api/v1/ddt/imports/preview`（`multipart/form-data` 的 `files`）
- `POST /api/v1/ddt/imports/{jobId}/resolve-columns`
- `POST /api/v1/ddt/imports/{jobId}/confirm|cancel`
- `GET /api/v1/ddt/imports/{jobId}/case-ids`
- `POST/PATCH/DELETE /api/v1/ddt/templates/{templateId?}`
- `POST/DELETE /api/v1/ddt/recycle/{recycleId}/restore?`
- `GET/POST /api/v1/ddt/export`
- `POST/DELETE /api/v1/case-suites/{suiteId}/ddt-cases`

API 响应继续使用 AutoForge 的稳定错误码、`requestId`、游标分页和显式 DTO；不会返回 ORM 行或对象存储凭据。
