# 任务公开执行入口

任务详情的“执行接入”和任务卡片的“执行接入”按钮提供公开链接、Jenkins 指导及插件下载。链接使用业务路径 `/RunTask?SuiteId=<任务 ID>&PublisherId=<分享人 ID>`，不生成随机分享串。

## 授权与数据范围

生成、读取本人链接及撤销链接要求有效浏览器登录会话，以及任务所属项目的 `case_suite.manage`、`run.create` 权限。每个任务、每个分享人分别保存一条可撤销授权。重新生成会启用本人原来的链接；其他人的链接不受影响。删除任务会删除授权；停用分享人后授权不能再使用。停用或归档任务保留介绍页，但不能创建新执行。

打开链接可匿名查看任务名称、说明、项目版本、用例数量、并发和重跑上限以及当前状态。执行与终止必须使用有效的浏览器登录会话，不检查项目执行权限。原有控制台、日志重跑、API Key 和 Jenkins 接口的权限保持不变。API Token 不能通过此入口绕过原来的权限。

页面不下发任务完整成员、Runner 凭据、环境变量、恢复密钥或运行资产。通过此入口启动的批次在创建事务内同时获得公开结果访问授权，进展链接复用 `/Execution?BatchId=<批次 ID>`，以新标签页打开。

## 执行、倒计时与多人操作

执行始终采用任务最新保存的完整配置，在创建时固定快照，不允许在公开入口覆盖 Runner、环境 IP、并发等参数。倒计时为 1 秒至 7 天，复用原有持久化 `scheduledFor` 和调度队列；关闭网页不会取消倒计时。

公开执行采用单批次保护：同一任务已有待执行或执行中的普通批次时，新的公开启动返回 `PUBLIC_SUITE_EXECUTION_ACTIVE`。该检查与任务版本校验、授权有效性检查和批次写入在同一事务内完成；PostgreSQL 锁定任务行，SQLite 使用现有短写事务。此规则只约束公开入口，不改变控制台允许创建多个批次的行为。

一次提交包含浏览器生成的 UUID `requestKey`，数据库以任务、分享人和请求键建立唯一索引。同一次提交重试返回原批次，即使原批次已经结束，也不会重复执行。创建成功但回执丢失时可安全重试；重试不会改变原批次的实际拉起人。

所有访问者每 5 秒读取最多 10 个当前批次和最近 5 个已结束公开批次；隐藏页面暂停轮询，恢复可见立即刷新。请求有超时且不重叠，不读取 attempt、日志正文或完整执行快照。匿名用户可以观察状态，但不能终止。已登录用户可以终止该任务通过公开入口创建的批次，不能借此控制其他任务或平台普通入口创建的批次。

终止复用现有平滑终止：停止后续派发、重跑和轮次恢复，已领取用例继续完成上传。倒计时中的批次尚未派发时可以直接终止。页面明确显示“正在终止”，不把终止请求成功当作全部进程已结束。

## 操作人记录与双数据库

`public_suite_execution_links` 保存任务和分享人的授权；`run_batches.public_execution_json` schema v1 保存分享人和实际拉起人的 ID、用户名、认证来源以及内部幂等键。对外 DTO 仅映射所需字段，不暴露内部请求键。原有 `requestedBy` 仍保存实际拉起人。`terminated_by_json` 在权威终止事务中保存首位终止人，后续重复终止不会覆盖。详情和公开任务页展示相应用户名；控制台/Jenkins 终止接口也提交实际操作人。

SQLite 迁移 `0084_public_suite_execution.sql`、PostgreSQL 迁移 `0082_public_suite_execution.sql` 新增这些表、可空列和有界查询索引。升级不会自动公开旧任务或旧批次。版本复制保留执行历史的操作人快照，清除源批次的幂等定位键，不复制任务公开启动授权。回滚应用前应恢复升级前的数据库及对象备份；不要直接在生产库删除新增列。

Lite 使用 SQLite、本地对象存储和现有持久队列；Full 使用 PostgreSQL、outbox 和现有调度服务。Redis/WebSocket 不作为状态或授权事实来源，Runner 协议无需变化。

## Jenkins 插件内置

公开任务页和平台任务页复用同一份 Jenkins 指导：最低 Jenkins/Java、Pipeline 和 Credentials Binding 前置条件、离线上传 HPI、服务账号授权、Secret text 凭据、自动填入任务 ID 的 Pipeline、结果和终止语义。

Jenkins 继续使用 `/api/v1/jenkins/runs`，服务账号和 Token 均需任务所属项目的 `run.create`、`run.read`、`run.cancel`。浏览器公开执行链接不充当 Jenkins 密钥。

两个 HPI 由 Release 在 Java 构建环节验证后写入 `resources/jenkins`，包含版本、大小、SHA-256 清单，两个架构的主平台镜像均携带。主系统提供：

- `/api/v1/integrations/jenkins/execution/download`
- `/api/v1/integrations/jenkins/dependency-publisher/download`

下载只允许以上两种固定插件，校验清单和内容摘要；缺失或损坏返回 `JENKINS_PLUGIN_UNAVAILABLE`，不会运行时联网获取。主系统打包和镜像验证同样检查完整性。插件无需登录即可下载，文件中不包含平台配置或凭据。

Release manifest 升为 schema 4，不再单独发布 HPI 或插件 SBOM；主平台镜像 SBOM 覆盖内置插件。离线包验收保留 schema 1/2/3 的历史资产集合兼容。生产 Web 构建会按源码摘要复用内置资源；缺失、校验失败或源码变化时，构建阶段通过 Maven 重新生成开发版 HPI。开发模式可运行 `pnpm build:jenkins-resources`。正式发布仍先单独构建并验证同版本 HPI，再运行 `node scripts/release/stage-jenkins-resources.mjs <插件构建版本>`；Docker 构建复用已校验资源，不要求镜像内安装 Java 或 Maven。运行时缺少插件时下载接口明确报告缺失，不尝试构建或联网。

## 验证记录（2026-10-27）

### 局域网 HTTP 兼容修复

发布包离线验收使用真实容器 IP，发现普通 HTTP 环境没有浏览器的 `crypto.randomUUID()`，公开执行在发请求前抛错并停留在提交状态。v1.20.21 复用基于 `crypto.getRandomValues()` 的客户端幂等键生成器，并把生成步骤纳入错误处理，失败后恢复按钮、显示原因且允许重试。请求重试仍复用同一个幂等键；服务端授权、并发控制和持久化语义不变，无新增迁移或依赖。

Playwright 场景显式移除 `randomUUID`，覆盖 HTTP 的可用 API 边界，并注入一次随机源异常验证按钮恢复和再次提交；正式发布包继续通过真实容器 IP 验收，不能用浏览器安全上下文开关绕过该问题。

检查全部串行执行，重任务限制为一个 CPU、4 GiB 内存。证据目录：`/var/tmp/autoforge-public-task-20261027/`。

- 契约、应用、HTTP 和工作线程传递测试覆盖：浏览器登录、无项目权限、API Token 不可旁路、同源保护、限流、请求参数不可伪造、已有链接读取与撤销、请求重试、操作人和版本复制。原有执行发起人、日志诊断重跑与 UI 组件规范也通过回归。
- `AUTOFORGE_TEST_POSTGRES_URL=… pnpm exec vitest run packages/db/test/public-suite-execution.integration.test.ts packages/db/test/public-suite-migration.integration.test.ts packages/db/test/scheduling-refill.integration.test.ts packages/db/test/attempt-log-snapshot.integration.test.ts --maxWorkers=1`：104 项通过，真实 SQLite/PostgreSQL 均运行；包含全新建库、上一 schema 升级、失败 DDL 回滚、同时发起仅一个批次、持久倒计时、首位终止人和旧执行路径。
- `pnpm typecheck`、Web 与 worker 生产构建、受影响文件的 Prettier/ESLint、`pnpm licenses:check`、`pnpm test:e2e:matrix` 均通过。`node --test scripts/release/*.test.mjs`：51 项通过，包含 schema 4 发布集合、旧包兼容、源码摘要和内置插件完整性。
- `MAVEN_ARGS=--offline pnpm build:jenkins-resources` 在资源目录暂时移开时成功重建两个 HPI，并通过既有 HPI manifest、step class、共享库检查。完整资源复用时将 `PATH` 设为不存在的目录仍成功，确认无需 Java/Maven。临时构建后已恢复原验证资源。
- `node scripts/release/package-backend-runtime.mjs /tmp/autoforge-runtime-public-task-20261027` 生成完整主系统运行目录，并校验前端静态资源、Next 路由与两个内置插件；验证后已清理临时目录，保留日志及 `runtime-verification-receipt.json`。
- `pnpm exec playwright test tests/e2e/case-suite-lifecycle.spec.ts --grep='public task links execute with login only' --workers=1`：生产 Lite 带数据全流程通过。真实导入 TestNG 用例并配置任务，创建无项目角色用户，从公开页原地登录执行；以 Runner HTTP 协议领取、上传日志和完成；验证多会话状态、匿名不能终止、重复提交、服务端倒计时重载后继续、平滑终止、详情操作人、会话失效重新登录、停用和撤销，以及实际 HPI 下载。

实际生成并逐张检查 1024×768、1536×960 的浅色/深色截图，位于证据目录的 `screens/`：任务卡片及执行接入弹窗、任务详情接入区、公开任务概览、终止确认、Jenkins 全文指导、执行详情的三类操作人。卡片操作保持同排，长任务名称正常换行，代码仅在代码框内横向滚动；未见新增页面横向溢出、按钮挤压或弹窗变形。终态批次的提示已与“已终止”状态一致。

本次没有运行真实业务 JVM、真实 Jenkins 安装/Pipeline、Full 整套基础设施或正式双架构镜像发布。Runner 本次使用真实 HTTP 协议的测试端；HPI 验证范围为离线构建、包结构、摘要、主系统打包和浏览器下载，未将未运行项记录为通过。
