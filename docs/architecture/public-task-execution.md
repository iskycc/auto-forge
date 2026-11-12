# 任务公开执行入口

任务详情的“执行接入”和任务卡片的“执行接入”按钮提供公开链接、Jenkins 指导及插件下载。链接使用业务路径 `/RunTask?SuiteId=<任务 ID>&PublisherId=<分享人 ID>`，不生成随机分享串。

## 授权与数据范围

生成、读取本人链接及撤销链接要求有效浏览器登录会话，以及任务所属项目的 `case_suite.manage`、`run.create` 权限。每个任务、每个分享人分别保存一条可撤销授权。重新生成会启用本人原来的链接；其他人的链接不受影响。删除任务会删除授权；停用分享人后授权不能再使用。停用或归档任务保留介绍页，但不能创建新执行。

打开链接可匿名查看任务名称、说明、项目版本、用例数量、并发和重跑上限以及当前状态。执行与终止必须使用有效的浏览器登录会话，不检查项目执行权限。原有控制台、日志重跑、API Key 和 Jenkins 接口的权限保持不变。API Token 不能通过此入口绕过原来的权限。

页面不下发任务完整成员、Runner 凭据、环境变量、恢复密钥或运行资产。通过此入口启动的批次在创建事务内同时获得公开结果访问授权，进展链接复用 `/Execution?BatchId=<批次 ID>`，以新标签页打开。

## 执行、倒计时与多人操作

执行采用任务最新保存的完整配置，在创建时固定快照。公开入口仅允许显式覆盖本次执行的 Adapter 环境 IP；Runner、并发、重跑、恢复等参数仍读取任务配置。倒计时为 1 秒至 7 天，复用原有持久化 `scheduledFor` 和调度队列；关闭网页不会取消倒计时。

公开执行按环境隔离：同一任务已有待执行或执行中的普通批次时，只要新批次的环境 IP 与全部未结束批次都没有交集，就允许再次拉起。同一个地址、任一方包含另一方、两个多地址集合存在任一公共地址，都返回 `PUBLIC_SUITE_EXECUTION_ACTIVE`（HTTP 409），消息包含冲突批次及重叠地址。按完整 IP 比较，IPv6 大小写、展开／压缩和 IPv4-mapped 等价写法视为相同；不使用字符串子串匹配，也不进行 DNS 网络探测。比较本次实际执行快照，不使用任务后来修改的默认地址。

倒计时、排队、待领取、运行、暂停和终止收尾中的批次均保留环境占用，只有批次终态才释放。没有可判定环境 IP 的任一方仍沿用单批次保护。该检查与任务版本校验、授权有效性检查和批次写入在同一事务内完成；PostgreSQL 锁定同一个任务行，跨分享链接也串行校验，SQLite 使用现有短写事务。每页只读取最多 100 个活动批次的地址投影，检查全部页面，不受公开页面最多展示 10 条的限制，不加载用例清单或完整运行资产。幂等重放先于冲突检查，重复请求返回原批次。此规则只约束公开入口，不改变控制台允许创建多个批次的行为。

一次提交包含浏览器生成的 UUID `requestKey`，数据库以任务、分享人和请求键建立唯一索引。同一次提交重试返回原批次，即使原批次已经结束，也不会重复执行。创建成功但回执丢失时可安全重试；重试不会改变原批次的实际拉起人。

所有访问者每 5 秒读取最多 10 个当前批次和最近 5 个已结束公开批次；隐藏页面暂停轮询，恢复可见立即刷新。请求有超时且不重叠，不读取 attempt、日志正文或完整执行快照。匿名用户可以观察状态，但不能终止。已登录用户可以终止该任务通过公开入口创建的批次，不能借此控制其他任务或平台普通入口创建的批次。

终止复用现有平滑终止：停止后续派发、重跑和轮次恢复，已领取用例继续完成上传。倒计时中的批次尚未派发时可以直接终止。页面明确显示“正在终止”，不把终止请求成功当作全部进程已结束。

## 下一次执行环境 IP

任务概览显示任务配置中的全部环境地址。已登录用户可点击“修改环境 IP”，在列表弹窗中每个输入框填写一个 IPv4 或 IPv6 地址，可添加或删除输入框，最多 128 个，拒绝空列表、无效地址和重复地址；“恢复任务配置”撤销本页的临时修改。未启用 Adapter 时不提供修改入口。原任务保存的域名等地址仍可展示并按原配置执行，编辑后的列表要求使用 IP。

`POST /api/v1/public/case-suites/:suiteId/executions?PublisherId=…` 在原有 `requestKey`、`delaySeconds` 外新增可选 `environmentAddresses`。省略该字段使用任务默认地址；提交只影响新批次的运行快照，不修改任务或其他批次。立即执行与服务端倒计时共用该规则；提交成功后保留本页选择，后续执行持续使用同一组 IP；页面展示“下一次执行环境 IP”，点击“恢复任务配置”或刷新／重新打开页面后恢复任务默认。现有任务普通执行和 Jenkins API 不接受此覆盖。

任务被他人锁定时，上述修改入口与公开执行权限保持可用。用例范围及任务持久配置的写入继续受锁定人保护，本次 IP 选择不属于任务配置修改，不能借此覆盖成员、并发或其他策略。

多人查看时，当前与最近批次各自显示实际保存的全部地址；修改草稿仅属于当前浏览器页面。任务执行详情及公开执行进展也显示本批次环境 IP，保留原顺序，按任务既有环境池规则分配用例。长 IPv6 地址可换行，多地址区域限制高度并可滚动，不拉宽页面。

存在活动批次时，环境 IP 编辑和启动方式仍可用；页面根据当前已展示批次提示冲突并禁止提交重叠地址，选择独立 IP 后可立即或倒计时执行。服务端事务是最终判定，防止多人页面未刷新或冲突批次未展示时绕过。提交成功后继续保留本页选择，若这些地址正被占用，提示修改 IP；活动批次结束后可直接使用所选地址再次执行。

Lite／Full 从已有批次 Adapter 快照读取历史地址，无新增迁移。新批次在较小的策略 JSON 中额外保存地址投影，状态轮询优先读取该投影，旧批次回退到数据库 JSON 投影；不向公开页面发送运行资产或逐用例地址映射。

### 2026-11-09 锁定任务与临时 IP 兼容验证

86 项应用／接口／SQLite／PostgreSQL 定向回归通过，覆盖他人锁定的任务仍可创建执行、公开页仍可执行并选择临时 IP，以及批次保存 IP 后原任务摘要保持不变。命令为：

```bash
pnpm exec vitest run packages/application/test/public-suite-execution.test.ts packages/application/test/schedule-run-batches.test.ts packages/db/test/public-suite-execution.integration.test.ts apps/web/src/lib/public-suite-execution-api.test.ts --maxWorkers=1 --no-file-parallelism
pnpm exec playwright test tests/e2e/case-suite-lifecycle.spec.ts --grep 'public task links execute with login only' --workers=1
```

生产 Lite 的浏览器闭环通过：先由分享人实际锁定任务，再由没有项目权限的另一登录用户修改 IP，立即执行与倒计时执行都成功，Runner Protocol 领取的执行规格包含本次选择地址；公开进展与后台详情显示相同地址。任务原 IP、修订号和用例数量保持不变，后续省略覆盖参数的新批次仍使用原 IP。同时保留暂停／恢复、终止、多人观察、登录过期及撤销链接检查。

已实际查看 1024×768、1536×960 浅色／深色的 IP 修改弹窗及执行详情截图，无新增溢出。受影响文件格式／ESLint、测试 TypeScript 与差异检查通过。本轮只补充测试和文档，复用上轮已通过构建的生产产物；没有新增生产代码、迁移或依赖，未运行 Full 整栈浏览器或真实 Jenkins／Java 进程。证据位于本机 `/var/tmp/autoforge-locked-public-ip-ui/`。

### 2026-11-10 不同环境并行执行验证

- 先复现 20 项相关失败，再修改环境隔离规则。8 个文件共 184 项定向回归通过，SQLite／PostgreSQL 均实际执行：同地址、双向包含、部分交集、独立集合、IPv6 等价形式、不同分享人并发启动、没有修订号的历史调用、幂等重放、倒计时、暂停、终止收尾及终态释放。102 个活动批次场景确认校验跨越 100 条分页边界，不遗漏公开展示范围以外的冲突批次。
- 生产 Lite Playwright 完整公开执行场景通过：他人锁定任务、无项目权限用户原地登录并修改 IP、保留第一批次时创建第二个独立 IP 的倒计时批次、页面禁用重叠输入及直接 API 返回具体冲突 IP、两浏览器会话观察、分别终止、实际 Runner HTTP 领取规格、完成上报、暂停／继续、默认 IP 恢复、登录过期与撤销链接。没有新增真实 JVM 或 Jenkins 进程。
- 已实际审查新生成的 1024×768 浅色冲突／并行批次和 1536×960 深色并行批次截图；长名称、IP、按钮和表单正常换行，无横向溢出或布局变形。截图位于 `/var/tmp/autoforge-public-ip-ui/`。
- 受影响文件 Prettier／ESLint、领域／应用／数据库类型检查、E2E TypeScript、Web 生产构建和独立 Worker 构建通过。未新增依赖、数据库迁移或 Runner 协议字段；测试和构建串行限核执行。未运行 Full 整栈浏览器、跨物理主机负载或发布流水线。

定向回归使用 `pnpm exec vitest run`，文件为 `public-suite-execution.integration.test.ts`、`public-suite-migration.integration.test.ts`、`execution-environment-overlap.test.ts`、`public-suite-execution.test.ts`、`schedule-run-batches.test.ts`、`public-suite-execution-api.test.ts`、`api-error-mapping.test.ts` 和 `ui-usage.test.ts`；浏览器沿用上节公开执行场景命令。证据日志前缀为本机 `/var/tmp/autoforge-public-ip-final-`，浏览器结果为 `/var/tmp/autoforge-public-ip-e2e.log`。

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

v1.20.22 同时修正版本复制和 DDT 变更提交的既有 HTTP 入口，统一复用相同生成器。版本复制和 DDT 变更回归均覆盖缺少 `randomUUID` 的浏览器环境，版本复制截图的主题 Cookie 使用实际页面来源，避免在容器 IP／不同端口时误用 localhost Cookie。

对应生产 Lite 验证使用真实内网 HTTP 地址，`management-operations` 的两种版本复制以及 `ddt-change-review` 两个完整场景共四项通过，保留历史记录并完成提交／审核／合入／冲突闭环。实际审查 1024×768、1536×960 深浅色复制弹窗截图，长名称、正文滚动和固定页脚均正常。

检查全部串行执行，重任务限制为一个 CPU、4 GiB 内存。证据目录：`/var/tmp/autoforge-public-task-20261027/`。

- 契约、应用、HTTP 和工作线程传递测试覆盖：浏览器登录、无项目权限、API Token 不可旁路、同源保护、限流、请求参数不可伪造、已有链接读取与撤销、请求重试、操作人和版本复制。原有执行发起人、日志诊断重跑与 UI 组件规范也通过回归。
- `AUTOFORGE_TEST_POSTGRES_URL=… pnpm exec vitest run packages/db/test/public-suite-execution.integration.test.ts packages/db/test/public-suite-migration.integration.test.ts packages/db/test/scheduling-refill.integration.test.ts packages/db/test/attempt-log-snapshot.integration.test.ts --maxWorkers=1`：104 项通过，真实 SQLite/PostgreSQL 均运行；包含全新建库、上一 schema 升级、失败 DDL 回滚、同时发起仅一个批次、持久倒计时、首位终止人和旧执行路径。
- `pnpm typecheck`、Web 与 worker 生产构建、受影响文件的 Prettier/ESLint、`pnpm licenses:check`、`pnpm test:e2e:matrix` 均通过。`node --test scripts/release/*.test.mjs`：51 项通过，包含 schema 4 发布集合、旧包兼容、源码摘要和内置插件完整性。
- `MAVEN_ARGS=--offline pnpm build:jenkins-resources` 在资源目录暂时移开时成功重建两个 HPI，并通过既有 HPI manifest、step class、共享库检查。完整资源复用时将 `PATH` 设为不存在的目录仍成功，确认无需 Java/Maven。临时构建后已恢复原验证资源。
- `node scripts/release/package-backend-runtime.mjs /tmp/autoforge-runtime-public-task-20261027` 生成完整主系统运行目录，并校验前端静态资源、Next 路由与两个内置插件；验证后已清理临时目录，保留日志及 `runtime-verification-receipt.json`。
- `pnpm exec playwright test tests/e2e/case-suite-lifecycle.spec.ts --grep='public task links execute with login only' --workers=1`：生产 Lite 带数据全流程通过。真实导入 TestNG 用例并配置任务，创建无项目角色用户，从公开页原地登录执行；以 Runner HTTP 协议领取、上传日志和完成；验证多会话状态、匿名不能终止、重复提交、服务端倒计时重载后继续、平滑终止、详情操作人、会话失效重新登录、停用和撤销，以及实际 HPI 下载。

实际生成并逐张检查 1024×768、1536×960 的浅色/深色截图，位于证据目录的 `screens/`：任务卡片及执行接入弹窗、任务详情接入区、公开任务概览、终止确认、Jenkins 全文指导、执行详情的三类操作人。卡片操作保持同排，长任务名称正常换行，代码仅在代码框内横向滚动；未见新增页面横向溢出、按钮挤压或弹窗变形。终态批次的提示已与“已终止”状态一致。

本次没有运行真实业务 JVM、真实 Jenkins 安装/Pipeline、Full 整套基础设施或正式双架构镜像发布。Runner 本次使用真实 HTTP 协议的测试端；HPI 验证范围为离线构建、包结构、摘要、主系统打包和浏览器下载，未将未运行项记录为通过。

### 环境 IP 展示与单次覆盖验收（2026-10-27）

- 契约、应用、HTTP、执行详情投影和工作线程传递的 107 项定向测试通过；SQLite／PostgreSQL 真实适配器及原日志重跑快照的 26 项集成回归通过，覆盖新地址投影与历史运行快照回退；Ant Design 使用约束 17 项通过。
- 受影响文件 Prettier／ESLint、测试类型、Web／worker 类型及生产构建和 18 行 E2E 覆盖矩阵检查通过。没有新增依赖、迁移或 Runner 协议字段。
- 生产 Lite 的 `case-suite-lifecycle` 公开执行完整场景通过：实际导入 TestNG JAR、登记依赖包和配置三个默认环境；无项目权限的登录用户修改为两个 IPv4／IPv6 环境，校验非法重复输入、实际 Runner HTTP 领取规格、公开进展与多人状态、详情中的全部地址；倒计时重载后保留覆盖，随后不传覆盖的新批次恢复原环境，原任务配置始终不变。原有终止、操作人、幂等、登录及内置插件下载也通过回归。测试时 Full 基础设施全部关闭。
- 实际审查公开页、环境修改弹窗与执行详情在 1024×768、1536×960 的浅色／深色截图：长任务名和 IPv6 地址正常换行，操作与标签对齐，未出现页面横向溢出或弹窗变形。证据位于 `/var/tmp/autoforge-public-env-20261027/`。

本次使用真实浏览器、生产 Web 与 Runner HTTP 协议测试端，未运行真实业务 JVM、跨物理主机负载、完整 Full 浏览器闭环或正式发布流水线。

## 公开页展示布局

任务摘要先展示项目版本、分享人、执行状态和四项统计；说明超过三行可展开。下方两列把当前与最近执行放在主区域，启动方式、环境 IP、登录与进展链接集中在右侧控制卡片。任务配置说明折叠显示，Jenkins 指导与内置下载保留原入口。当前执行最多 10 条，最近公开执行最多 5 条；复用原有 5 秒刷新、登录会话与幂等提交，不新增轮询或展开全量用例。
