# Jenkins Agent 本地依赖直传

`autoforgePublishDependencies` 的默认接入是 Agent 本机文件 `filePath`。用户提供平台地址、
API Key、项目 ID、版本名称和文件路径（工作区相对路径或 Agent 绝对路径），摘要、大小、压缩格式均由插件计算。
参数、示例及失败边界见[插件指南](../../integrations/jenkins/autoforge-dependency-publisher/README.md)。

## 传输与事务

1. Pipeline 步骤通过 `FilePath.act` 在当前 Jenkins Agent 上执行读取与上传，支持 Controller／
   Agent 分离。源文件必须为当前 Agent 可读的普通文件。相对路径按工作区解析并拒绝越界及指向工作区外的符号链接；显式绝对路径按 Agent 原生操作系统解析，可指向工作区外文件，不依赖工作区目录已经创建。文件不经 Jenkins
   Artifact URL，不需要 `archiveArtifacts`，不经 Controller 全量缓冲。
2. Agent 使用 64 KiB 缓冲计算 SHA-256 和大小，然后以 HTTP/1.1 原始正文流式 POST。
   摘要后文件大小变化立即失败；同大小变化由平台实际摘要校验拒绝。
3. Web 先验证 API Key 的 `project.manage` 权限，之后流式暂存到数据目录，验证真实大小、
   摘要、文件名和 ZIP／gzip 格式签名。暂存不是解压或完整压缩包结构扫描；Runner 原有
   解压大小、路径、摘要和依赖校验继续生效。校验失败、断流和磁盘写满清理暂存文件。
4. 应用服务按规范化版本名称查找或创建版本，使用共享 ObjectStore 写入托管对象。
   对象内容不进入数据库，也不在数据库事务中进行上传。Lite 使用本地文件，Full 使用 MinIO。
5. 在短事务内再次检查版本没有归档，再插入资产并更新版本依赖绑定，保留当前 JDK。
   登记失败删除本次对象；清理失败保留 cause 明确报错。暂存文件在请求结束时清理。
   进程突然退出可能留下暂存或未登记对象，沿用数据目录与对象存储的运维清理边界，
   当前没有自动清理孤立暂存的保证。
6. 新绑定用于后续批次。已有执行快照继续使用原资产，旧上传对象保留为文件库资源并沿用
   引用保护，避免破坏运行中任务；该行为与既有上传资产一致。旧 URL 元数据清理保持原语义。

平台与 Runner 不持有 Jenkins 下载凭据。Runner 继续使用当前控制协议取得受控下载目标，
不暴露 MinIO 长期密钥。API Key 只传至配置的主平台，不跟随重定向、不记录在控制台。

## 兼容与恢复

- 插件直传链路不需要额外平台配置、生产依赖或 Runner 协议变更；Jenkins 最低版本不变。平台主动触发构建新增的独立数据库表见下文。
- 原 URL 输入与 `/api/v1/jenkins/dependencies` 保留兼容，新指导只生成 `filePath`。
- 上传最长等待 15 分钟，不自动重试。取消、断网或 Controller 重启与平台提交之间存在
  不确定边界，调用方应先核对当前绑定后再手工重试；该步骤不是持久上传队列。
- 两个 API 均使用同一应用服务和双数据库事务适配器，不依赖 Redis／NATS 保障上传正确性。

## 验证范围

定向测试覆盖插件自动摘要／字节数／中文文件名、真实远端 Agent Pipeline、工作区越界和
旧 URL DSL；主平台覆盖真实 API Key、上传内容一致性、鉴权和摘要拒绝。共享存储契约使用
SQLite＋本地对象及 PostgreSQL＋MinIO，验证重复发布、JDK 保留与上传中版本归档的回滚清理。
UI 使用生产 Lite 的带数据项目配置，覆盖 1024×768、1536×960 深浅主题的接入步骤、
Pipeline、参数与 HPI 下载，并实际审查截图。

## 验证记录（2026-11-06）

- `mvn --batch-mode --no-transfer-progress --offline --file integrations/jenkins/pom.xml verify`：通过；两个插件共 35 项通过、2 项框架跳过，包含远端 Agent 上传、中文名／摘要／大小、gzip 格式、越界拒绝、错误脱敏、旧 DSL 与执行插件回归。`bash scripts/verify-jenkins-hpis.sh` 通过；未提高 Jenkins／Step API 基线或增加运行插件依赖。
- 定向 Vitest 的应用服务、上传接口、暂存、契约与指导生成器：5 个文件、24 项通过。真实存储测试 `apps/web/server/jenkins-dependency-upload.integration.test.ts` 和 `packages/db/test/sqlite-project-structure.integration.test.ts` 共 4 项通过，Full 使用真实 PostgreSQL 和 MinIO。另通过 9 项既有 AI 文本处理回归，确认 NodeNext 导入扩展名修正不改变行为。
- `pnpm --filter @autoforge/web build`、`pnpm --filter @autoforge/web typecheck`、顺序执行 contracts／application／db 的 `typecheck`、`pnpm exec tsc --noEmit -p tsconfig.tests.json`、`pnpm format:check`、变更 TypeScript 文件 ESLint 和 `pnpm test:e2e:matrix` 均通过。
- 生产 Lite 外部服务运行 `playwright test tests/e2e/management-operations.spec.ts tests/e2e/ui-layout.spec.ts --grep 'Jenkins uploads local dependency|dependency import opens the scoped Jenkins quick guide'`：两项通过。真实 API Key 上传的 ZIP 与平台托管对象逐字节一致；错误摘要和越权请求拒绝后，原绑定不变。
- 两个桌面视口 1024×768、1536×960，各覆盖浅色／深色的入口、快速指导、Pipeline 和参数页，共 16 张真实截图。逐类查看截图，修正参数名被拆行的问题；两组参数标签列宽一致，代码限制在自身滚动区，关闭按钮始终可见，无新增页面横向溢出。测试还验证复制、版本切换、包含引号的长中文名称、焦点返回和实际 HPI 下载。

本次未运行 Windows Agent、完整真实 Runner 执行、整套 Full 浏览器／故障恢复或发布矩阵；
文件分发复用既有平台托管资源与 Runner 协议，未将这些未运行项列为通过。

## Agent 绝对路径扩展验证（2026-11-06）

绝对路径由当前 Jenkins Agent 的原生 `Path` 解析，Linux 支持 `/opt/builds/dependencies.zip`，
Windows 可填 `D:/builds/dependencies.zip`。步骤仍需放入已选择 Agent 的 `node`／`steps`。
绝对路径分支不读取工作区目录；相对路径保留原有目录边界。普通文件及读取权限校验共享，
缺失、目录、空路径和控制字符在 HTTP 上传前拒绝；相对符号链接越界继续拒绝，显式绝对来源允许解析符号链接。
本次仅改变 Jenkins 侧取文件逻辑，平台 API、权限、数据库及 Lite／Full 托管存储共用原链路。

先添加真实独立 Agent 的绝对路径 Pipeline，复现旧版本以“必须是工作区内的相对文件路径”拒绝；
修复后完整 Maven `verify` 通过，两个插件合计 42 项通过、2 项框架跳过，SpotBugs 零问题。
真实远端上传同时覆盖相对路径、工作区外绝对路径，逐项核对文件字节、摘要、大小和中文／空格文件名；
六项路径测试覆盖未创建工作区、路径归一化、缺失文件／目录、控制字符和符号链接。
旧 URL DSL 与原执行插件回归均通过，HPI 包校验保持原 Jenkins／Step API 最低版本及唯一直接插件依赖。

指导生成器两项测试与 Web 生产构建通过。生产 Lite 的上传 API／UI 两项 Playwright 通过，
覆盖原值字节一致、错误摘要／越权后保留绑定、复制与版本切换、HPI 下载和绝对路径说明。
全仓 `pnpm format:check`、变更文件 ESLint、`tsconfig.tests.json` 类型检查及 E2E 覆盖矩阵校验通过。
实际查看 1024×768、1536×960 深浅色的快速接入、Pipeline 和参数截图，代码只在自身区域滚动，
参数标签列宽一致，关闭按钮可见，没有新增页面横向溢出。截图位于本机
`/var/tmp/autoforge-jenkins-absolute-ui-20261106/`，不提交产物。

Windows 路径沿用 Java 原生文件系统语义，本轮未运行真实 Windows Agent；未重跑 Full 数据库／对象存储完整矩阵，
因为服务端上传契约与存储实现未改动。更新依赖发布 HPI 即可使用绝对路径，原已支持直传的平台接口可继续接收。

## 从平台触发版本依赖构建

在「项目设置 → JDK 与依赖 JAR 压缩包」点击 **Jenkins 构建依赖**。此入口与
「Jenkins 接入指导」并列，只向具有当前项目 `project.manage`（管理项目）权限的账号开放。
选择的版本决定配置和构建记录的范围，切换版本不会复用其他版本的 Jenkins 凭据。

1. 在「流水线配置」填写完整 Jenkins 任务地址、用户名和该用户的 **API Token**，
   添加构建参数名和值。任务地址示例：`https://jenkins.example/jenkins/job/folder/job/update/`。
   支持嵌套文件夹，不能填写某次构建的地址、`buildWithParameters` 地址、含用户名密码的 URL
   或带查询参数的地址。Jenkins 账号需要读取任务、读取构建和 `Job/Build` 权限。
2. 参数名须与 Jenkins 参数化构建中的名称一致；值原样按 UTF-8 表单编码传递，空字符串
   也明确传递。未配置的参数沿用 Jenkins 的默认值。重复参数名在保存前拒绝。
   支持字符串、文本以及用字符串表示的布尔／选项参数；此入口不上传 Jenkins 文件参数。
   最多 100 个参数、单值最多 16,000 字符，整个配置请求不超过 256 KiB。
3. 保存后点击「检查连接」查看任务是否可构建。检查不会执行流水线。
   API Token 加密保存在主业务数据库，接口只返回“已配置”，不会回传 Token。
   修改参数时留空保留原 Token；更改任务地址或用户名必须重新输入 Token。
4. 在「构建状态」核对目标版本、任务链接和参数后点击「触发构建」。平台发送一次
   `buildWithParameters` POST，先显示排队，随后跟踪该队列分配的准确构建编号、状态、
   发起人和时间。构建编号在新标签页打开 Jenkins。构建可能成功、失败或被取消。
   此入口没有增加终止 Jenkins 的权限；需要终止时在 Jenkins 操作。
5. 弹窗前台可见时约每 4 秒串行读取状态，隐藏页面、切换到配置页或关闭弹窗停止轮询；
   重新打开会读取持久化记录并继续跟踪。网络暂时不可用时显示重试提示，保留已知状态，
   不把读取失败误判成构建失败。点击「刷新状态」可恢复。
6. Pipeline 内继续使用 `autoforgePublishDependencies`，由插件上传本地构建产物。
   平台触发成功与 Jenkins 构建成功不等同于依赖包已上传：须确保上传步骤实际执行成功，
   并核对平台依赖包更新时间。插件使用的 **AutoForge API Key** 与本弹窗的
   **Jenkins API Token** 是两个不同方向的凭据，不能混用。

### 并发、失败与恢复

- 主库新增版本配置表（SQLite `0097_jenkins_dependency_builds.sql`、PostgreSQL
  `0096_jenkins_dependency_builds.sql`），每版本保存一份加密配置和最近一次平台触发记录。
  配置修改和构建状态更新使用独立修订号；原子条件更新避免多个 Web 或多人同时重复触发。
  浏览器重复提交同一请求时返回已有记录，不重复发送 POST。
- 正在提交、排队、构建或结果待核对时禁止修改配置和再次触发。
  提交超时、5xx、重定向或缺少合法队列链接属于**结果待核对**，不会自动重试 POST。
  请先在 Jenkins 核对；勾选“我已在 Jenkins 核对本次构建，确认可以再次提交”，
  点击「解除提交保护」后才可再次触发。进程中断遗留的提交状态超过 30 秒也转为待核对。
- 已被 Jenkins 明确拒绝的 400／401／403／404／405／422 请求显示失败与错误状态码，
  可修正配置。Jenkins 返回的正文不回显，避免泄漏凭据或巨型 HTML 页面。
- 队列过期后按准确 `queueId` 在最近 20 次构建中查找，不使用可能属于他人的 `lastBuild`。
  无法定位时转为待核对。代理必须返回与所配服务同源、同一 Jenkins 上下文的队列和构建链接；
  平台不会携带认证头跟随外部重定向。
- Jenkins 网络 I/O 均有 10 秒期限，JSON 响应最多 256 KiB；只读取所需字段，
  不拉取控制台全量日志。网络等待不占数据库事务或连接，不参与用例调度通道。
  Lite 用 SQLite，Full 用 PostgreSQL；这类外部构建不需要 Runner、Redis、NATS 或 MinIO
  维护状态。原有依赖直传仍沿用 Lite 本地对象／Full MinIO，已有执行快照不变。
- 版本复制和版本初始化不自动复制主动触发配置或 Jenkins 凭据，避免副本误操作源流水线；
  已配置此入口的版本视为非空目标。升级只新增独立表，不重写原执行或依赖数据；回退时
  保留新增表，先确认 Jenkins 在途构建，恢复旧版后仍可在 Jenkins 继续查看。

参数化构建和 API Token 认证遵循 Jenkins 官方的
[Remote Access API](https://www.jenkins.io/doc/book/using/remote-access-api/) 与
[CSRF Protection](https://www.jenkins.io/doc/book/security/csrf-protection/)：使用 API Token
认证的请求无需额外获取 crumb。未使用账号密码代替 API Token。

### 主动构建验证记录（2026-11-06）

- 定向 Vitest：9 个文件、76 项通过，覆盖应用编排、输入校验、API 鉴权、密钥不回传、
  中文／空参数、准确队列关联、过期队列恢复、明确拒绝和不确定提交，以及原有环境恢复、
  Pipeline 指导、浏览器幂等键、错误映射和共享 UI 约束。
- `AUTOFORGE_TEST_POSTGRES_URL=... pnpm exec vitest run packages/db/test/jenkins-dependency-build.integration.test.ts packages/db/test/runtime-asset-usage.integration.test.ts packages/db/test/sqlite-project-structure.integration.test.ts --maxWorkers=1 --no-file-parallelism`：
  3 个文件、10 项通过，使用真实 SQLite／PostgreSQL，验证全新建库、上一版升级、失败 DDL
  回滚后恢复、多次并发领取只有一个成功、状态修订保护、版本隔离、归档保护与既有资源绑定。
- `pnpm exec playwright test tests/e2e/jenkins-dependency-build.spec.ts tests/e2e/management-operations.spec.ts tests/e2e/ui-layout.spec.ts --grep 'version dependency pipeline|Jenkins uploads local dependency|dependency import opens the scoped Jenkins quick guide' --workers=1`：
  生产 Lite 外部服务运行，3 项通过。新增流程通过本地 HTTP Jenkins 契约模拟端验证真实出站
  请求的认证头、UTF-8 参数和状态读取；原有实际依赖上传、错误摘要／越权后保留绑定、
  接入指导与 HPI 下载继续通过。没有连接用户局域网 Jenkins。
- 新入口、配置与构建中状态生成 12 张真实截图，覆盖 1024×768、1536×960 深浅主题；
  编码代理逐张查看。长地址不再挤压标签列，长参数在弹窗正文内换行／滚动，
  关闭按钮与底部操作始终可见，无新增横向溢出。截图位于本机
  `/var/tmp/autoforge-jenkins-build-playwright-final/`，不提交构建产物。
- `pnpm --filter @autoforge/web build`、`pnpm --filter @autoforge/web typecheck`、contracts／application／db
  顺序 `typecheck`、`pnpm exec tsc --noEmit -p tsconfig.tests.json`、变更文件 ESLint（零警告）、
  `pnpm format:check` 和 `pnpm test:e2e:matrix` 均通过。测试进程和临时 PostgreSQL 已关闭。

本轮未运行真实 Jenkins 安装、整个 Full 浏览器矩阵、真实 Runner、离线发布验收或发布流水线。
外部 Jenkins 构建不修改 Runner 协议或插件；上述本地接口模拟不替代用户网络和 Jenkins 权限配置的联调。
