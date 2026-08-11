# AutoForge Agent Guide

本文件约束在 AutoForge 仓库内工作的开发者与编码代理。它适用于整个仓库；更深目录中的 `AGENTS.md` 可以补充局部规则，但不得放宽这里的双模式、离线、安全和质量要求。本文使用 **Runner Agent** 指安装在执行机上的产品守护进程，使用“编码代理”指修改本仓库代码的工具或参与者，两者不得混淆。

## 1. 当前阶段

仓库已实现 Lite/Full 用例资产、统一身份/RBAC（含自定义角色与项目成员管理）、可选 LDAP、版本化执行环境、加密密文引用/lease 按需领取、逐项执行预检和控制面执行协议里程碑：Next.js 主平台、TestNG JAR 静态扫描（含 testng.xml 选择规则、JAR 内继承、Multi-Release 版本选择和工厂/动态语义有界警告）、双数据库用例/身份/执行仓储、本地/MinIO 对象存储、资源感知调度、版本条件保护的权威执行状态机、四阶段超时恢复和批次/attempt 状态历史已经落地；用例元数据编辑与版本历史恢复、任务生命周期（复制/归档/启停/版本快照）与执行策略、来源目录对比/确认同步（保留语义）/归档/守卫式删除与对象异步清理也已接通。Go Runner Agent 已实现注册/资源心跳、版本与工具链兼容提示、assignment claim、lease 续租、启动 reconcile、权威测试/依赖 JAR 下载校验、离线 TestNG 类/方法执行与参数注入、cgroup v2/rlimit 资源限制、日志 spool/确认重传、双层脱敏、安全产物上传、取消/进程组清理、完成上报和直连终端，Runner 凭据轮换/撤销/禁用/排空/注销已在双数据库落地；SQLite 持久队列、Lite 嵌入式工作器、PostgreSQL outbox、JetStream 调度和 Redis 可重建缓存也已接通首版，SQLite/JetStream 共享队列契约测试已落地。严格总磁盘配额、多租户隔离、分析和完整离线验收仍是目标能力。README 中的目标架构不代表这些能力已经完成。

在添加脚手架或功能时：

- 只声明已经实际可用并经过验证的命令和能力。
- 不为了匹配目标目录树而创建空包、空目录或占位实现。
- 如果实现改变了用户可见行为、配置、架构或部署方式，同一变更中更新文档。
- 不把规划中的功能写成已完成功能。

### 1.1 Clean Code 是硬性要求

仓库中的 TypeScript、Go、Shell、SQL、YAML 和测试代码都必须符合 Clean Code 原则。通过编译不是完成标准；代码还必须能被下一位维护者快速理解、安全修改和独立验证。

- 名称表达业务意图，避免 `data`、`info`、`manager`、`helper` 等无法说明职责的宽泛命名。
- 函数和模块保持单一职责；解析、校验、状态变更、I/O 与展示映射应在清晰边界分离。
- 依赖从组合根显式注入；领域和应用逻辑不得读取全局配置、隐式创建基础设施客户端或依赖调用顺序。
- 优先使用早返回、小函数和显式类型，避免深层嵌套、布尔参数陷阱、魔法值和跨层泄漏。
- 重复的业务规则必须抽取为唯一实现；不要为了消除表面重复而制造难以理解的通用框架。
- 错误必须保留 cause 和可操作上下文；不得用空 `catch`、模糊返回值或日志后继续执行来隐藏失败。
- 可变状态和副作用限制在最小范围；文件、进程、网络、事务和临时资源必须有明确生命周期与清理路径。
- 注释解释约束、风险和决策原因，不复述代码；复杂实现应先通过命名和结构自解释。
- 测试描述可观察行为，覆盖成功、边界、失败和恢复路径；不得依赖真实公网、时间竞态或测试执行顺序。
- 每次修改顺手改善所触及代码的可读性，但不得借 Clean Code 之名重写无关模块或引入没有当前用途的抽象。

## 2. 不可妥协的产品约束

### 2.1 两种模式必须共享核心

AutoForge 必须支持：

- `lite`：SQLite 持久化任务与业务数据，本地文件系统保存对象，进程内缓存/工作器；无外部服务依赖。
- `full`：PostgreSQL、NATS JetStream、MinIO 和 Redis；允许 Web、调度器和工作器独立扩展。

所有领域规则、应用用例、API 契约和主要 UI 都必须共享。模式差异只能位于组合根、配置和基础设施适配器。

Runner Agent 也必须共享：同一个 Agent 通过控制面协议连接 Lite 或 Full，不得要求 Agent 针对数据库或消息队列选择不同构建。

禁止：

- 在页面、Route Handler、Server Action 或领域服务中散落 `if (mode === ...)`。
- 从领域层或应用层直接导入 PostgreSQL、SQLite、NATS、MinIO 或 Redis 客户端。
- 让 Lite 启动过程连接、探测或要求安装 Full 的服务。
- 只在 Full 下测试关键业务流程。
- 将 Redis、队列消息或本地缓存作为业务事实的唯一来源。
- 让 Runner Agent 直接访问 PostgreSQL、SQLite、NATS、Redis 或 MinIO 长期凭据。

### 2.2 离线是运行边界

应用在阻断所有出站网络时仍须正常安装和运行。不得在运行时依赖：

- CDN、Google Fonts 或其他远程静态资源；
- SaaS 遥测、在线配置、在线许可证校验；
- 构建时未固化的远程脚本、二进制或浏览器下载；
- 自动拉取容器镜像或 npm 包。
- Runner Agent 首次执行时临时下载浏览器、驱动、SDK 或测试运行时。

新增依赖时检查许可证、体积、原生二进制支持和离线获取方式。发布物应使用精确版本、lockfile、镜像 digest、校验和与 SBOM。

### 2.3 Lite 是正式产品形态

每个新功能都要回答：

1. Lite 如何持久化？
2. Lite 如何执行或调度？
3. 无 MinIO 时产物保存在哪里？
4. 无 Redis 时正确性如何保证？
5. 无 NATS 时崩溃恢复如何完成？
6. 本地或远程 Runner Agent 如何通过同一控制协议完成执行？

如果不能回答，不得默认只实现 Full；应先定义端口和 Lite 行为，或在设计文档中明确记录暂不支持的原因与用户影响。

## 3. 技术基线

- Node.js：24 LTS，`package.json#engines.node` 使用 `>=24 <25`。
- Next.js：16.x 最新稳定版；初始化时锁定具体版本，不把 `latest` 写入清单。
- React：与 Next.js 官方支持版本一致。
- TypeScript：开启 `strict`，禁止用全局 `any` 或关闭检查掩盖问题。
- 包管理：pnpm workspace；仓库只能有一个 `pnpm-lock.yaml`。
- 路由：App Router。
- Runner Agent：Go 1.26.x 守护进程，发布工具链固定到 Go 1.26.5，通过 HTTPS Runner Protocol 连接控制面。
- 数据访问：Drizzle ORM，PostgreSQL 和 SQLite 使用显式方言适配器与独立迁移。
- 输入校验：Zod；所有环境变量、HTTP 输入、消息和执行机上报都需在边界校验。
- 单元/组件测试：Vitest；端到端测试：Playwright。

更新框架主版本或替换上述核心选型前，应新增 ADR，说明迁移成本、Lite/Full 影响、离线影响及回滚方案。

## 4. 目标模块与依赖方向

目标依赖方向如下：

```text
UI / HTTP / Worker entrypoints
              |
              v
        application
         /         \
        v           v
     domain      contracts
        ^           ^
        |           |
 infrastructure adapters
 (db / queue / object / cache)
```

### `packages/domain`

包含实体、值对象、状态机、领域事件和领域错误。它必须：

- 是纯 TypeScript；
- 不依赖 Next.js、React、ORM、网络或文件系统；
- 不读取环境变量和系统时间；时间、ID 等通过参数或端口传入；
- 用不变量保护状态迁移，而不是依赖 UI 隐藏按钮。

### `packages/application`

包含应用用例、事务边界、授权编排和基础设施端口。它可以依赖 `domain` 与 `contracts`，不得依赖具体适配器。

### `packages/contracts`

包含 HTTP DTO、任务消息、事件、执行机协议和版本化 schema。契约应：

- 可序列化，避免类实例或数据库类型；
- 在生产者和消费者两端校验；
- 对兼容字段使用可选新增，破坏性变更提升契约版本；
- 不包含密码、访问密钥或未脱敏环境变量。

### `packages/testng-discovery`

只负责对 JAR 与 JVM class 文件做有界静态分析。它可以依赖 `contracts` 和 application 定义的发现端口，但不得加载、链接、初始化或执行上传的 class。

- 新识别的 TestNG 语义必须有使用合成 class fixture 或真实最小 JAR 的测试。
- JAR 条目数、解压总量、单 class 大小和发现类数量必须有上限，禁止无界解压或无界警告列表。
- 损坏或无法支持的单个 class 可以产生有界警告；整个 JAR 的格式、体积或解压限制失败必须拒绝导入。
- `testng.xml`、继承注解、多版本 JAR、工厂和动态测试等未实现语义必须明确返回警告或写入文档，不能静默声称完整发现。
- 一个 TestNG class 映射一个 `CaseDefinition`，导入内容写不可变 `CaseVersion`；重载方法必须保留 JVM descriptor。
- 原始 JAR 以服务端生成的内容摘要对象键保存，用户文件名不得成为文件系统路径。

### 基础设施包

`db`、`queue`、`object-store`、`cache` 实现 application 定义的端口。每类适配器必须通过共享契约测试，确保 Lite 与 Full 的可观察行为一致。

### `apps/web`

页面、Route Handlers 和 Server Actions 保持轻薄：解析输入、鉴权、调用应用用例、映射响应。默认使用 Server Components；只有需要浏览器状态、事件或浏览器 API 时才加入 `"use client"`。

### `apps/worker`

只负责进程生命周期、消费、心跳、并发和关闭流程。任务业务逻辑属于 application/domain，不得复制到 worker 入口。

### `apps/runner-agent`

使用 Go 编写、安装在执行机上的守护进程，负责注册、心跳、领取、续租、命令执行、日志与产物采集、断线恢复和关闭排空。它不得依赖 Web UI、ORM 或服务端基础设施适配器；协议 DTO 必须与 `contracts` 的版本化 schema 通过兼容测试保持一致。

### `packages/runner-sdk`

包含控制面侧 Runner Protocol 契约解析、认证、重试和兼容协商。传输错误与业务拒绝必须区分，不允许在 SDK 中执行具体命令。Go Agent 的客户端实现位于 `apps/runner-agent`，不得通过复制粘贴形成无版本约束的第二套协议。

### `packages/executors`

包含 `process`、未来的 `container` 等执行器以及工作目录、进程监督、日志流和资源限制的共享实现。执行器不负责全局调度、数据库写入或 HTTP DTO 映射。

## 5. 领域语言

代码、API 和数据库统一使用以下英文术语，中文只用于界面与文档：

| 中文       | 代码术语         | 含义                             |
| ---------- | ---------------- | -------------------------------- |
| 用例       | `CaseDefinition` | 可编辑的用例定义                 |
| 用例版本   | `CaseVersion`    | 不可变的版本快照                 |
| 执行批次   | `RunBatch`       | 一次批量请求的聚合根             |
| 执行任务   | `ExecutionRun`   | 单个用例的一次执行               |
| 执行尝试   | `RunAttempt`     | 重试产生的一次实际尝试           |
| 执行机     | `Runner`         | 注册到平台的执行节点             |
| 执行机代理 | `RunnerAgent`    | 安装在 Runner 上的守护进程       |
| 租约       | `Lease`          | 有有效期的任务占有权             |
| 执行规格   | `ExecutionSpec`  | Agent 校验并执行的版本化命令契约 |
| 日志块     | `LogChunk`       | 带流类型和连续序号的日志载荷     |
| 产物       | `Artifact`       | 日志、报告、截图、录像等对象     |

不要混用 `job`、`task`、`run` 表达同一个领域概念。`Job` 仅用于队列内部载荷，用户可见执行记录使用 `ExecutionRun`。

## 6. 数据规则

- ID 在应用层生成，优先采用 UUIDv7；不要依赖数据库自增或数据库专用默认函数。
- 时间语义统一为 UTC；领域中使用 `Date` 或明确的时间值对象，API 输出 ISO 8601。
- 金额以外的计数、时长和字节数使用整数，时长字段名带单位，如 `durationMs`。
- 写操作必须有明确事务边界；事务中不得执行长耗时网络或子进程操作。
- 数据库 schema 不直接充当 API schema，必须显式映射。
- PostgreSQL 与 SQLite 分别维护迁移历史；禁止启动时使用自动 `push` 修改生产 schema。
- 新迁移必须同时验证：全新建库、从上一版本升级、失败回滚或恢复说明。
- SQLite 启用外键、WAL 和 busy timeout；保持写事务短小，不假定其支持高写并发。
- JSON 字段要有应用层 schema 和版本，不把无法查询的任意数据当作长期模型。

数据库方言能力不同时，优先将一致语义放入仓储接口。不得把 PostgreSQL 特有 SQL 复制到 Lite 路径后静默降级。

## 7. 任务、消息与并发

队列交付统一视为 **at-least-once**，无论底层是 JetStream 还是 SQLite。

### 必须遵守

- 每条任务包含稳定 `messageId`、`runId`、`attempt`、`schemaVersion` 和创建时间。
- 消费者必须幂等；重复消息返回已知结果，不重复产生副作用。
- 每个异步阶段先持久化自身结果，再确认对应消息。调度消息在 assignment 持久化后确认，不得跨越整个远程执行周期保持未确认。
- Agent 领取 assignment 后由 lease 保证执行权；完成结果持久化后才确认 Agent 的完成上报。
- 使用有期限的租约，而不是永久 `running` 标记；执行机需续租。
- 达到最大尝试次数后进入明确的失败/死信状态，并保留诊断信息。
- 取消、超时、执行完成竞争时，通过带版本条件的状态更新决定唯一终态。
- 进程关闭时停止领取新任务，给在途任务有限的排空时间，随后释放或等待租约过期。

### Full

- JetStream 使用持久 consumer、显式 ack 和有界 redelivery。
- 发布业务事件时采用 transactional outbox，避免数据库提交成功但消息丢失。
- stream、subject、consumer、ack wait、max deliver 和保留策略必须以代码或版本化配置管理。
- 消息负载保持小型；大日志和产物写对象存储，消息只传引用。
- Runner Agent 不直接消费 JetStream。Dispatcher 消费内部调度消息并持久化 assignment，Agent 只通过 Runner Protocol 领取。

### Lite

- SQLite 队列表至少包含状态、优先级、可用时间、租约所有者、租约到期、尝试次数和去重键。
- 领取任务必须是原子的条件更新；不得先查询再无条件更新。
- 定期回收过期租约，但不能回收仍被有效续租的任务。
- 轮询必须有退避，空闲时不得形成高频写入。
- 本地或远程 Runner Agent 均通过控制面领取 assignment，不允许远程 Agent 直接打开 SQLite 文件。

## 8. 对象、缓存与本地文件

### ObjectStore

对象端口至少支持写入、流式读取、存在性检查、删除和受控下载。对象键由服务端生成，禁止直接使用用户文件名作为路径。

- Lite：对象位于 `AUTOFORGE_DATA_DIR/objects`，先写同文件系统临时文件，校验完成后原子重命名。
- Full：通过 S3 兼容 API 使用 MinIO；bucket、保留期和 multipart 限制显式配置。
- Runner Agent 只获取短期、单对象、限大小的受控上传目标，不持有 MinIO 长期访问密钥；Lite 通过控制面写本地 ObjectStore。
- 数据库保存对象键、大小、媒体类型、SHA-256 和创建时间。
- 删除业务记录与删除对象之间使用可重试清理任务，不假设跨数据库/对象存储事务。

### Cache

- 缓存 miss 必须能从权威存储恢复。
- 缓存 key 带命名空间和 schema 版本。
- 不缓存未脱敏密钥；不要让缓存 TTL 决定业务记录生命周期。
- 分布式锁只用于减少竞争，关键不变量仍由数据库约束或条件写保证。

## 9. API 与错误约定

- 对外 HTTP API 预留 `/api/v1` 版本前缀。
- 输入在入口校验，输出使用明确 DTO，不直接返回 ORM 行。
- 列表接口使用游标分页；限制 page size，避免无界查询。
- 错误响应包含稳定的机器码、可读消息和 `requestId`，不得包含堆栈或秘密。
- 业务冲突返回可区分的领域错误；不要把所有失败映射为 500。
- 修改操作考虑幂等键；批量接口返回每项结果或可追踪的批次 ID。
- 日志和事件中的 ID 应能关联 batch、run、attempt、runner 与 request。
- Runner Protocol 使用独立的版本化 schema；注册、领取、续租、日志和完成端点都必须认证、限流并限制请求体大小。

## 10. Runner Agent 与执行安全

运行自动化用例属于高风险边界。

协议与生命周期遵循 [Runner Agent 架构设计](./docs/architecture/runner-agent.md)。实现不得悄悄改变以下约束：

- Agent 只主动连接控制面；任务协议基线为 HTTPS JSON 与有界长轮询。WebSocket 可降低控制延迟并承载管理员显式开启的交互终端，但不得成为 assignment、lease 或执行结果正确性的依赖。
- 心跳表示 Agent 活性，lease 表示某次 attempt 的有效执行权，两者不得复用。
- Agent 重启后先 reconcile 本地 attempt；未经服务端确认不得自行重跑。
- Agent/Server 协议携带 `schemaVersion`，不兼容时明确拒绝并上报可操作错误。
- 注册使用一次性 bootstrap token，成功后换取可撤销、可轮换的 Runner 身份。
- spool 有磁盘配额、保留期和确认水位；达到上限不得静默丢弃日志或结果。
- 使用 `spawn(executable, args, { shell: false })` 一类参数化调用；禁止拼接用户输入后交给 Shell。
- 复杂脚本作为已校验 SHA-256 的输入文件下发，再通过明确解释器及参数数组执行；Shell 执行器默认禁用。
- 每次执行使用新的受控工作目录，规范化并校验所有路径。
- 对 CPU、内存、磁盘、进程数、执行时间、日志大小和产物大小设置上限。
- 子进程及其后代必须能在取消或超时时被可靠清理。
- 密文只在需要时注入执行环境，日志、错误、事件和产物元数据均需脱敏。
- stdout/stderr 分流读取，使用 `(attemptId, stream, sequence)` 去重；网络中断后从服务端确认水位重传。
- 上传内容检查大小、类型、校验值和路径；下载使用安全的内容处置头。
- 产物 glob 相对 attempt 目录解析，拒绝绝对路径、`..`、设备文件和越界符号链接。
- Runner 身份可撤销、凭据可轮换；心跳不能代替任务租约。
- Runner 本地策略只能收紧控制面下发的命令和资源限制，不能放宽。
- 任何“沙箱”声明都必须列出实际隔离机制和已知边界。

## 11. 前端约定

视觉基线是[方案 E 前端设计](./docs/design/frontend-design.md)。Apple-like 仅表示轻盈、清晰和桌面应用般的空间层次；禁止复制 Apple Logo、SF Symbols 或专有产品资产。概念图不得作为页面背景、切图或像素级实现捷径。

- 页面优先服务端取数；不要为简单查询引入全局客户端状态。
- 交互组件保持小而专一，加载、空数据、错误、无权限和离线状态都要明确呈现。
- 列表筛选条件进入 URL，支持刷新、分享与浏览器前进后退。
- 所有关键操作支持键盘；表单控件有可访问名称，状态不能只靠颜色表达。
- 时间展示用户时区，同时在详情中可查看 UTC 原值。
- 大日志使用分页或虚拟化，不把完整日志注入初始 HTML。
- 不引用远程字体或 CDN 资源。
- 颜色、圆角、阴影、间距和动效必须使用语义 token，不在组件中散落魔法值。
- 首页使用 Bento 信息分组；管理表格和日志仍保持专业密度，不为追求大留白牺牲可用性。
- Lite/Full 模式是只读部署信息，不实现成可以随手切换且误导用户的前端开关。
- 图标使用版本锁定、可离线打包且许可证明确的开源资源，不使用生成式图片作为正式功能图标。

## 12. 测试矩阵

每项行为选择最低成本且足够可信的测试层级：

- **领域单元测试**：状态机、不变量、重试、超时、取消竞争。
- **应用测试**：使用内存 fake 验证编排，但 fake 不替代适配器集成测试。
- **适配器契约测试**：同一套用例分别运行 SQLite/PostgreSQL、SQLite queue/JetStream、本地 FS/MinIO、内存/Redis。
- **集成测试**：真实迁移、事务、重复消息、租约过期、对象失败补偿。
- **Runner Agent 测试**：命令成功/失败、超时、取消、进程树清理、日志跨块/重传/脱敏、spool 恢复和恶意产物路径。
- **协议兼容测试**：相邻 Agent/Server 版本兼容，不兼容版本明确拒绝；同一 Agent 分别连接 Lite 与 Full。
- **E2E**：至少覆盖 Lite 的创建用例 -> 执行 -> 查看日志/产物 -> 分析闭环；Full 覆盖关键基础设施路径。
- **离线验收**：阻断出站网络，从发布物启动并完成核心闭环。
- **Agent 离线验收**：从离线包安装、注册，在无公网环境完成一个命令用例并上传日志和产物。

修复缺陷时先添加能够复现问题的测试。涉及适配器语义的修改，必须同时运行 Lite 和 Full 对应测试。

## 13. 质量门禁

脚手架建立后，根 `package.json` 应提供并维护以下统一命令：

```text
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:full
pnpm test:e2e
pnpm build
```

提交变更前运行与变更范围匹配的最小充分集合。交付说明应列出实际执行的命令和结果；未运行的检查要说明原因，不得声称通过。

代码要求：

- 优先使用清晰的小函数和显式类型，不以抽象层数代替可读性。
- 只在边界捕获错误；保留 cause，并映射为稳定领域/API 错误。
- 禁止空 `catch`、未处理 Promise、无界重试和无界并发。
- 不提交密钥、真实凭据、生产数据、构建产物或本地 SQLite 数据库。
- 注释解释原因、约束和权衡，不复述代码。
- 不顺手重构无关代码；保留用户已有改动。

## 14. 配置与依赖

- 环境变量必须集中定义、校验和文档化；业务模块不得零散访问 `process.env`。
- 可选依赖必须真的可选。Lite 的模块图和启动路径不能因顶层 import 加载 Full 驱动。
- Runner Agent 的源码模块、配置和运行职责与服务端分离；主平台发布物内置受校验的 Agent 资源，不再单独发布 Agent Release 资产。不得向 Agent 传递数据库、NATS、Redis 或 MinIO 长期凭据。
- Agent 需要的浏览器、驱动和 SDK 必须由版本化 Runner 镜像或预置工具链提供，不允许运行时自动下载。
- 新增生产依赖前检查维护状态、许可证、体积、Node 24 支持、原生构建和离线打包。
- 优先采用标准 API 和小型依赖，避免多个库解决同一问题。
- 版本升级应提交 lockfile，并运行受影响测试；框架安全更新优先处理。

### 14.1 发布与平台矩阵

- GitHub Release 只从已存在且指向当前提交的语义版本 tag（`vX.Y.Z`）发布，禁止从未标记分支或可变引用生成正式包。
- 后端离线 Docker 镜像必须生成 `amd64`、`arm64`、`amd64-musl`、`arm64-musl` 四个明确命名的资产；每个镜像都内置 Linux `amd64` 与 `arm64` 两个静态 Agent 资源，不生成独立 Agent Release 资产。
- 后端标准版基于固定 digest 的 Debian/glibc Node 镜像，musl 版基于固定 digest 的 Alpine/musl Node 镜像；不得仅复制或重命名同一个镜像伪造变体。
- 内置 Agent 使用 `CGO_ENABLED=0` 静态构建，不动态链接 libc；资源清单记录版本、架构、大小和 SHA-256，安装前后均须校验。
- GitHub Actions 的 `amd64*` 目标使用 `ubuntu-24.04`，`arm64*` 目标使用原生 `ubuntu-24.04-arm`；不得在 GitHub-hosted Release 流水线中用 QEMU 模拟已有原生 runner 的架构。
- Release 同时包含每个后端/部署资产的 SPDX JSON SBOM、统一 `SHA256SUMS` 和机器可读 `release-manifest.json`；镜像 SBOM 覆盖其中的内置 Agent。
- GitHub Actions 与基础镜像使用不可变 commit SHA 或镜像 digest；版本升级要单独审查并完成构建验证。
- 发布脚本必须能在本地构建并验证单个平台；正式四平台集合由 GitHub Actions matrix 生成，任何一个目标失败都不得发布部分 Release。

## 15. 可观测性

- 使用结构化日志，不用散落的 `console.log` 作为生产日志方案。
- 日志至少包含 `timestamp`、`level`、`message`、`requestId`；执行路径补充 `batchId`、`runId`、`attemptId`、`runnerId`。
- 区分 Agent 自身诊断日志和用例 stdout/stderr；二者使用不同 stream/字段且都执行秘密脱敏。
- 健康检查区分 liveness 与 readiness。Lite readiness 检查数据目录和 SQLite；Full 检查所需服务，但使用有界超时。
- 指标名称、单位和标签基数受控；不得把 run ID 等高基数字段作为指标标签。
- 可观测性导出默认可关闭，关闭后不得发出外部请求。

## 16. 变更工作流

1. 阅读根 README、本文件及目标目录内更具体的说明。
2. 检查工作树，确认并保留不属于当前任务的修改。
3. 明确功能在 Lite 与 Full 的行为，以及 Runner Agent、失败和恢复路径。
4. 先修改领域/契约和测试，再接入适配器与入口。
5. 运行格式、类型、测试和构建中与变更相关的检查。
6. 更新 README、`.env.example`、迁移、ADR 或运维文档。
7. 汇报实现结果、验证证据、已知限制和必要的后续事项。

## 17. 完成定义

一项功能只有同时满足以下条件才算完成：

- 用户可见主流程可用，失败、空状态、取消和超时有清晰行为。
- Lite 可用且无 Full 隐性依赖；Full 适配器行为与契约一致。
- 同一 Runner Agent 能通过版本化控制协议连接 Lite 与 Full，断线、重复、取消和重启路径经过验证。
- 权限、输入校验、幂等、并发和秘密处理已经考虑。
- 必要迁移、配置、备份/恢复影响和离线资源已处理。
- 自动化测试覆盖核心逻辑和受影响适配器。
- 相关质量命令实际通过。
- 文档与实现一致，没有把计划描述为现实。

如需求与这些约束冲突，不要静默绕过；记录冲突、用户影响和候选方案，等待明确决策或通过 ADR 固化结论。
