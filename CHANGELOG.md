# Changelog

All user-visible changes are recorded here. AutoForge follows semantic versioning; release notes must
also list database migrations, persisted-configuration changes, compatibility changes, offline assets,
and known limitations.

## Unreleased

### Added

- Full 五主机完整部署模板：三个默认启动 Web/worker 的主平台、一台无域名 Nginx、一台集中 PostgreSQL/Redis/NATS/MinIO 的主机；每台附独立 Compose 和环境示例，统一纳入版本化 Release 部署包。
- Full 多机器部署模板：独立 PostgreSQL、Redis、NATS JetStream、MinIO，多个 Web/worker 共享服务，并通过 Nginx 分发请求。
- 平台节点管理：持久节点 ID、名称、IP 和端口，使用共享 PostgreSQL 保存、revision 防并发覆盖和审计。
- 节点本地日志路由：正文继续保存在所属节点 SQLite 文件中；PostgreSQL 保存批次归属与确认水位，内部 HMAC 请求转发日志，支持旧文件登记及节点恢复后的继续读取。
- Redis 实时日志转发和有界近期缓存；发布前复用持久日志的脱敏规则。
- 新增可选 NATS Token 配置；分布式平台公共配置由文件统一管理，提供保留共享密钥并生成独立节点身份的准备命令。

### Fixed

- 离线运行包完整收集 Redis 的 scoped package、间接依赖与 peer dependencies；发布验证在断网容器中检查 Redis/NATS 可加载。
- 镜像预建应用账号所属的配置目录，确保新数据卷挂载只读节点配置后正常启动；部署包排除实际配置、生成凭据和节点数据。

### Database and operations

- PostgreSQL `0061_platform_log_nodes.sql`、SQLite `0062_platform_log_nodes.sql` 增加节点与日志位置元数据；不搬移日志正文。
- 从单机 Full 升级时停止旧实例，备份全部状态并先启动原日志节点；配置与各节点日志卷必须分别保留。
- 首版终端网关固定在一个节点，未实现日志副本或自动迁移；节点离线时所属历史日志明确返回不可用。

### Tests

- Release 打包检查五主机文件完整性、镜像版本替换和敏感文件排除；部署验收解析全部五份 Compose。
- 增加双节点独立日志目录契约、内部请求认证、Redis 实时缓存和 Nginx 后的节点管理 / 跨节点日志 Playwright 验收。
- `pnpm test:distributed` 和 CI / Release checks 增加独立分布式部署验收。
- 新增 `Full distributed acceptance` 独立流水线与强制结果门：覆盖双节点 WebSocket、Redis 重启、日志节点停止/恢复，以及通过 Nginx 执行的真实 Go Runner；保留脱敏诊断并拒绝跳过、空报告与重试掩盖失败。

## 1.9.6 - 2026-09-05

### Fixed

- 修复窄桌面顶栏的工具区被压缩后，通知按钮与“开始执行”按钮发生重叠的问题；配置搜索与
  通知按钮保留所需宽度，项目、版本和阶段选择器在剩余空间内缩放并保留文本省略。
- 首页趋势 E2E 改为核对真实执行数据按平台时区聚合后的日期，移除固定的 `09-04` 断言，
  避免日期变化导致 Lite、Full 和发布资产验收误报失败。

### Database and persisted configuration

- 无数据库迁移或持久化配置变化。

### Compatibility and offline assets

- 不改变 HTTP API、Runner Protocol 或任务执行语义；未新增依赖或远程资源。

### Tests

- 新增带未读通知的顶栏桌面宽度回归场景，检查 1024px、1180px、1280px 和 1536px。
- 布局检查等待浏览器完成响应式布局绘制后再采集几何尺寸，避免在调整视口的中间帧误报控件
  重叠；字号、控件尺寸、重叠和页面溢出检查保持不变。
- 保留完整轮次流程与 JAR 导入闭环的布局、通过率和日期断言。

## 1.9.5 - 2026-09-05

### Added

- 用例任务采用更大的统计卡片，展示近 7 天执行次数、平均通过率和平均通过用例数；点击
  “最近执行”可在卡片下方展开最近 10 次执行的状态、通过用例数、轮次、时间和耗时，并跳转
  批次详情或当前任务的完整执行记录。支持加载失败重试、空记录提示和键盘展开/收起。
- DDT 表格预检发现大小写不敏感的重复列名时，打开人工处理弹窗，并排显示冲突列的位置、非空
  数量和有界内容样例；每列可改名保留或整列删除，每组至少保留一列，重新预检通过后才允许启动
  后台导入。

### Changed

- Jenkins 执行与依赖发布插件共用控制台日志组件，按开始、进度和结果分段展示中文日志；
  实时进度和完整结果使用 Jenkins 原生控制台超链接，保留 Pipeline 返回的 URL 字段。

### Database and persisted configuration

- 无数据库迁移。人工列名映射和删除选择复用导入任务已有的 `uploads_json` 持久化，Lite SQLite
  与 Full PostgreSQL 使用相同语义；后台 Worker 按预检确认的选择再次解析原始文件。
- 任务统计直接聚合已有批次和执行事实，Lite/Full 使用同一口径，不新增持久化配置或缓存事实。

### Compatibility and offline assets

- 新增 `POST /api/v1/ddt/imports/{jobId}/resolve-columns`；原预检和确认 API 保持兼容。处理过程直接
  读取 ObjectStore 中已保存的原文件，不要求浏览器重复上传，也未新增运行时依赖或远程资源。
- 新增 `GET /api/v1/case-suites/{suiteId}/executions`，同时校验任务与执行记录读取权限，并限制
  项目和项目版本范围。Runner Protocol 与已有任务执行语义保持兼容。
- Jenkins 共享控制台库随两个现有 HPI 打包，不增加独立插件安装项。

### Known limitations

- 近 7 天次数按批次创建时间统计，均值只对已结束且包含用例的批次等权计算；包含异常、终止
  和最后失败再次执行，排除日志诊断重跑。没有已结束样本时显示“—”。

### Tests

- 新增任务统计应用测试、SQLite/PostgreSQL 共享仓储契约与 API 权限/版本隔离测试；Playwright
  覆盖展开、重试和记录跳转，并人工检查 1024px、1280px、1536px、1920px 桌面截图。
- 解析器覆盖 XLSX 大小写重复列、内容样例、保留/删除选择和 ZIP 内 CSV 重复列；
  SQLite/PostgreSQL 仓储覆盖预检替换语义。
- Playwright 构造双“环境”列，验证弹窗同时展示两列内容、重复的新名称会被前端阻止、删除其中
  一列后可重新预检和后台导入，并确认被删除列的数据未进入用例。

## 1.9.4 - 2026-09-04

### Added

- 顶栏新增按当前权限过滤的配置搜索，可检索平台、项目、访问和运行配置；平台字段结果会直接进入
  对应设置分区并聚焦控件。
- 具有 `audit.read` 权限的系统管理员、项目管理员和自定义高权限角色可进入“分析统计”，分页查看
  人员认领/完成数量、三类结论占比，并审阅每位人员逐条填写的分析内容。

### Changed

- 工作概览的用例规模和近两周质量聚合改为按项目版本持久化快照。Lite 内嵌 worker 与 Full 独立
  worker 按“公开大盘刷新间隔”轮换刷新已访问范围，首页不再为每次访问重复扫描用例和分析事实。
- JAR 确认导入后的上传与后台任务进度移动到确认结果下方，并自动滚动到当前视口。

### Fixed

- 删除 JDK 包后局部修补目录树并恢复可达到的浏览位置，目录展开状态保持不变，不再跳回页面顶部
  或重新请求完整存储清单。

### Database and persisted configuration

- SQLite 新增迁移 `0061_dashboard_snapshots.sql`，PostgreSQL 新增迁移
  `0060_dashboard_snapshots.sql`，用于保存可重建的项目版本首页快照；业务事实仍由原仓储负责。
- 无平台持久化配置格式或 Runner Protocol 变化。

### Compatibility and offline assets

- 新增只读失败分析统计 API；现有认领和分析 API 保持兼容。统计访问复用 `audit.read` 权限，普通
  分析人员不会获得跨人员读取能力。
- 未新增运行时依赖、远程资源或离线资产，Lite/Full 与现有 Runner Agent 保持兼容。

### Known limitations

- 首页质量快照继续只聚合当前范围最新最多 10,000 条分析事实；完整精确查询仍通过质量洞察和导出
  提供。首次访问尚无快照的项目版本时会同步建立一次，后续由 worker 周期刷新。

### Tests

- 新增首页快照应用测试和 SQLite/PostgreSQL 仓储集成测试，并扩展失败分析双数据库共享契约。
- Playwright 覆盖 JAR 进度位置、快照更新、配置搜索与字段聚焦、存储树展开/滚动保持，以及分析统计
  汇总和逐条内容弹窗；人工审查 1024px、1536px 和 1920px 截图。

## 1.9.1 - 2026-09-04

### Added

- 存储空间目录中的 JDK 包与依赖包支持复选和悬浮批量删除操作；批量请求逐项校验引用关系，
  部分失败不会阻断其他资源，失败项会保留选择并显示原因。

### Changed

- 执行机页面不再平铺 SSH 主机、密码和安装参数；页面保留轻量自动安装入口，点击后在带焦点约束、
  Escape 关闭和内部滚动的系统弹窗中完成探测、指纹确认、安装及回滚。

### Fixed

- 工作概览的本周与上周统计改为分别聚合当前筛选下最新最多 10,000 条分析事实，近期批次和
  执行机组也在数据库关联聚合前限制为页面实际需要的窗口；修复历史执行数据较多时首页长时间
  加载并阻塞 Lite 控制面的问题。首页明确显示采样上限，质量洞察和导出仍保持完整精确查询。
- 删除存储资源后直接局部更新目录树与空间汇总，不再重新扫描数据目录和对象存储，避免每删除
  一个文件都触发整页加载和目录展开状态丢失。
- 用例管理的 TestNG 与 DDT 切换改为工作台内即时切换；访问过的面板保持挂载，TestNG 已加载目录、
  搜索、勾选和详情状态不再因切换到 DDT 后返回而丢失。
- 执行记录详情的用例搜索框设置稳定的最小弹性宽度，长关键字和异步筛选期间不再被相邻控件压缩。

### Database and persisted configuration

- 无数据库迁移、持久化配置格式或 Runner Protocol 变化。

### Compatibility and offline assets

- `DELETE /api/v1/settings/storage` 保留原有单项请求，并新增最多 100 项的批量请求；Lite 本地对象
  与 Full MinIO 对象继续使用同一应用层删除规则。未新增运行时依赖或离线资产。
- 首页有界统计在 Lite/SQLite 与 Full/PostgreSQL 下使用相同契约；未改变 Runner Protocol、任务
  调度和执行语义。

### Tests

- 新增 100,005 条分析事实的首页有界读取与延迟回归门禁、SQLite/PostgreSQL 执行机组限量契约，
  并扩展真实数据 Playwright 场景验证首页采样说明。
- 新增批量删除契约、部分失败继续处理、客户端容量汇总修补测试，并扩展 Playwright 存储空间场景，
  验证悬浮批量操作、二次确认、对象删除，以及删除完成后不重新请求存储清单。
- Playwright 新增自动安装弹窗、TestNG/DDT 无页面请求切换及长关键字搜索框宽度回归断言。

## 1.9.0 - 2026-09-04

### Changed

- 工作概览增加按活动执行、失败方法、不可用执行机和用例资产选择的“今日工作焦点”，并补充
  活动批次、方法结果、可用槽位和可执行覆盖四项关键状态。方案 E 的六卡 Bento 继续使用真实
  权威数据，新增方法结果构成与耗时、多个活动批次、用例启停覆盖、在线资源利用率、失败原因
  占比和执行/导入动态摘要；未配置分组时仍展示在线执行机的系统、版本、槽位与 CPU 数据，
  并补充最近心跳以判断数据新鲜度；失败洞察增加失败类型、记录和不稳定用例计数；
  质量卡明确显示统计生成时间，趋势补充纵轴刻度、最新点精确值和对齐的日期标签，单日期使用
  完整基线表达，没有历史样本时不再显示误导性的周环比；1024px 至 4K 桌面布局保持完整可用。

### Database and persisted configuration

- 无数据库迁移、持久化配置或 Runner Protocol 变化。

### Compatibility and offline assets

- 本版本仅调整共享首页展示与有界数据聚合，Lite/Full 模式、Runner Agent、Jenkins 集成和既有 HTTP 契约保持兼容。
- 未新增运行时依赖、远程资源或离线资产，阻断出站网络时的运行边界不变。

### Known limitations

- 工作概览只展示有界的近期批次和执行机摘要；完整历史与明细仍需通过执行记录、质量洞察和执行机页面查看。

### Tests

- 新增首页活动批次聚合、执行机容量和工作焦点优先级单元测试，并扩展 Playwright 首页布局场景，
  覆盖新增决策层、业务数据区块和 1024px、1536px、2K、4K 视口。

## 1.8.19 - 2026-09-03

### Added

- 平台配置新增可选的“内部访问地址（Runner）”。Runner Agent 安装与重新安装优先使用内部地址，
  外部访问地址继续用于匿名分享、导出日志和 Jenkins 链接；旧配置未填写内部地址时保持回退兼容。

### Fixed

- CoTest Adapter 不再包含 `List.of`、`Path.of`、`String.isBlank` 等 Java 9+ API，并改为 Java 8
  字节码；项目提供 JDK 8 与兼容的 TestNG/业务依赖时可直接执行，不再因 Adapter 自身出现
  `UnsupportedClassVersionError`。仍只发布一个 Adapter，Agent 无需维护双版本选择逻辑。
- 用例分析选择“重跑通过”后，必须先在弹窗内主动查找成功的日志重跑记录。找到时立即显示永久日志，
  未找到的用例必须粘贴通过截图后才能提交；最终提交仍由服务端重新校验，不能绕过前端限制。
- Runner 不再只按目录名排除 JDK 8 自带的 JRE；当重打包中 JDK 与另一个命名的 JRE 并列时，
  会根据唯一的 `bin/javac` 选择 JDK 根目录。归档包含多个完整 JDK 时仍拒绝执行，歧义错误会
  有界列出候选相对路径。

### Database and persisted configuration

- 无数据库迁移或 Runner Protocol 变化。`platform.json` 的 `web` 配置新增可选
  `runnerBaseUrl`；旧配置无需迁移，旧管理客户端省略字段时保留现值，显式清空时回退到外部地址。

### Tests

- CI 与 Release 新增真实 JDK 8 编译门禁，逐个校验 Adapter class major version 52，覆盖
  TestNG 6.14.3/7.5.1，并保留 JDK 21 + TestNG 7.11.0 兼容回归测试。
- 新增重跑证明预查、缺少截图禁止完成、内部地址优先级/兼容回退和相关浏览器流程测试。
- Runner 单元测试与批次输入共享 E2E 归档覆盖 JDK 8 的并列 JRE 重打包结构，并继续验证多个
  完整 JDK 不会被任意选择。

## 1.8.18 - 2026-09-03

### Fixed

- Runner 现在能正确识别同时包含 JDK 根目录 `bin/java` 与内置 JRE `jre/bin/java` 的标准
  JDK 8 压缩包，不再误报存在两个独立 JDK；归档内确实包含多个并列 JDK 时仍会拒绝执行。

### Database and persisted configuration

- 无数据库迁移、持久化配置格式或 Runner Protocol 变化。

### Tests

- Runner 单元测试覆盖逐 attempt 与批次共享工作区的 JDK 8 双 Java 入口解压路径，并保留多个
  独立 JDK 必须拒绝的安全回归测试。

## 1.8.16 - 2026-09-03

### Fixed

- 修复批跑并发上传压缩日志时，单次请求把最多 256 个 gzip 工作一次性排入 Node.js 共享
  工作队列，导致已完成用例的公开日志解压长期饥饿，并连带阻塞平台文件/加密操作的问题。
  日志编解码现在使用有界并发调度，读取享有有限优先权且不会饿死写入；压缩格式、现有日志、
  Runner Protocol 和 Lite/Full 持久化语义不变。
- 修复关键字搜索在异步解压期间遇到批次日志 SQLite 句柄被 LRU 驱逐后，继续使用已关闭连接
  而读取失败的问题；每个内部扫描页会重新获取有效句柄。
- 修复整轮重跑把 Runner 基础设施重调度的物理 attempt 误当作新逻辑轮次，导致重跑上限为
  10 时页面出现第 12 轮、上一轮未完成即结束，以及额外“未执行”占位的问题。Runner 重调度
  现在保留在当前逻辑轮，普通失败才推进下一轮；轮次汇总取同一用例在该轮的最后一次物理尝试，
  基础设施异常历史仍完整保留。

### Database and persisted configuration

- SQLite 新增迁移 `0060_logical_execution_round.sql`，PostgreSQL 新增迁移
  `0059_logical_execution_round.sql`，为 `ExecutionRun` 和 `RunAttempt` 持久化独立逻辑轮次，
  并按历史普通失败与 Runner 基础设施失败回填现有批次；Runner Protocol 和任务配置不变。

### Tests

- 新增压缩积压下公开日志读取与无关文件操作优先完成的回归测试、异步解压期间日志句柄驱逐
  测试；2 万日志块性能基线改为覆盖实际 gzip 路径，并扩展 Playwright 批跑验收以覆盖多页
  压缩日志的永久公开页和并发健康检查。
- 新增 Lite/Full 共享调度契约、SQLite/PostgreSQL 升级迁移和领域轮次回归测试，覆盖 Runner
  重调度不推进逻辑轮、10 次重跑上限不产生第 12 轮，以及同轮最后物理尝试决定汇总结果。

## 1.8.15 - 2026-09-03

### Changed

- 存储空间目录为普通文件显示创建与修改时间；SQLite 主文件与同名 WAL、SHM 默认聚合成一个
  可展开节点，摘要显示合计大小和三者中最新的修改时间，展开后仍可逐个查看物理文件信息；
  每批次用例日志库同时显示其关联的任务批次号，并支持按该编号搜索。

### Database and persisted configuration

- 无数据库迁移、持久化配置格式或 Runner Protocol 变化。

### Tests

- 单元测试覆盖 SQLite 伴随文件乱序输入、聚合大小和最新时间；Playwright 覆盖默认收起、展开
  三个物理文件、创建/修改时间以及 1024px 桌面视口布局。

## 1.8.13 - 2026-09-03

### Fixed

- 所有带修订号保护的编辑入口在检测到并发修改时，统一显示站内警示弹窗，不再把“已被其他人
  修改”降级为按钮旁的内联文字。弹窗允许暂时保留当前输入，或明确重新加载服务端最新内容，
  并覆盖用例任务、用例、DDT、用例来源、Runner 组、Webhook、运行时与平台配置等入口。
- 并发修改弹窗使用独立的顶层遮罩层级，从 DDT 编辑抽屉等已有浮层内触发时仍可见、可操作；
  结构化 API 错误会保留错误码、请求 ID 与 HTTP 状态，避免前端丢失冲突类型。

### Database and persisted configuration

- 无数据库迁移、持久化配置格式、Runner Protocol 或离线资产兼容性变化。

### Tests

- 组件守卫会扫描全部修订保护编辑器和浏览器原生 `alert`/`confirm`/`prompt` 调用；Playwright
  覆盖用例任务冲突后的保留输入、重新加载，以及 DDT 抽屉内嵌套冲突弹窗的层级与后续保存。

## 1.8.12 - 2026-09-03

### Added

- “用例分析 → 我的分析”中的未完成用例新增“取消认领”操作。只有当前认领人可以取消，
  必须在站内确认弹窗填写原因；原因与认领人、认领时间、取消时间会持久化保存，取消后
  用例立即回到待认领状态，可由其他分析人员重新认领。
- 登录后的可见 Web 页面新增滑动会话续期：进入页面后及每 5 分钟同步延长服务端会话与
  HttpOnly Cookie；页面隐藏超过会话期限、账号停用、主动注销或管理员撤销后仍必须重新登录。

### Changed

- 用例分析认领页固定将未认领用例排在已认领用例之前，再按用户选择的类路径、名称、
  失败堆栈或认领状态排序；该分组顺序不随升降序反转，并支持跨分组稳定游标翻页。
- 顶栏通知角标改用独立的权限范围内未读总数，页面加载、窗口重新激活及每 30 秒主动同步，
  不再依赖用户先打开通知面板。
- 新写入的用例日志块在服务端日志存储边界选择性使用 gzip 压缩：正文达到 1 KiB 且至少
  节省 64 字节时保存压缩 BLOB，否则原样保存。Runner Protocol、分页、关键字/时间筛选、
  实时日志、永久公开日志和日志水位语义保持不变，读取时按日志块透明解压。

### Fixed

- 修复用例分析详情认领后“我的分析”角标和顶部已认领/已完成统计仍显示旧值的问题；本人
  总数由数据库独立统计，认领、取消认领和完成分析只局部更新计数，不触发页面级重渲染。
- 修复仅更新会话 `last_seen_at`、不延长数据库 `expires_at` 和 Cookie 到期时间，导致用户
  持续操作平台仍会在首次登录的固定时刻掉线的问题。

### Database and persisted configuration

- SQLite 新增迁移 `0059_failure_analysis_claim_releases.sql`，PostgreSQL 新增迁移
  `0058_failure_analysis_claim_releases.sql`，用于持久保存取消认领审计快照；现有分析记录、
  平台配置和 Runner Protocol 不变。
- 每批次日志 SQLite 首次打开时原位补充 `content_encoding`、`stored_size_bytes` 和
  `content_sha256` 列；该升级只修改表元数据，不重写既有日志。历史明文行继续兼容读取，
  新行可混合使用 identity/gzip 编码；主数据库无需新增迁移。

### Tests

- Lite/Full 共享仓储契约覆盖未认领优先、跨分组分页、本人取消、他人拒绝、原因持久化和
  取消后重新认领；Playwright 覆盖认领页排序、权威本人计数、必填原因弹窗、取消后即时移除
  及重新可认领。新增浏览器验收覆盖通知主动计数、已读即时扣减、前台自动续期以及数据库与
  Cookie 到期时间一致性。
- 批次日志仓储集成测试覆盖压缩收益判定、压缩 BLOB 元数据、幂等重传、跨内部扫描页搜索、
  透明分页解压以及旧版明文批次库的无重写升级。

## 1.8.11 - 2026-09-02

### Fixed

- 从永久公开日志页重新执行用例后，新生成的手动重跑 attempt 会自动刷新到当前页面的
  “执行历史”侧栏，不再需要用户手动刷新浏览器；仍在当前标签页内切换并保留实时日志入口。

## 1.8.10 - 2026-09-02

### Changed

- 用例分析候选表、个人分析队列、批量分析用例清单和历史结论卡片改为紧凑密度，减少单条
  用例的纵向占用；“我的分析”新增类路径、用例名称、失败堆栈、分析状态四种服务端排序及
  升降序切换，Lite/Full 使用与排序条件绑定的稳定游标继续翻页。
- 失败用例分析 XLSX 统一使用更适合中英文混排的微软雅黑 UI 字体、深蓝绿表头、低饱和
  斑马纹和结论分类配色；仍保留单行数据高度、冻结表头、筛选和三选一下拉框。

### Fixed

- 用例分析选择“重跑通过”且没有成功重跑日志时，证明截图改为在分析弹窗任意位置直接按
  `Ctrl+V`（macOS 为 `⌘+V`）粘贴，不再点击粘贴区打开系统文件选择器；单个与批量分析
  共用同一粘贴、对象存储和预览流程。

### Database and persisted configuration

- 无 schema 迁移、配置格式或 Runner Protocol 变化；个人分析排序由 Lite/Full 仓储共享
  同一请求语义和游标契约。

### Tests

- SQLite/PostgreSQL 仓储契约覆盖个人队列字段排序、降序翻页和同状态稳定翻页；10 万条
  Lite 性能门禁覆盖新排序查询。Playwright 覆盖字段选择、升降序、紧凑行高、XLSX 导出
  以及 1024px/1536px 桌面布局。

## 1.8.8 - 2026-09-02

### Changed

- “平台设置 → 存储空间”不再以表格分页平铺文件，改为按数据目录、对象存储、外部引用和
  逻辑路径直接展示可折叠目录树。后台游标批次会自动续读并合并，目录内部保持有界按需
  渲染，文件详情可查看完整逻辑路径、实际位置、空间大小、项目与更新时间。
- Lite 本地文件清单的游标续读会跳过已经遍历完成的目录，避免连续生成完整目录树时每批
  都从数据目录根部重复扫描；单次读取上限由 200 提升至 500，前端合并多批结果后再重建
  目录树，降低大目录的网络往返和渲染开销。

### Documentation

- Jenkins 执行与依赖发布插件的指导文件新增完整参数表，逐项标明必填/选填、类型、默认
  值、权限、格式校验与网络可达性要求，并补充选填参数和返回值示例。

### Database and persisted configuration

- 无 schema 迁移、配置格式或 Runner Protocol 变化；Lite 与 Full 共享相同的目录树页面和
  存储清单契约。

### Tests

- 存储清单单元测试覆盖目录聚合、深路径边界与跨批次游标续读；Playwright 覆盖目录树
  展开、文件详情、筛选、无分页控件和 1024px 桌面视口无横向溢出。

## 1.8.7 - 2026-09-02

### Fixed

- LDAP 首次登录现在把平台用户、外部身份、统一角色绑定、登录会话与成功审计作为一个
  原子操作提交。任一步骤失败都会完整回滚，不再出现首次提示“关联失败”、再次登录却已
  留下半创建账号或角色绑定的状态。
- Lite/SQLite 在首次登录遭遇短暂写锁竞争时会退避并重试整个幂等事务；Full/PostgreSQL
  会串行化同一用户名的并发首次登录，避免两个请求竞争唯一约束而误报账号关联失败。

### Database and persisted configuration

- 无 schema 迁移或配置格式变化；已存在的 LDAP 用户及角色绑定保持不变。

### Tests

- SQLite 集成测试覆盖末步失败完整回滚、锁竞争自愈与默认角色唯一性；PostgreSQL 集成
  测试覆盖完整回滚和并发首次登录。真实 OpenLDAP、LDAPS/明文 LDAP 与 Playwright
  生产构建验收通过。

## 1.8.6 - 2026-09-02

### Fixed

- LDAP 登录在升级遗留的目录身份 subject 与当前同名 LDAP 账号不一致时，改为以登录框
  用户名对应的平台账号为准，并只修复辅助外部身份关联。Lite/SQLite 与 Full/PostgreSQL
  不再因用户名唯一约束冲突返回通用 500，也不会删除或合并历史用户数据。
- 已保存 LDAP 配置损坏时返回可操作的重新保存提示；目录验证成功但账号关联或会话创建
  失败时，登录页展示请求 ID，服务端使用同一 ID 记录真实持久化错误。

### Database and persisted configuration

- 无 schema 迁移或配置格式变化；历史 LDAP 身份关联在用户下次成功登录时按需修复。

### Tests

- SQLite 与 PostgreSQL 集成测试覆盖历史 subject/用户名冲突及错误映射；真实 OpenLDAP、
  LDAPS/明文 LDAP 和 Playwright 生产构建验收通过。

## 1.8.5 - 2026-09-02

### Added

- 页面导航和大数据区域使用统一的产品化加载状态；质量洞察的筛选、不稳定用例分析与
  批次对比会在提交后立即展示明确的进行中反馈。
- 保存、删除、测试连接等一次性操作统一通过右上角悬浮通知反馈，并按成功、警告、错误
  和提示使用不同视觉状态。危险操作与输入确认统一迁移到站内弹窗，不再依赖浏览器原生
  `confirm` 或 `prompt`。

### Fixed

- 质量洞察不再把正常的 TestNG 断言/配置失败显示为内部错误码，改为直接展示错误堆栈或
  错误信息；调度、Runner、超时等非正常执行失败仍保留稳定错误码并补充可读错误信息。

### Changed

- Releases publish only `amd64` and `arm64` backend Docker archives. Container images carry their
  own Debian/glibc user space, so Alpine/musl hosts do not require duplicate backend variants.
- Both backend images continue to embed `amd64` and `arm64` Runner Agents. Agent builds now verify
  `CGO_ENABLED=0`, static linking, and the absence of ELF interpreter/shared-library dependencies so
  the same architecture binary runs directly on glibc and musl hosts.

### Compatibility and offline assets

- `release-manifest.json` moves to schema version 3 with a two-architecture backend inventory.
  Published acceptance still validates historical schema 1/2 Releases with their four-image contract.
- Database schemas, persisted platform configuration, Runner Protocol and installed Agent data are
  unchanged.

### Tests

- Component and static UI checks cover feedback presentation, native-dialog removal and failure-code
  classification. Playwright covers the unified feedback dialogs, insight loading response, real JAR
  import/execution/log/insight flow and the 1024px desktop layout boundary.

## 1.8.2 - 2026-09-01

### Changed

- GitHub Release top-level assets now consolidate four image JSON files, seven SPDX documents and
  duplicate legal/reference files into `release-manifest.json` image identities and one versioned
  metadata archive. SBOMs, licenses, NOTICE, attribution, compatibility and change history remain
  intact under the signed checksums and build provenance.
- The Compose deployment archive now uses an explicit deployment-document allowlist instead of
  carrying design images, historical audits, roadmaps and internal implementation material. Lite/Full
  Compose files, operations scripts, user/administrator manuals, recovery, compatibility and legal
  content remain available.

### Compatibility and offline assets

- `release-manifest.json` moves to schema version 2 and embeds `backendImages` in place of top-level
  `*.image.json` files. Published acceptance retains fallback support for historical standalone image
  metadata so upgrades and rollbacks continue across the packaging transition.

### Fixed

- Published Lite asset-lifecycle acceptance now exposes its bound data directory to Playwright fixture
  setup, so analysis-history coverage runs against the released container instead of failing before
  the assertion phase.
- Published acceptance downloads standalone image metadata when an older schema 1 Release provides
  it, while schema 2 Releases continue to resolve the same identity from the consolidated manifest.

## 1.8.1 - 2026-09-01

### Added

- Analysis task cards and details can export the final-failure analysis workbook at any time. The
  workbook keeps unclaimed or unfinished fields blank and fills persisted analyst identity,
  conclusion, root cause, issue/fix evidence, rerun proof and remarks while retaining permanent case
  log links.
- Uploaded rerun screenshots render inline in the analysis detail and open in an authenticated
  50%-300% zoom viewer. The XLSX proof cell links directly to the inline image response.
- Completed failure-analysis conclusions are now permanently linked to their case definition and
  appear in both the full case detail and case-management inspector. The analysis dialog shows
  bounded recent conclusions for every selected case; a single case can inherit the latest prior
  code-issue description, ticket and remark only after explicitly confirming that the ticket remains
  open and the same defect still exists.

### Fixed

- Case execution history now records one representative result per task: the latest successful round
  when any round passed, otherwise the final round. Intermediate retry failures no longer flood the
  case-management execution and TestNG-fact histories.

### Database and persisted configuration

- SQLite migration `0058_failure_analysis_case_history.sql` and PostgreSQL migration
  `0057_failure_analysis_case_history.sql` add the project/case/completion cursor index used by the
  bounded failure-analysis history queries. Existing analysis records require no data migration.

### Tests

- Shared SQLite/PostgreSQL repository coverage verifies per-case analysis history and summarized
  retry results. Playwright verifies historical code-issue inheritance with its secondary
  confirmation, case-detail history, screenshot presentation, workbook export and the 1024px layout
  boundary.

### Compatibility and offline assets

- Lite and Full share the same behavior. Runner Protocol, Jenkins plugins, Adapter contracts and
  offline assets are unchanged.

### Known limitations

- Prior code-issue conclusions can be inherited only while analyzing one case at a time; batch
  analysis still requires an explicit shared conclusion and evidence for the selected cases.

## 1.8.0 - 2026-09-01

### Added

- The new `用例分析` workspace lets users select a terminal ordinary case-suite execution and claim
  only cases that failed in that batch's declared final `currentRound`. Single-case runs, log
  diagnostic reruns, derived final-failure reruns, active batches and failures from earlier rounds
  are excluded. Claims, claimant identity, claim status, selected failure category and analysis start
  time are persisted in Lite and Full, so reloads, sign-outs and browser changes do not lose the work
  queue.
- A project-scoped `analysis.manage` permission gates claim and analysis mutations; read-only viewers
  and auditors can inspect the workspace without changing ownership or categories.
- Failure candidates support bounded server-side search, cursor pagination and sorting by class
  path, case name, failure stack or claim status. A floating action enters the personal analysis
  queue, where `开始分析` requires exactly one of `重跑通过`, `用例问题已修改` or
  `代码问题已提单`.
- The analysis landing page now presents each eligible terminal task as a compact summary card with
  a dedicated detail entry. The detail workspace supports single and batch completion, case and
  failure context, modal/private logs, permanent public logs, common remarks, category-specific
  required evidence, and a second explicit risk confirmation before accepting `用例问题已修改`.
- `重跑通过` automatically persists a permanent public-log proof when a successful rerun launched
  from the case log page exists. Otherwise analysts must paste or select a PNG/JPEG/WebP screenshot;
  evidence is stored through the shared ObjectStore (local filesystem in Lite and MinIO in Full),
  bounded to 10 MiB and protected by media signature, size and SHA-256 validation.
- Platform settings now includes a storage-space inventory for administrators. It summarizes actual
  allocated space and logical content size, then exposes a cursor-paginated list of every regular
  file under the AutoForge data directory, every MinIO object in Full mode, and URL-backed JDK or
  dependency reference.
- SQLite main databases, WAL/SHM sidecars and per-batch log databases are shown individually with
  their logical path, physical path, file size, allocated blocks, update time and file category.
  Uploaded JDK/dependency archives are enriched from authoritative runtime-asset metadata.

### Fixed

- Rerunning one case from its authenticated or public log page now resolves the JDK and dependency
  archive currently configured for the original task's project version. The historical case version,
  task policy, Runner selection and Adapter address rotation remain unchanged, while existing batches
  and whole-batch final-failure reruns retain their immutable runtime snapshots.

### Performance

- The active failure-analysis tab is now server-rendered together with the task header while the
  hidden tab loads only when selected. Sorting or filtering candidates no longer refetches the
  personal queue, superseded requests are aborted and stale responses cannot overwrite the current
  page. Tab changes update the recoverable URL without initiating a second full-page React Server
  Component request.
- Candidate/list payloads cap each failure-summary preview at 8,192 characters while the complete log
  remains available through the modal and public-log actions. Successful rerun proof lookup returns
  only the newest proof attempt per analysis instead of every historical rerun.
- PostgreSQL batch completion now updates up to 100 analyses with one bounded `UNNEST` statement
  instead of one network round trip per row. A task-scoped claimant index keeps the personal queue
  bounded when one analyst has records across large task histories; populated candidate pages also
  avoid a redundant batch-visibility query.
- Batch “rerun passed” completion resolves all successful attempts and active share records in
  bounded bulk queries, then persists the permanent proof links with one `createMany` call instead
  of performing three repository operations for every selected case.

### Tests

- Shared SQLite/PostgreSQL repository coverage verifies final-failure selection, cursor ordering,
  exclusive concurrent claims and persisted category transitions. Playwright verifies claim,
  analysis start, reload recovery, return-to-claim and the 1024px layout boundary.
- Dedicated Lite and real PostgreSQL performance regressions exercise 100,000 final failures across
  landing aggregates, every candidate sort, stack search, 100-row claim/start/evidence/proof/completion
  mutations and a 100,000-row personal queue. Playwright also rejects hidden-tab refetches and
  candidate-filter refetches of the personal queue.
- Storage inventory coverage verifies Lite local files, Full MinIO objects, external runtime assets,
  cursor pagination, runtime-asset metadata lookup and the administrator UI.
- Application coverage distinguishes current-runtime single-case diagnostics from immutable
  final-failure reruns. Lite and Full repository coverage verifies that a newly created diagnostic
  batch persists the newly selected project-version dependency asset. Playwright verifies the full
  public-log action and the dependency input ultimately delivered to the Runner.

### Database and persisted configuration

- SQLite migration `0057_failure_analysis.sql` and PostgreSQL migration
  `0056_failure_analysis.sql` add the durable `failure_analysis_claims` work queue. Existing execution
  records are unchanged; records are created only when a user explicitly claims a final failure.
- Built-in system/project administrators, test managers and execution operators receive
  `analysis.manage`; read-only viewer and auditor roles remain non-mutating.

### Compatibility and offline assets

- Lite and Full share the same behavior. Runner Protocol, Jenkins plugins, Adapter contracts and
  offline assets are unchanged.

### Known limitations

- Claims cannot yet be reassigned to another analyst. Candidate search and table previews inspect the
  first 8,192 characters of a failure summary to keep large pages bounded; complete stdout/stderr and
  stack context remain available through the modal and permanent public-log views.

## 1.7.10 - 2026-08-31

### Added

- The case-suite list can export every ordinary and DDT member to a styled XLSX workbook containing
  only `用例编号（类路径）` and `用例名称`. Ordinary rows use the full Java class name; DDT rows use
  their bound execution class and CaseID.

### Fixed

- Failure-analysis XLSX exports now use compact single-line data rows and narrower columns. Long
  class paths, stacks, and notes remain stored in the cells without expanding each failed case into
  a tall wrapped row.
- Execution-detail status sorting now orders failed cases by their visible failure summary (falling
  back to the result code) before the case name, and applies that order before database pagination in
  both Lite and Full modes.

### Performance

- Case-suite export reads a two-column database projection through 1,000-row cursors and writes XLSX
  rows through the streaming writer, avoiding full case methods and workbook rows in Web memory.

### Tests

- Lite and Full repository contracts verify bounded case-suite export paging and failure-summary
  ordering before pagination. Playwright verifies that an exported workbook contains the expected
  headers and complete Java class paths.

### Database and persisted configuration

- No database migration or persisted-configuration change is required.

### Compatibility and offline assets

- Lite and Full expose the same authenticated export API. Runner Protocol, Jenkins plugins, Adapter
  execution, and offline assets are unchanged.

### Known limitations

- A DDT case without a bound execution class is exported with an empty class-path cell so the row is
  retained and the incomplete configuration remains visible.

## 1.7.6 - 2026-08-31

### Fixed

- Saving or testing LDAP configuration no longer refreshes the page after a successful request, so
  success feedback remains visible. Saved bind-password input is still cleared immediately, and its
  persisted-state hint updates without exposing the secret.

### Tests

- Real isolated OpenLDAP Playwright coverage verifies repeated LDAPS and plain-LDAP configuration,
  connection testing, login without a dedicated username attribute, and Group profile semantics.
- JAR import browser coverage now follows the current operations page heading and validates the
  complete import and navigation flow in Lite, Full, and network-blocked acceptance partitions.

### Database and persisted configuration

- No database migration or persisted-configuration schema change is included. Existing LDAP
  ciphertext and configuration values remain compatible.

### Compatibility and offline assets

- Lite and Full share the same UI behavior. Runner Protocol v1, Jenkins plugins, Adapter execution,
  deployment configuration, and the four-platform offline asset matrix are unchanged.

### Known limitations

- No new known limitation is introduced by this patch release.

## 1.7.5 - 2026-08-31

### Fixed

- LDAP configuration and authentication now match DDT Insight: the submitted login name is the
  platform username, so a directory entry no longer needs a separate `uid`/username mapping
  attribute. Saving an enabled configuration also remains enabled after signing out and back in.
- LDAP authentication uses one connection for service search and user-password bind, then restores
  the service bind only when Group Search requires it. Anonymous search, direct Group attributes,
  Group Search, `ldap://` and `ldaps://` remain supported with bounded searches and timeouts.
- Backend packaging validates every module declared by Next.js `app-paths-manifest.json`, preventing
  optimized images from silently omitting production Route Handlers whose path contains `test` or
  another development-looking segment.
- Published image acceptance validates the signed archive OCI config digest instead of assuming that
  Docker classic and Docker 29 containerd image stores expose identical local image IDs.

### Changed

- LDAP exposes the same configuration fields as DDT Insight. StartTLS selection, private-CA upload,
  username mapping, paging/full-directory synchronization and Group-to-role mapping are no longer
  exposed by the UI, API, application ports or workers.
- Directory Groups are retained only as user profile data. They never create, remove or modify
  platform role bindings. The configured default role is assigned once when an LDAP user first
  signs in; later logins do not overwrite administrator-managed permissions.
- The manual and scheduled LDAP synchronization routes and operations view have been removed. Old
  synchronization queue kinds and database tables are retained only so upgrades can diagnose and
  dead-letter persisted work safely.
- Published acceptance now runs the real Agent flow against the `amd64-musl` image in addition to the
  standard amd64 partitions, verifies that backend SBOMs contain Next.js and `better-sqlite3`, and
  checks image metadata architecture, operating system, version and reference.
- Offline Compose documentation now uses Docker-native `.docker.tar` archives directly, explains
  Docker image identity differences, and documents the shared reachability requirement for Full-mode
  MinIO presigned uploads.

### Tests

- Real isolated OpenLDAP Playwright coverage verifies saved configuration persistence, LDAPS and
  plain LDAP login, a user with no username attribute, Group profile display, one-time default-role
  assignment, and the absence of synchronization and Group-mapping endpoints.
- SQLite and PostgreSQL migration/integration coverage verifies the new LDAP configuration metadata,
  Group profile persistence and the removal of Group-derived permissions. Release-script tests cover
  complete Next.js route packaging, signed archive identity and musl Agent acceptance.

### Database and persisted configuration

- SQLite migration `0056_ldap_ddt_insight_configuration.sql` and PostgreSQL migration
  `0055_ldap_ddt_insight_configuration.sql` add `ldap_configurations.updated_by` and
  `users.ldap_groups_json`.
- During upgrade, role bindings whose source is the retired LDAP Group mapping are removed, then each
  existing LDAP user receives the LDAP configuration's single default role. Explicit platform-managed
  role bindings are preserved.
- Historical StartTLS configurations are disabled instead of being silently downgraded to plaintext;
  an administrator must review and save an explicit `ldap://` or `ldaps://` URL.

### Compatibility and offline assets

- Lite and Full use the same LDAP contract and migration behavior. Runner Protocol v1, Jenkins plugin
  parameters and execution behavior are unchanged.
- Release assets remain four Docker-native backend archives (`amd64`, `arm64`, `amd64-musl`,
  `arm64-musl`) with embedded static Agents, SPDX SBOMs, a deployment bundle, signed checksums and
  provenance. No runtime network dependency was added.

## 1.7.2 - 2026-08-31

### Fixed

- Backend runtime packaging no longer treats production Next.js route directories named `test` as
  development test output. This restores the LDAP connection test and Webhook configuration test
  APIs in the optimized offline image.
- The Groovy case-group utility now adds the required `cotest.define.TestCaseGroup` import when a
  source uses the generated group values without an exact or wildcard import. Import-only repair,
  preview, confirmation, staging and idempotent reruns are supported.
- The same utility now processes every row from both workbook sheets: `导出用例` requires an
  explicit reviewed L0/L1/L2 value, while every `排除明细` case is deterministically assigned L2
  without requiring a level column.

### Tests

- Runtime packaging and image verification now require both production test-action route files, and
  the optimized image passes the complete governance partition plus real private-CA LDAPS/plain-LDAP
  acceptance.
- Groovy coverage verifies exact, wildcard and missing imports, including import-only dry runs and
  confirmed repair.

### Database and persisted configuration

- No migration or persisted-configuration change is required.

### Compatibility and offline assets

- Lite/Full behavior, Runner Protocol v1 and the Docker-native `.docker.tar` distribution format are
  unchanged. No dependency or runtime network requirement was added.

## 1.7.1 - 2026-08-31

### Added

- `groovy-test` now includes an offline `ApplyGroovyCaseGroups` CLI that reads reviewed XLSX levels
  and updates class- or method-level Groovy `@Test` `group`/`groups` members through the
  conversion-phase AST without
  loading or executing test classes. It recognizes the supported reviewed-level header and value
  variants, previews every planned change, requires explicit confirmation, supports dry runs and
  validates the complete workbook before writing.
- Changed Groovy sources are replaced atomically and staged after each changed case. Existing
  non-level groups are preserved, already-correct sources remain untouched, and unsafe paths,
  malformed sources, ambiguous levels or missing annotations stop the operation before mutation.

### Changed

- Backend images now bundle the custom Next.js server entry points and copy only the traced
  production runtime, migrations, static assets and embedded Agents. Next.js build caches, source
  maps, local data, test output and development dependencies no longer enter release images.
- Docker build context now excludes Maven targets, and backend archive generation enforces a 180 MiB
  regression budget. The measured Linux amd64 Docker archive decreased from about 522 MB in v1.7.0
  to 126 MB while retaining Lite/Full in one image and both static Agent architectures.

### Tests

- Release checks cover runtime exclusions, safe packaging destinations, the archive-size budget and
  the single traced-runtime Docker copy. Image acceptance still boots Lite without network, executes
  migrations, verifies the Full-mode NATS client exports and checks both embedded Agent resources;
  Full runtime acceptance covers real Agent execution, LDAP and dependency interruption recovery.
- Added focused Groovy regression coverage for reviewed workbook parsing, confirmation and
  cancellation, per-case staging, atomic rollback, idempotency, source safety, level aliases and
  plural `groups` preservation. The focused suite now runs in normal CI and release-source checks.

### Database and persisted configuration

- No migration or persisted-configuration change is required.

### Compatibility

- Lite/Full behavior, custom-server terminal WebSockets, Runner Protocol v1 and the Docker-native
  `.docker.tar` distribution format are unchanged.
- The Groovy workbook utility is an optional Java 8-compatible maintenance tool and does not alter
  the AutoForge control-plane runtime or execution protocol.

### Offline assets

- No dependency or runtime network requirement was added. Runtime images continue to contain both
  Linux amd64 and arm64 static Agents.

## 1.7.0 - 2026-08-31

### Changed

- Runner claims now carry their authenticated, live free-slot count through the Web worker boundary,
  scheduler and SQLite/PostgreSQL reservation transaction. This corrects heartbeat capacity that can
  remain stale for one heartbeat interval while retaining active database reservations as the hard
  lower bound, so the optimization cannot oversell a Runner.
- Finishing a local attempt now wakes the Agent claim loop immediately instead of waiting for an
  outstanding empty-claim delay. A claim also captures its eligibility time after refill scheduling,
  preventing a newly created assignment from appearing a few milliseconds in the future.
- Schedulable-batch scans now skip active batches that have only in-flight work and no eligible queued
  run, so a high-priority busy batch cannot consume the bounded scan window and hide work that can
  refill a Runner.
- The existing 500 ms Agent log-upload goroutine remains active while TestNG reports and artifacts are
  collected. This drains the log tail in parallel with local I/O while preserving the authoritative
  final flush, continuous watermarks and restart-safe spool semantics.

### Tests

- Added scheduler, application, work-dispatch and Agent tests for stale-heartbeat correction,
  reservation authority, post-scheduling claim time and immediate wake from a 30-second server retry.
- Added shared SQLite/PostgreSQL repository coverage for bounded batch scans and real PostgreSQL
  platform contracts.
- Extended Playwright recovery and refill coverage to reproduce a saturated heartbeat without sending
  another heartbeat; the complete 29-test Lite E2E suite passes.

### Database and persisted configuration

- No migration or persisted-configuration change is required. Existing execution-run and assignment
  indexes support the new bounded eligibility probes.

### Compatibility

- Runner Protocol v1 is unchanged. Existing Agents remain compatible, but upgrading to the embedded
  v1.7.0 Agent is required for completion-triggered claim wake-up; older Agents retain their bounded
  polling behavior.
- Lite and Full use the same live-capacity and reservation rules. Web and Full workers should be
  upgraded together so the optional live-capacity hint is retained across the work-thread boundary.

### Offline assets

- No dependency, remote asset or runtime network requirement was added. Release images remain
  Docker-native `.docker.tar` archives and include both static Agent architectures.

### Known limitations

- Configured concurrency remains a safe upper bound rather than a guaranteed occupancy target. CPU,
  memory and load thresholds, stale resource metrics, recovery barriers and an exhausted runnable
  queue can still keep observed utilization below 80%; this release removes the known heartbeat and
  claim-backoff gaps without bypassing those protections.

## 1.6.8 - 2026-08-30

### Added

- Execution-result export now offers a dedicated failure-analysis workbook for the selected current,
  all-round or final scope. The server limits this template to normally failed and abnormally ended
  cases and uses the case class path as the case number.
- The workbook contains only the ten requested analysis columns, permanent public log hyperlinks and
  a validated three-choice result dropdown (`rerun passed`, `case fixed`, or `code issue filed`).
  Populated columns are wide and wrapped, while the editable analysis columns retain practical widths
  and a subtle input background.

### Tests

- Added workbook-level coverage for exact column order, class-path case numbers, column widths,
  editable blanks, hyperlinks and dropdown validation, plus Playwright coverage for choosing and
  downloading the analysis template at a 1024px desktop viewport.

### Database and persisted configuration

- No migration or persisted-configuration change is required.

### Compatibility

- Existing export URLs without a `template` query parameter continue to produce the standard result
  workbook. The new template reuses existing batch snapshots and permanent attempt-log shares.
- No Runner Protocol change is required.

### Offline assets

- No dependency, remote asset or runtime network requirement was added.

### Known limitations

- The failure-stack column uses the structured failure summary stored with the attempt. The permanent
  log link remains the source for the complete stdout/stderr stream and any additional stack frames.

## 1.6.7 - 2026-08-30

### Fixed

- Single-case diagnostic runs submitted from authenticated or permanent public log pages now retain
  the original case family's latest Runner and actual assigned Adapter environment. Each new hidden
  diagnostic batch advances to the next healthy Runner and the next configured environment address
  instead of restarting from the first environment because it owns a new execution-run ID.

### Tests

- Added shared SQLite/PostgreSQL repository contract coverage for cross-batch Runner history and the
  actual Adapter address persisted in assignment execution specs, plus application coverage for the
  next environment selected by a public-log diagnostic rerun.

### Database and persisted configuration

- No migration or persisted-configuration change is required. Rotation is derived from existing
  parent/source links and assignment execution-spec snapshots through bounded latest-row queries.

### Compatibility

- Existing diagnostic batches and public log links remain valid. Reading the actual persisted
  assignment address also preserves correct rotation for batches produced before v1.6.6.
- No Runner Protocol change is required.

### Offline assets

- No dependency, remote asset or runtime network requirement was added.

### Known limitations

- If only one healthy compatible Runner or one Adapter address is available, that resource is reused.

## 1.6.6 - 2026-08-30

### Changed

- A case's retry attempts now rotate through the batch's healthy Runner snapshot in stable Runner-ID
  order instead of repeatedly selecting the same highest-scoring node. Online state, compatibility,
  fresh metrics, resource thresholds, capacity and infrastructure-failure exclusions remain hard
  constraints; single-Runner deployments safely fall back to the available node.
- CoTest Adapter assignments now retain the complete configured environment pool and rotate the
  environment address on every attempt. Initial attempts remain spread by stable case order, while
  retries advance to the next address and wrap only after the pool is exhausted.
- Final-failure and individual diagnostic rerun batches preserve the original complete Adapter
  environment pool rather than reducing it to the addresses used by the selected source runs.

### Tests

- Added deterministic scheduler coverage for Runner rotation, wraparound, unavailable-node skipping
  and infrastructure exclusions.
- Added runtime compatibility and SQLite integration coverage proving legacy Adapter snapshots remain
  readable and consecutive persisted execution specs receive different environment addresses.

### Database and persisted configuration

- No SQL migration is required. New batch Adapter JSON snapshots include the complete
  `environmentAddresses` pool alongside the existing per-run initial address map.

### Compatibility

- Existing batches remain readable. For legacy active batches, retries can rotate across the distinct
  addresses already represented by their stored per-run map; addresses that were configured but never
  selected by any first attempt were not persisted by older versions and cannot be reconstructed.
- No Runner Protocol schema change is required: each assignment still carries one resolved Adapter
  environment address. Older Agents can execute assignments produced by v1.6.6.

### Offline assets

- No dependency, remote asset or runtime network requirement was added.

### Known limitations

- Runner retry order is based on stable Runner IDs because the persisted batch membership snapshot has
  no user-defined node ordinal. Unhealthy or capacity-exhausted nodes are skipped, so an individual run
  can temporarily deviate from the ideal cycle while preserving execution safety.

## 1.6.5 - 2026-08-30

### Changed

- Execution-detail round selection now updates the shareable URL without re-running the full Server
  Component page. Switching between the case and runner tabs preserves the already-loaded case page,
  filters and pagination state instead of unmounting and fetching it again. Scheduled-run countdowns
  now update only their metric card instead of re-rendering the entire charts and case table every
  second, and unchanged polling responses retain the existing React tree.
- Settings navigation now streams a route-level loading state and access-management tabs query only
  the users, roles, projects, LDAP or sessions required by the active tab. Non-user tabs no longer run
  the per-project membership query.
- Permanent anonymous run-detail shares now expose a bounded “查看公开日志” link for every attempt.
  The run token is revalidated against the anchor batch and only permits navigation within the same
  execution-run family.
- Public attempt-log rendering now reads at most 512 KiB through small pages before returning the
  server-rendered view; it no longer loads an entire large batch or complete oversized log first.
  Pathological repeated log-level tokens are capped at 10,000 rendered spans while preserving text.

### Tests

- Added application coverage for batch-scoped public logs, cross-batch rejection and bounded UTF-8
  log payloads, plus Playwright coverage for anonymous navigation from a shared run to a case log and
  preservation of case filters across execution-detail tab switches.

### Database and persisted configuration

- No migration or persisted-configuration change is required.

### Compatibility

- Existing permanent run-detail and attempt-log share URLs remain valid. The new nested public-log
  route reuses the existing run-share token and adds no Runner Protocol or authenticated API change.
- Public log pages intentionally return at most the first 512 KiB of an attempt log; authenticated
  execution details and persisted log chunks are unchanged.

### Offline assets

- No dependency, remote asset or runtime network requirement was added.

### Known limitations

- The case-management directory still preserves its complete-directory semantics. Very large case
  catalogs remain a separate optimization target; this release focuses on execution details,
  settings navigation and anonymous shared results.

## 1.6.3 - 2026-08-30

### Fixed

- `/landing` now returns an immediate HTTP redirect after session and permission resolution instead
  of waiting for the authenticated React layout to load project and version context. Login and setup
  hand-offs no longer remain indefinitely on the global loading skeleton when that context is large
  or slow.
- The landing redirect now uses a relative destination, preserving the browser's actual host and
  session cookie instead of leaking the custom server's internal `localhost` origin into the
  response.
- LDAP synchronization now defaults to one unified platform role and omits Group attributes and
  per-user Group searches entirely. Large directories no longer perform an N+1 organization lookup
  when differentiated Group authorization is not explicitly enabled and backed by a mapping.

### Changed

- The LDAP form now labels the default role as the unified role for every directory user. Advanced
  Group-based authorization is behind an explicit switch, and its Group identifier/mapping controls
  are hidden while disabled.
- Login and synchronization ensure the configured LDAP default role for every managed directory
  user, not only on the first provisioning attempt.

### Tests

- Added Playwright coverage that requires the authenticated `/landing` endpoint to return a direct
  `307` response and complete navigation to the permission-appropriate page.
- Added directory-client coverage proving unified-role synchronization performs one paged user
  search even when returned entries contain thousands of organization memberships, plus UI coverage
  for the default-disabled Group controls.

### Database and persisted configuration

- No migration or persisted-configuration change is required.

### Compatibility

- The `/landing` URL and destination priority remain unchanged; only its response is moved from a
  rendered page redirect to a layout-independent Route Handler.
- Existing LDAP Group settings and mappings remain available. Installations that already saved a
  Group attribute or Search Base keep the advanced switch enabled until an administrator turns it
  off and saves; dormant mapping rows are retained but no longer queried or applied.

### Offline assets

- No dependency, remote asset or runtime network requirement was added.

### Known limitations

- Explicitly enabling differentiated LDAP Group authorization can still require one Group search per
  directory user. Keep the advanced switch disabled for large directories unless those mappings are
  required and the LDAP server is sized for that query pattern.

## 1.6.2 - 2026-08-29

### Changed

- LDAP directory configuration and authentication now follow the proven ddt-insight model: one
  URL determines plain LDAP or implicit LDAPS, Bind DN is optional for directories that permit
  anonymous search, and user filters use the explicit `{{username}}` placeholder.
- Directory attributes are resolved case-insensitively, including option-suffixed and multi-value
  attributes. Group authorization can use the user's direct `memberOf`-style attribute or a Group
  search that returns a human-readable group name such as `cn`.
- First-time LDAP users receive the configured human-readable default role. Local accounts still
  take precedence, and a disabled LDAP account is rejected before any directory connection.

### Fixed

- LDAP login no longer depends on `entryUUID` or another deployment-specific stable-ID attribute.
  Existing AutoForge LDAP identities are relinked by their normalized LDAP username on the next
  successful login instead of being duplicated or rejected.
- Plain LDAP Bind resets now report that the directory may require an `ldaps://` address instead of
  collapsing into a generic connection error.

### Tests

- Added contract, directory-client, diagnostics, SQLite identity, SQLite upgrade and real LDAP
  Playwright coverage for anonymous/service Bind, URL-derived transport, direct and searched groups,
  default-role provisioning, disabled-user short-circuiting and case-insensitive attributes.

### Database and persisted configuration

- SQLite migration `0055_ldap_directory_authentication.sql` and PostgreSQL migration
  `0054_ldap_directory_authentication.sql` add the direct Group attribute, Group display-name
  attribute, default LDAP role and authoritative transport mode.

### Compatibility

- Existing v1 LDAP API payloads remain accepted and are normalized to the new field names. Existing
  StartTLS rows retain their encrypted StartTLS transport after upgrade; new `ldap://` settings use
  plain LDAP and new `ldaps://` settings use implicit TLS, matching ddt-insight. Existing Group
  Search rows retain DN results so already-saved role mappings continue to match; new configurations
  default to the human-readable `cn` attribute.

### Offline assets

- No dependency, remote asset or runtime network requirement was added.

### Known limitations

- The new directory form intentionally does not create new StartTLS configurations. Historical
  StartTLS settings remain supported and visible until their LDAP URL is changed.
- ddt-insight uses one authoritative directory URL. Legacy API payloads containing several LDAP
  servers remain parseable, but only their first URL is retained; configure upstream LDAP
  high-availability behind that address when failover is required.

## 1.6.1 - 2026-08-29

### Added

- The task creation dialog now supports choosing an existing task in the current project version and
  copying it directly into an independently editable task.
- Copy mode explains exactly which state is duplicated and opens the new task details immediately so
  its name, members and execution policy can be changed without affecting the source.

### Tests

- Extended the case-suite Playwright lifecycle to copy from the creation dialog, edit the copied
  policy and description, remove copied members, and verify that the source task remains unchanged.

### Database and persisted configuration

- No migration is required. Lite and Full continue to create independent task, member, recovery
  credential and version-snapshot rows in their existing transactional copy implementations.

### Compatibility

- The existing task-copy API and task-detail copy button remain compatible. Execution history,
  schedules and webhook bindings are intentionally not copied to avoid duplicating external effects.

### Offline assets

- No dependency, remote asset or runtime network requirement was added.

### Known limitations

- Creation-dialog copy candidates are limited to tasks in the currently selected project version;
  switch the top-bar version before copying a task from another version.

## 1.6.0 - 2026-08-29

### Added

- DDT cases can now be bulk-bound to an authoritative ordinary TestNG class in the same project
  version and test stage, and can be added to mixed ordinary/DDT case suites.
- Case-suite trees now group ordinary cases by package and DDT cases by SR, while execution-detail
  rows identify the case type and show the DDT SR.
- DDT execution now freezes one JSON `classDataFile` per CaseID and execution run. The authenticated
  Runner input path verifies its size and SHA-256 before the existing CoTest Adapter receives
  `--class-data`; derived diagnostic and final-failure reruns retain the same immutable snapshot.
- DDT cases that still belong to a case suite are protected from recycle deletion with an explicit
  `DDT_CASE_IN_USE` error, so membership changes always pass through the versioned suite operation.

### Fixed

- The repository homepage architecture diagram now uses Mermaid-safe edge-label syntax, so GitHub no
  longer replaces the README diagram with an `Unable to render rich display` parse error.

### Tests

- Added application and Runner contract coverage for DDT class binding, preflight failures and
  Adapter argument construction, plus a Lite database execution-snapshot integration test.
- Added Lite and Full upgrade-migration backfill checks and matching repository tests for
  execution-class persistence, recycle restoration and task-membership deletion protection.
- Extended the DDT Playwright workflow through ordinary TestNG import, bulk execution-class binding,
  mixed-suite membership and SR task-tree rendering.
- Extended the real Java/Runner Playwright acceptance chain through DDT import, authoritative class
  binding, immutable `classDataFile` download, CoTest Adapter injection and a passing TestNG result.

### Database and persisted configuration

- SQLite migration `0054_ddt_execution.sql` and PostgreSQL migration `0053_ddt_execution.sql` add
  DDT execution-class mappings, DDT suite membership, execution type/SR fields and immutable
  class-data snapshot metadata. Existing execution runs are backfilled as ordinary TestNG runs.

### Compatibility

- Ordinary TestNG execution and existing Adapter arguments are unchanged. DDT execution adds the
  optional Runner Protocol v1 `class-data` input kind and therefore requires a Runner containing this
  change; older Runners reject DDT assignments explicitly instead of executing them without data.
- Existing DDT assets remain valid but must be assigned an execution class before a task containing
  them can pass execution preflight.

### Offline assets

- No dependency, remote asset or runtime network requirement was added. Lite serves immutable DDT
  JSON through the existing authenticated control plane, and Full uses the same Runner protocol.

### Known limitations

- A DDT task requires the CoTest Adapter and a compatible Runner; the standard TestNG executor does
  not interpret `classDataFile` by itself.

## 1.5.9 - 2026-08-28

### Added

- DDT import dialogs now accept one or more spreadsheet/ZIP files by drag and drop, with an explicit
  drop-target state and client-side rejection of unsupported file extensions before upload.

### Fixed

- LDAP users no longer receive a generic invalid-credential response merely because the login page
  defaulted to the local provider. The server now selects authentication from the persisted account
  source and enabled directory configuration, including first-login LDAP provisioning.

### Changed

- The login page is now a single username/password form without local/LDAP provider buttons. Existing
  local users always use local authentication, existing LDAP users use directory authentication, and
  unknown users try LDAP only when it is enabled. Login identifiers now accept LDAP-friendly values
  such as UPNs while local-account creation retains its stricter naming rules.

### Tests

- The DDT Playwright workflow now imports its workbook through the browser drag-and-drop path and
  verifies the active drop-target feedback.
- Real isolated-network LDAP acceptance now verifies automatic LDAPS and StartTLS login, first-login
  provisioning, same-name local-account precedence, directory outage handling and local-admin access
  without a browser-selected provider.

### Database and persisted configuration

- No SQLite/PostgreSQL migration or persisted-configuration change is required.

### Compatibility

- DDT import APIs and the existing file-picker upload flow are unchanged. The login API continues to
  accept the legacy optional `provider` field, but the server intentionally ignores it when selecting
  the authoritative authentication source.

### Offline assets

- No dependency, remote asset or runtime network requirement was added.

### Known limitations

- Browser security still prevents selecting folders through the drop target; users should drag the
  supported files themselves or package them in a ZIP archive.

## 1.5.8 - 2026-08-28

### Fixed

- Task-detail package groups now mount case rows only after explicit expansion and render at most 100
  additional cases per step. Expanding or collapsing a package no longer forces layout across as many
  as 62,500 eagerly mounted interactive rows, and changing only the arrow state no longer rescans every
  member of a large package to recompute selection totals.

### Tests

- Extended the task-lifecycle Playwright flow to verify that package contents are absent initially,
  appear on expansion and are removed again on collapse.

### Database and persisted configuration

- No SQLite/PostgreSQL migration or persisted-configuration change is required.

### Compatibility

- Case-suite APIs, task snapshots, Runner Protocol v1 and Jenkins Pipeline inputs are unchanged.

### Offline assets

- No dependency, remote asset or runtime network requirement was added.

### Known limitations

- An expanded package initially shows 100 cases; additional members remain available through the
  existing incremental “加载更多用例” control.

## 1.5.7 - 2026-08-28

### Added

- LDAP configuration now exposes a `校验 TLS 服务器证书` switch for LDAPS and StartTLS. It remains
  enabled by default; administrators can explicitly disable certificate-chain and hostname
  verification for isolated legacy directories while TLS 1.2 encryption remains required. The UI
  keeps a visible man-in-the-middle warning whenever verification is disabled.

### Changed

- Repository-level roadmap, historical review, compatibility, legal notice and release-signing
  resources now live under purpose-specific `docs/` and `scripts/` directories instead of remaining
  as unrelated root files. Release bundles retain the established top-level compatibility and public
  key filenames, so offline verification commands and asset consumers do not need to change.
- Runtime platform configuration is documented through the persisted administration page/config file;
  the obsolete repository-root `.env.example` was removed while Lite and Full Compose templates remain
  available beside their respective deployment definitions.

### Tests

- Added contract defaults, LDAPS/StartTLS connection-plan coverage, UI switch coverage, SQLite
  persistence coverage and Lite/Full migration backfill tests.

### Database and persisted configuration

- SQLite migration `0053_ldap_tls_certificate_verification.sql` and PostgreSQL migration
  `0052_ldap_tls_certificate_verification.sql` add `verify_tls_certificate`; existing LDAP
  configurations are backfilled to `true`.

### Compatibility

- Existing API clients that omit `verifyTlsCertificate` retain strict certificate verification.
  Runner Protocol v1 and Jenkins Pipeline contracts are unchanged.

### Offline assets

- Deployment bundles and GitHub Release assets still include `COMPATIBILITY.md` and
  `release-signing-public-key.pem` at their existing package-root paths. No dependency, remote asset or
  runtime network requirement was added.

### Security

- Disabling verification does not permit plaintext LDAP and does not lower the TLS 1.2 minimum, but
  it removes directory-server identity verification and therefore permits man-in-the-middle attacks.

### Known limitations

- Certificate verification can only be disabled for an entire LDAP directory configuration, not for
  individual URLs. Administrators should keep it enabled unless every configured endpoint is confined
  to a trusted isolated network.

## 1.5.6 - 2026-08-27

### Fixed

- The execution-history permanent-share copy action now works on plain-HTTP intranet deployments
  where the secure-context Clipboard API is unavailable or denied. It falls back to a user-gesture
  selection copy and reports an actionable message instead of silently ignoring a failed copy.
- Permanent case-share links use the same copy behavior and expose accessible success/failure status
  without changing the generated anonymous URL or its lifetime.

### Tests

- Added unit coverage for Clipboard API success, unavailable API, permission rejection and total
  failure cleanup. Extended the all-rounds Playwright flow to remove `navigator.clipboard`, click the
  execution-history copy control and verify the exact permanent URL copied by the HTTP fallback.

### Database and persisted configuration

- No SQLite/PostgreSQL migration or persisted-configuration change is required.

### Compatibility

- Runner Protocol v1, Jenkins Pipeline inputs, task snapshots, permanent-share token format and
  release archive formats are unchanged.

### Offline assets

- No dependency, remote asset or runtime network requirement was added; the fallback uses browser
  APIs already available in the bundled UI.

### Known limitations

- Browsers or embedded WebViews that disable both the Clipboard API and user-gesture selection copy
  cannot be bypassed. The UI now keeps the anonymous link available and tells the user to open it and
  copy from the address bar.

## 1.5.5 - 2026-08-27

### Changed

- Full mode now keeps its scheduling lane warm, uses JetStream blocking claims, batches Runner and
  attempt context reads, reserves assignments with one conditional PostgreSQL statement, and handles
  Runner claim/log/completion traffic through the custom server's bounded protocol fast path. The
  same application authorization, rate limiting, validation and error contracts remain authoritative.
- PostgreSQL attempt completion now persists the terminal transition, retry decision, scheduling
  events and completion receipt in one transaction. A post-completion schedulable-run probe prevents
  the last concurrent completion from leaving a batch in a non-terminal state while still refilling
  genuinely free Runner slots immediately.
- Scheduling events are emitted only for assignments that won the conditional reservation. Event
  rows no longer hold foreign-key locks on execution hot-path tables, and assignment lease lookup has
  a dedicated index.
- Full PostgreSQL pool sizing is configurable through `full.databasePoolMax` (default 10, range
  1–100). Web scheduling lanes share one bounded pool budget instead of opening an independent
  hard-coded pool for every lane; the administrator guide documents replica capacity planning and
  the required restart.
- Identity sessions, Runner credentials and Redis rate-limit allowances continue to use their
  authoritative shared stores on every request. No replica-local authorization or allowance cache
  was retained, so password resets, role changes, Runner revocation and global rate limits remain
  immediately effective across replicas.
- The standalone Groovy analyzer can resume interactive L0/L1 review from an existing workbook,
  saves each choice immediately, supports returning to the previous row and safe interruption, and
  now builds and runs on Java 8 or newer. Reviewers can also mark a row as L2 to move it into the
  exclusion worksheet while preserving the case metadata, exclusion evidence and continuous row
  numbering.

### Tests

- Added PostgreSQL concurrent-completion regression coverage and scheduling-event checks for
  overlapping reservations, accepted-attempt filtering and deletion-safe diagnostic history.
- Extended migration tests to upgrade existing databases without losing the
  `retry_concurrency_changed` event type, and added Runner fast-path, worker sizing, JetStream claim,
  log-store and 100,000-run performance coverage.
- Passed the complete Full acceptance with real PostgreSQL, NATS JetStream, MinIO, Redis, two Web
  replicas, two workers, a real Go Agent, TestNG execution, LDAPS/StartTLS and dependency fault
  recovery; also passed Lite 500-slot concurrency and the 28-scenario Playwright suite.

### Database and persisted configuration

- PostgreSQL migrations `0050_scheduling_events_drop_foreign_keys.sql` and
  `0051_assignment_leases_assignment_idx.sql`, plus SQLite migrations
  `0051_scheduling_events_drop_foreign_keys.sql` and `0052_assignment_leases_assignment_idx.sql`,
  remove scheduling-event foreign keys and add the assignment lease index. Existing event rows and
  all current event types are preserved.
- Existing Full configurations remain valid and receive `full.databasePoolMax: 10` by default. A
  changed pool budget takes effect after restarting the affected Web/worker processes.

### Compatibility

- Runner Protocol v1, Jenkins Pipeline inputs, task snapshots, permanent-share tokens and release
  archive formats are unchanged. Completion responses add only the optional
  `hasSchedulableRuns` optimization hint; old Agents ignore it and the server conservatively schedules
  when the hint is absent.

### Offline assets

- No production dependency, remote static asset or runtime internet requirement was added. The
  optimized Lite and Full paths use the existing bundled workspace packages and infrastructure
  clients.

### Known limitations

- On the recorded 4-vCPU single-host comparison, Full was slightly faster for 500 Runner claims but
  not for every import, scheduling, completion or read phase. Full's principal advantage remains
  horizontal Web/worker scaling and infrastructure fault isolation; the benchmark is a regression
  reference, not a promise that Full is always faster than Lite on one machine.

## 1.5.2 - 2026-08-27

### Changed

- Permanent attempt-log actions now use explicit brand/dark-page colors: “查看实时日志”, “执行此用例”
  and the anonymous “登录后执行此用例” link no longer inherit a white secondary surface on the dark
  share page.
- Role, service-account, project-scope and API-token permission editors now use accessible checkbox
  groups with human-readable names and descriptions instead of native Ctrl/Command multi-selects.
- The Runner terminal title-bar expand control is now interactive, supports full-viewport and restored
  modes, refits xterm after resizing, and lets Escape restore an expanded window before closing it.
  A temporarily unavailable Agent terminal channel can now be retried inside the same dialog, and the
  expanded terminal remains above the sticky application shell so its title-bar controls stay clickable.
- Runner inventory rows are substantially denser. Host JDK/TestNG compatibility and raw capability
  strings are no longer repeated in each row; platform, Agent/protocol, slots/resources, heartbeat and
  lifecycle actions remain visible. Agents that accept project runtime assets are no longer blocked by
  an unrelated host JDK/TestNG version because the assignment supplies the authoritative runtime. The
  compact row's management menu also remains above surrounding summary cards so every action is clickable.
- Active run details poll a bounded overview endpoint and update metrics, rounds and the current case
  page locally. They no longer refresh the entire Server Component tree every five seconds, preserve
  filters/expanded rows/scroll position, and keep current rows visible while fresh data is fetched.
- System diagnostics now show each dead-letter job's type, related ID, final error and delivery count.
  Administrators can explicitly redrive up to 100 visible dead letters; SQLite resets them atomically
  and JetStream republishes before removing the original DLQ message.

### Tests

- Extended Playwright coverage for checkbox-based RBAC/service-account flows, anonymous and signed-in
  permanent-log action colors, terminal expand/restore behavior and bounded active-batch overview
  polling without page navigation, plus pointer hit-testing for the compact Runner management menu.
- Extended the shared SQLite/JetStream queue contract to inspect a dead letter, redrive it and verify
  that its new delivery starts at attempt one; added project-runtime compatibility regression coverage.

### Database and persisted configuration

- No SQLite/PostgreSQL migration or persisted-configuration change is required. Existing SQLite
  `queue_jobs` rows and JetStream DLQ messages remain readable and can be redriven in place.

### Compatibility

- Runner Protocol v1, Jenkins inputs, task snapshots and release archives are unchanged. The system
  diagnostics response adds the backward-compatible `deadLetters` array. Host toolchain versions remain
  enforced for legacy Agents that do not accept project runtime assets.

### Offline assets

- No production dependency, remote static asset or runtime internet requirement was added. Lite and
  Full implement the same administrative dead-letter operations with their existing queue backends.

### Known limitations

- Diagnostics display the newest 20 dead letters and one redrive action processes at most 100. A job
  whose underlying business error is not fixed can return to the DLQ after the normal retry budget.

## 1.5.1 - 2026-08-27

### Changed

- Case names in the case-management directory now navigate directly to the dedicated case detail
  page. The existing in-page inspector remains available through an explicitly labelled quick-preview
  button and links onward to the full detail and history view.
- Case details now expose the complete execution history through stable cursor pagination instead of
  a fixed recent window. Each execution expands every attempt, identifies its Runner when authorized and
  result, and lets authorized users open that attempt's full or live log without leaving the page.

### Tests

- Added shared SQLite/PostgreSQL repository coverage for stable execution-history pagination, all
  attempts in a run, Runner display names, invalid cursors and exclusion of diagnostic log reruns.
- Extended the Lite Playwright JAR workflow to navigate from the case directory into the detail page
  and open both original and retry attempt logs from the new history table.

### Database and persisted configuration

- SQLite migration `0050_case_execution_history_index.sql` and PostgreSQL migration
  `0049_case_execution_history_index.sql` add an additive `(case_definition_id, created_at, id)` index
  for bounded history traversal. No data rewrite or persisted-configuration change is required.

### Compatibility

- Runner Protocol v1, Jenkins Pipeline inputs, task snapshots, permanent-share tokens and release
  archive formats are unchanged. Diagnostic `case_log_rerun` batches remain visible only in log-side
  history and do not enter ordinary case execution history.

### Offline assets

- No production dependency, remote asset or runtime network requirement was added. Lite and Full use
  the same application pagination contract with native SQLite/PostgreSQL adapters.

### Known limitations

- The execution-history total is intentionally not counted up front; the page reports how many rows
  are loaded and whether all history has been reached, avoiding a separate full-history count query.

## 1.5.0 - 2026-08-27

### Changed

- The authenticated dashboard and quality insights now aggregate confirmed execution facts inside
  SQLite/PostgreSQL. Counts and trends remain exact beyond 100,000 samples instead of stopping at a
  hard-coded row limit, and the Web process no longer materializes up to 200,000 fact rows for one
  dashboard request.
- Run-batch details now load bounded database aggregates for rounds, final outcomes, Runner activity,
  infrastructure incidents and recovery timing. Case rows are searched, filtered, sorted and paged
  on the server (20–500 rows per page), so a 100,000-case batch is never serialized into the initial
  page or repeatedly resent by active-batch refreshes.
- Permanent anonymous result pages, temporary progress pages, sharing and scheduling-log permission
  checks use bounded summaries rather than loading every run and attempt. Identical default insight
  and flaky-case filters reuse one aggregate result.
- Analytics exports issue their configured bounded SQL limit directly rather than reading a larger
  fixed window and slicing it in memory.

### Tests

- Added an exact 100,005-sample dashboard regression and shared SQLite/PostgreSQL repository contract
  coverage for bounded batch overviews, case pagination and pending-state filters.
- Extended the 100,000-run performance gate to verify that the detail overview returns no run/attempt
  arrays, the first page contains only 50 rows and both operations complete within the bounded budget.
- Re-ran the Playwright all-rounds workflow across live scheduling, status filters, Runner fault
  aggregation, permanent anonymous result sharing and desktop layout.

### Database and persisted configuration

- SQLite migration `0049_large_batch_detail_indexes.sql` and PostgreSQL migration
  `0048_large_batch_detail_indexes.sql` add batch/creation and batch/display-name indexes for stable
  detail pagination. They are additive and require no data rewrite or configuration change.
- Existing analytics facts remain schema v4 and are reused without migration or rebuild.

### Compatibility

- Runner Protocol v1, Jenkins Pipeline parameters, task snapshots, permanent-share tokens and release
  archive formats are unchanged. The existing unbounded batch-result export remains an explicitly
  requested background operation; interactive detail pages are now bounded.

### Offline assets

- No production dependency or runtime network request was added. Lite and Full use the same
  application contract and their native database aggregation implementation.

### Known limitations

- Failure-incident cards return the 100 most frequent grouped Runner faults and the latest 20 distinct
  affected case names for each group; each displayed group's count is exact, and paged case rows remain
  available for complete record inspection.

## 1.3.10 - 2026-08-26

### Added

- Manual single-case executions now expose a “查看实时日志” entry in the attempt-log dialog as soon
  as an assignment exists. In-progress manual reruns also appear in the permanent log page's case
  history, where authenticated log readers can open the same live stream without waiting for
  completion.
- Administrators can configure a platform-wide IANA time zone from Platform Settings. New and legacy
  installations default to `Asia/Shanghai` (UTC+8), and saving the setting takes effect without a
  Web or worker restart.

### Changed

- Failure signatures preserve the original capitalization of exception names and messages while
  continuing to normalize UUIDs, integer values and whitespace for grouping. Existing lowercase
  analytics facts are rebuilt automatically in both Lite and Full modes.
- Authenticated pages, anonymous share/progress pages, notifications, scheduling logs and date-time
  inputs now use the platform time zone consistently. Quality trend days are grouped by that same
  calendar boundary; persistence, APIs, leases, deadlines and execution duration calculations remain
  UTC-based.
- Terminal attempt-log dialogs and permanent public log pages expose the same “执行此用例” action.
  Authenticated users with log-read and run-create permission can launch the hidden diagnostic rerun
  directly; anonymous readers are directed to sign in and are never allowed to execute through the
  permanent token alone.
- The standalone normal-Groovy analyzer now uses the identifier immediately following `class` as the
  case title and evaluates that title before annotation descriptions or narrative text. Duplicate
  keyword evidence is suppressed when the class title already provides the decisive match.

### Compatibility

- Existing `platform.json` files and v1 setup clients may omit `web.timeZone`; old files receive the
  UTC+8 default, while update clients that omit the field preserve the currently configured value.
- Runner Protocol v1, Jenkins Pipeline inputs and release archive formats are unchanged. Permanent
  log tokens remain read-only for anonymous visitors; live-log tickets and manual execution still
  require an authenticated user with project-scoped permission.

### Tests

- Extended the Lite Playwright all-rounds flow through a live manual rerun: the Runner claims the
  hidden batch, uploads an in-progress log chunk, and both the source log dialog and permanent log
  page read it before completion. Platform settings E2E now verifies an immediate time-zone update.
- Hardened the batch-shared Runner input E2E flow to wait for the JAR import page to hydrate before
  selecting and scanning the fixture, eliminating the hosted-CI race against disabled controls.
- Updated the dense-layout browser guard to exercise quality-insight date filters through their
  platform-time-zone labels instead of the retired browser-local labels.
- Added application and database coverage for in-progress diagnostic history, permission-bounded log
  targets, platform time-zone compatibility, configured calendar boundaries, capitalization-preserving
  failure signatures and automatic v3 analytics-fact rebuilds.

### Database and persisted configuration

- No SQLite or PostgreSQL DDL migration is required. Analytics facts advance from logical schema v3
  to v4 and are rebuilt from authoritative attempt summaries by the existing Lite/Full background
  worker path.
- `platform.json` gains the optional `web.timeZone` IANA identifier. Missing values default to
  `Asia/Shanghai`; persistence remains backward compatible with v1 setup/update clients.

### Offline assets

- The four backend variants, embedded static Runner Agent resources, Jenkins HPI files, deployment
  bundle, SBOMs, checksums, signature and release manifest retain the existing release matrix. No new
  runtime network dependency was introduced.

### Known limitations

- Anonymous permanent-log visitors can read persisted chunks from an in-progress manual rerun but
  cannot subscribe to its WebSocket stream; live streaming requires login and `log.read` permission.
- One permanent log link continues to bound its same-case diagnostic history to 500 rerun batches.

## 1.3.8 - 2026-08-26

### Added

- Execution details persist and display the effective concurrency for every round. A dynamic-rule
  transition is marked inline and recorded once in the scheduling log with the previous/new limits,
  previous-round pass rate and remaining case count.
- A terminal case log can launch a one-case diagnostic rerun from the original immutable Runner,
  Adapter asset, version and timeout snapshot. Diagnostic reruns stay out of execution history,
  analytics, statistics, search, webhooks and completion notifications; the permanent public log
  sidebar shows them chronologically with the requesting local or LDAP username.
- A terminal batch can create a normal new batch from only its final failed/timed-out cases. The
  dialog accepts a one-off base concurrency and can disable dynamic concurrency rules or Jenkins
  round recovery for that rerun without changing the source task.

### Fixed

- Concurrent scheduler passes cannot emit duplicate dynamic-concurrency transition events for the
  same round, rule and effective limit.
- The execution-recovery Playwright fixture now waits for client hydration before selecting its JAR,
  removing a full-suite race against the intentionally disabled pre-hydration upload control.

### Tests

- Added application coverage for immutable single-case/final-failure derivation and public diagnostic
  history, shared SQLite/PostgreSQL repository contracts for hidden reruns, final-failure selection and
  idempotent concurrency events, plus migration upgrade coverage.
- Extended the Lite Playwright all-rounds flow through a concurrency transition, Jenkins recovery,
  hidden user-attributed diagnostic rerun, anonymous same-tab history navigation and configurable
  final-failure rerun at both 1024px and 1536px desktop widths.

### Database

- Added SQLite `0048_round_rerun_observability.sql` and PostgreSQL
  `0047_round_rerun_observability.sql`. Existing batches are classified as standard and receive a
  first-round concurrency snapshot from their persisted policy (or the historical default of 4).

### Compatibility

- Runner Protocol v1, Jenkins Pipeline inputs and release archive formats are unchanged. New batch
  metadata, public-log requester fields and round concurrency fields are additive. Lite and Full use
  the same derivation, visibility and idempotency rules.

### Known limitations

- The public log sidebar remains terminal-only and bounds one case family to 500 diagnostic rerun
  batches. Active diagnostic attempts appear after completion; anonymous live streaming is unchanged.

## 1.3.7 - 2026-08-26

### Added

- Permanent anonymous attempt-log pages now show a chronological sidebar for every completed round
  of the same case in the same batch. Selecting a round replaces the log in the current browser tab,
  preserves browser history, and displays that round's result, completion time and duration.

### Fixed

- Lite's embedded persistent-job worker no longer stops permanently after sustained SQLite writer
  contention. Queue publication, claim, renewal, acknowledgement, rejection and lease recovery retry
  `SQLITE_BUSY`/`SQLITE_LOCKED` with bounded exponential backoff; lock failures beyond the ordinary
  supervisor limit continue restarting until the database becomes writable or the service shuts down.
- In-flight acknowledgement/rejection failures are now observed by the worker loop instead of
  becoming detached promise rejections that can silently halt queue progress.
- Jenkins dependency publication creates missing project versions and atomically replaces version
  archives through the same SQLite lock-recovery boundary. Empty Lite queue polls remain read-only so
  the recovery mechanism does not manufacture a recurring writer lock.
- The standalone normal-Groovy analyzer now matches compact exclusion keywords across CamelCase word
  boundaries while preserving negated phrases and longer, distinct identifier words.

### Security

- An attempt-log share token intentionally authorizes completed attempts only for the token's original
  `ExecutionRun` inside its recorded batch. Supplying an attempt from another case or batch returns the
  same invalid-link response and does not reveal whether that attempt exists.

### Tests

- Added real dual-connection SQLite contention regressions for persistent jobs and Jenkins dependency
  replacement, worker supervisor/in-flight failure tests, and application authorization/order coverage
  for public round navigation.
- Extended the Lite Playwright JAR-import scenario through a failed first round and successful retry,
  verifying anonymous same-tab log switching, active-round state and cross-round log isolation.

### Database

- No schema migration. Existing queue rows, dependency assets and attempt-log share records remain
  valid; no persisted configuration is rewritten.

### Compatibility

- Runner Protocol v1, Jenkins Pipeline step inputs and Docker-native release archive formats are
  unchanged. `SharedAttemptLogView.rounds` is additive. SQLite remains a single-writer database, so a
  sustained writer can increase latency, but it no longer requires restarting Lite to resume jobs.

### Known limitations

- Public attempt-log navigation lists terminal rounds only. A currently assigned or running round is
  added after it reaches a final result; live anonymous log streaming is not introduced in this release.

## 1.3.5 - 2026-08-25

### Fixed

- Round-mode retries no longer inherit the batch creation queue deadline while they are held between
  rounds or waiting for Jenkins environment recovery. Held runs are excluded from queue-timeout
  recovery, and receive a fresh task-configured queue window only when the next round is released.
- Immediate retries and retryable Runner-fault reschedules now also receive a new queue deadline from
  the moment they become eligible, instead of reusing a deadline consumed by the previous attempt.
- A transient Jenkins status request no longer immediately marks environment recovery and the batch
  as failed. Polling failures persist across worker restarts and retry up to ten consecutive times
  with bounded backoff; an explicit unsuccessful Jenkins build still fails immediately.

### Tests

- Added shared queue-timing unit coverage, a Lite regression proving expired held runs cannot be
  reclaimed as `QUEUE_TIMEOUT`, and Lite/Full repository assertions that the released round receives
  a renewed deadline. Added bounded Jenkins polling retry and migration upgrade coverage.

### Database

- Added SQLite `0047_round_recovery_poll_retries.sql` and PostgreSQL
  `0046_round_recovery_poll_retries.sql`. Existing recovery rows receive a zeroed consecutive polling
  failure counter; no task configuration or execution history is rewritten.

### Compatibility

- Runner Protocol v1, Jenkins Pipeline step contracts, task policy fields and release archive formats
  are unchanged. Lite and Full apply the same queue-timeout and Jenkins polling-retry semantics.

## 1.3.2 - 2026-08-25

### Added

- Execution round timelines now insert an environment-recovery node between the affected rounds.
  The node contributes its complete pause interval to elapsed time and shows every parallel Jenkins
  Pipeline separately with build number, URL, actual start/end time, result and post-build wait.
- Round case tables can now filter `assigned` and `running` attempts directly through the human-readable
  “已分配” and “执行中” states.

### Fixed

- Permanent execution-history links now render the same batch overview, round summaries, result
  charts and case tables as the authenticated execution detail page. The anonymous view omits the
  application shell and authenticated actions instead of collapsing the result into a progress card.

### Changed

- Scheduler capacity behavior was audited without changing its safety algorithm. There is no fixed
  concurrency reserve: healthy eligible Runners can fill the configured task/project/Runner minimum;
  CPU, memory, load, stale metrics and claim/heartbeat visibility can legitimately keep observed
  utilization below the configured upper bound.

### Tests

- Added Lite/Full migration coverage for recovery timeline fields, Jenkins timestamp/result parsing,
  application/repository persistence tests, and Playwright coverage for the running filter plus two
  parallel Jenkins recovery steps and their responsive timeline details.

### Database

- Added SQLite `0046_round_recovery_timeline.sql` and PostgreSQL
  `0045_round_recovery_timeline.sql`. Existing activated recovery rows conservatively use their last
  update as activation time; historical Jenkins start/end/result values remain empty because they
  cannot be reconstructed. Existing permanent run-share tokens resolve to the corrected detail view.

### Compatibility

- Runner Protocol v1, Jenkins Pipeline step contracts and release archive formats are unchanged.
  The new columns and detail DTO fields are additive; recovery API credentials remain excluded from
  authenticated and anonymous batch-detail responses.

## 1.3.0 - 2026-08-25

### Fixed

- Saved-profile Agent reinstalls now recover the existing logical Runner identity when the durable
  identity file is missing or corrupt. Suites, Runner groups and queued batches therefore remain
  bound to the same Runner id instead of waiting forever on an abandoned identity.
- Agent startup no longer aborts when more than 256 unfinished attempt records have accumulated.
  Recovery sends protocol-sized pages and only starts claims after every page has been reconciled.
- Restart recovery maps the Agent-only `uploading` phase to the protocol-v1 `finishing` phase. A
  restart during artifact upload no longer leaves systemd repeatedly starting an Agent that appears
  online from its initial heartbeat but never claims assignments.
- Terminal-enabled Agents obtain their direct WebSocket ticket before potentially long spool recovery,
  so the terminal channel can become ready while reconciliation is still running.
- Agent terminal WebSocket authentication now carries its signed short-lived ticket in both the
  authorization header and a secondary WebSocket subprotocol, allowing operation through proxies
  that strip authorization headers from Upgrade requests.

### Tests

- Added Lite and PostgreSQL identity-recovery repository coverage, corrupt-identity Agent coverage,
  proxy-stripped terminal authentication coverage, and a real SSH/systemd reinstall assertion that
  the Runner id is preserved.
- Added an Agent restart regression with 257 persisted upload-phase attempts; it verifies 256+1
  reconcile requests, protocol-compatible state mapping, local cleanup and subsequent claim polling.

### Database

- No schema migration. Existing Runner rows, suite bindings and persisted Agent configuration remain
  compatible.

### Compatibility

- Runner Protocol v1, Jenkins Pipeline contracts and Docker-native release archive formats are
  unchanged. Targeted reinstall tokens and `recoverIdentity` are consumed only by the new Agent
  installation flow; ordinary registration and existing Agent configuration remain compatible.

## 1.2.6 - 2026-08-25

### Fixed

- Reinstalling an Agent through a saved SSH profile no longer bypasses host probing or silently
  overwrites Runner labels, concurrency and terminal access with form defaults. Administrators now
  probe with the encrypted stored credentials, confirm the host key, and explicitly review or repair
  the complete deployment configuration before reinstalling.
- Batch Agent upgrades now replace only the versioned Agent binary and CoTest Adapter. Existing
  `config.json`, private CA, systemd unit, identity and data directory remain byte-for-byte unchanged;
  a coherent predecessor is still retained for offline rollback.
- Runner processes now diagnose successful assignment polling and terminal-gateway connection
  failures. This makes an online Agent that cannot claim work or establish its terminal channel
  distinguishable from a healthy Runner.

### Tests

- Extended the real SSH/systemd Playwright gate to reinstall with repaired labels and concurrency,
  perform a batch binary upgrade, compare configuration and service-unit SHA-256 digests, confirm
  assignment polling resumes, and execute a command through the real browser terminal.
- Added Runner control diagnostics regressions and saved-profile request contract coverage.

### Database

- No schema migration. Existing encrypted Runner installation profiles, identities and execution
  history remain compatible.

### Compatibility

- Runner Protocol v1 and Jenkins Pipeline contracts are unchanged. Existing batch-upgrade requests
  remain source-compatible but no longer rewrite deployment configuration. Release archives remain
  Docker-native `.docker.tar` assets.

## 1.2.2 - 2026-08-25

### Fixed

- Jenkins round recovery now keeps the next-round scheduling handoff in a leased, retryable state.
  A transient scheduler, event-store or process failure after a successful Jenkins build no longer
  leaves the batch permanently suspended; retrying the handoff does not trigger Jenkins again.
- Runner stdout/stderr forwarding no longer lets a slow shared spool apply backpressure to Java.
  Log persistence now drains asynchronously per attempt, avoids per-chunk `fsync`, and does not keep
  a second complete output copy in memory. This removes a high-concurrency failure mode where a test
  could reach `AfterTest`/`AfterClass` and then exceed its execution timeout while writing its tail.
- Long Java package and class names are no longer guessed to be JWT credentials. Ordinary test output
  is emitted immediately instead of retaining a fixed tail; explicit task secrets and credential forms
  such as Bearer tokens, passwords, tokens and API keys remain protected.

### Changed

- Overall and per-Runner scheduling logs open on the newest events, follow the tail by default, and
  automatically read older pages without a manual “load more” action. Reopening a log reuses a bounded
  page-local cache and refreshes only the new tail; virtualized rows keep large histories responsive.

### Database

- Added SQLite migration `0045_retryable_round_release.sql` and PostgreSQL migration
  `0044_retryable_round_release.sql` for the durable round-release state. The upgrade also requeues
  the scheduling handoff for a non-terminal batch already stranded by the old behavior.

### Tests

- Added Runner regressions for non-blocking log persistence, per-attempt spool isolation, immediate
  ordinary-log delivery and duplicate-buffer removal; race checks cover the affected Go packages.
- Added shared SQLite/PostgreSQL scheduling-event cursor coverage, Lite/Full round-release recovery and
  migration regressions, plus Playwright verification for tail-following scheduling-log dialogs.

### Compatibility

- Runner Protocol v1, Jenkins Pipeline step contracts and release archive formats are unchanged.
  Existing Lite and Full installations apply the new round-recovery migration during normal upgrade.

## 1.2.0 - 2026-08-24

### Added

- Execution history can generate a permanent anonymous result link for a batch in any lifecycle
  state; the public page remains resource-scoped and read-only.
- Unstable-case insight has an independent task and local start/end-time filter.
- Webhook endpoints can send an immediate synthetic test with 100 cases and an 80% pass rate; the UI
  reports the request method and response status without creating a retryable delivery record.
- Each Jenkins HPI directory now contains a minimal `Jenkinsfile` in addition to the combined example.

### Changed

- Public base URL and artifact collection settings now apply without restart. Artifact collection is
  resolved when a batch is created and stored in its immutable policy snapshot, so Lite and Full
  workers observe the same decision. Restart-only settings are listed explicitly after save.
- The dependency-publisher HPI defaults to ZIP metadata, reducing its normal Pipeline invocation by
  two parameters while preserving `fileName` and `archiveFormat` as optional setters for tarballs.
- Project, version, member, access and automation mutations refresh Server Component data without a
  full browser reload.

### Database

- No schema migration. Existing platform configuration, batches, Webhooks and permanent links remain
  valid.

### Tests

- Added application regressions for hot artifact settings and Webhook test payloads, configuration
  activation classification, real Jenkins Pipeline DSL verification, and Playwright coverage for
  hot settings, anonymous history sharing, scoped flaky filters, Webhook testing, no-reload project
  creation and supported desktop layouts.

### Compatibility

- Runner Protocol v1 and persisted schemas are unchanged. Existing Jenkins Pipeline invocations
  remain source-compatible; HPI 1.2.0 only makes ZIP metadata optional. Release images remain
  Docker-native `.docker.tar` archives.

## 1.1.10 - 2026-08-24

### Added

- Every Jenkins round-recovery rule now has a read-only configuration test. It validates Basic API
  credentials and the configured job URL by showing job availability, queue state and the previous
  build, without invoking the Rebuilder endpoint or starting a build.

### Changed

- Dynamic whole-round retry concurrency rules now use one explicit trigger round instead of a round
  range. A rule is evaluated only while that round is current; when it matches, its concurrency takes
  effect for that round and remains active until a later ordered rule matches in its own trigger round.
- Stored range-based retry rules remain readable and use their former starting round as the new
  trigger round.

### Database

- Added SQLite migration `0044_sticky_retry_concurrency.sql` and PostgreSQL migration
  `0043_sticky_retry_concurrency.sql` to persist the active retry-concurrency stage across Web/worker
  restarts and Full control-plane replicas.

### Tests

- Added domain, scheduler, Lite/Full repository and upgrade-migration regressions for one-round
  triggers, sticky concurrency and ordered overrides.
- Added application and HTTP transport coverage proving Jenkins configuration tests reuse encrypted
  credentials when needed and issue no rebuild request, plus Playwright UI and layout verification.

### Compatibility

- Runner Protocol v1 and Jenkins Pipeline step arguments/results are unchanged. Jenkins HPI 1.1.10
  contains no Pipeline contract break; release images remain Docker-native `.docker.tar` archives.

## 1.1.8 - 2026-08-24

### Added

- TestNG JAR inspection/import, DDT import, version-scoped Java/dependency archive uploads, local case
  list parsing and case/DDT deletion now expose bounded, accessible progress feedback instead of
  leaving long-running operations behind an unchanged action button.

### Fixed

- Lite's embedded job worker now retries transient queue failures with bounded exponential backoff.
  A temporary SQLite claim error no longer leaves JAR or DDT imports permanently queued until the
  Web process is restarted; repeated unrecoverable failures still make readiness fail explicitly.
- The JAR background-import progress card now preserves its inner spacing, wraps long status text and
  action controls, and prevents horizontal overflow at supported desktop widths.

### Tests

- Added unit coverage for browser upload progress and Lite worker recovery after a failed queue claim.
- Extended Playwright coverage for TestNG/DDT uploads, runtime archive uploads, bulk deletion progress
  and JAR progress-card layout at the minimum supported desktop width.

### Compatibility

- No database, persisted-configuration or Runner Protocol change from v1.1.6. Lite still embeds its
  worker and requires no separate worker process. Jenkins HPI Pipeline contracts and Docker-native
  `.docker.tar` release assets are unchanged.

## 1.1.6 - 2026-08-24

### Fixed

- Permanent case links, Jenkins progress/result links and exported attempt-log links now derive their
  fallback origin from trusted forwarding headers or the request Host instead of Next's internal
  listener URL. Direct offline containers therefore produce reachable links even when an explicit
  public base URL has not been configured.

### Tests

- Added origin-selection regressions for explicit configuration, reverse proxies, direct container
  Host headers and local fallback. Published offline asset lifecycle acceptance covers the direct
  container-IP path that exposed the defect.

### Compatibility

- No database or Runner Protocol change from v1.1.5. HPI Pipeline contracts remain additive and the
  Docker offline archive format remains `.docker.tar`.

## 1.1.5 - 2026-08-24

### Added

- A retry-round boundary can now contain multiple Jenkins environment recovery steps. AutoForge
  triggers due steps concurrently and releases the next round only after every Jenkins rebuild and
  its own post-success wait have completed; any failed step still fails the batch.
- Case details can now issue permanent, anonymous, resource-scoped read-only links. The public view
  shows friendly version/stage names and current case metadata and methods without exposing source,
  execution controls, history or neighboring project data.
- Jenkins run creation now returns a permanent anonymous `resultUrl`. The execution HPI prints it
  only after the batch reaches a terminal state and includes it in the Pipeline step result; the
  existing seven-day live progress link remains available while Jenkins waits.

### Changed

- Offline backend images are published directly as Docker-native `.docker.tar` archives. Target
  hosts can use `docker load --input` without installing zstd; published acceptance keeps read-only
  support for prior `.docker.tar.zst` releases when testing upgrades.

### Database

- Added SQLite migration `0043_parallel_round_recoveries.sql` and PostgreSQL migration
  `0042_parallel_round_recoveries.sql`. They preserve existing recovery state while replacing the
  one-step-per-boundary constraint with an indexed multi-step barrier.

### Tests

- Added contract, snapshot, application, Lite/Full repository, upgrade-migration and Playwright
  coverage for two same-round Jenkins recovery steps with different wait durations.
- Added permanent-token tamper/scope tests, anonymous Playwright coverage for case and completed-run
  pages at 1024/1536 pixel widths, Jenkins client/Pipeline result-link checks and Docker tar release
  contract tests.

### Compatibility

- Runner Protocol v1 is unchanged. The Jenkins run response adds `resultUrl`; the v1.1.5 HPI falls
  back to the temporary progress URL against an older server, while older HPI clients ignore the
  additive field. Permanent links depend on the installation master key remaining stable and stop
  resolving after their underlying case or batch is deleted.
- Web and worker processes must be upgraded together; database downgrade requires restoring the
  pre-migration backup. Automation that downloaded `.docker.tar.zst` must switch to `.docker.tar`;
  Docker itself is the only decompressor required for v1.1.5 offline images.

## 1.1.1 - 2026-08-24

### Fixed

- Signed Jenkins progress pages now bypass the session proxy and perform their existing batch-bound
  token validation anonymously, matching the already public progress API.
- Runner Agents pause assignment claims while disabled or draining and resume the same claim loop
  after an active heartbeat, eliminating online-but-idle runners after re-enablement.
- Both Jenkins clients force HTTP/1.1 so plain-HTTP Lite deployments do not attempt h2c. The server
  also returns an explicit error for unsupported h2c upgrades instead of closing the socket silently.
- Dependency publication failures now include the server's safe error message. `autoforgeRun` uses
  machine status rather than localized labels, follows the server polling interval and has a bounded,
  configurable total timeout (seven days by default).

### Tests

- Added anonymous-browser progress acceptance, reversible Runner drain coverage, explicit h2c
  response tests and Jenkins client/Pipeline tests for HTTP/1.1, timeout, status and error contracts.

### Compatibility

- Runner Protocol v1 remains unchanged. The optional Jenkins `timeoutSeconds` argument accepts zero
  for the server default or a shorter value up to 604800 seconds.
- The `v1.1.1` Jenkins HPI plugins require Jenkins `2.479.3` or newer and remain compatible with the
  existing `autoforgeRun` and `autoforgePublishDependencies` Pipeline step names.

## 1.1.0 - 2026-08-24

### Added

- Added a project-version/test-stage-scoped DDT workspace to case management. It supports dynamic
  fields, CaseID/srNum grouping, standard and multi-step journey cases, dashboard charts, advanced
  field search, bounded pagination, bulk edit/delete/export, field templates, immutable history and
  recycle restore/purge.
- Merged the differential functionality from `iskycc/ddt-insight` commit `705f552`: offline
  XLSX/XLS/XLSB/CSV/ODS parsing; bounded ZIP/ZIP64, Chinese-path and CSV-encoding handling; partial
  preview; overwrite/skip/error conflict policies; persistent asynchronous import, cancellation,
  crash recovery, source traceability and per-job CaseID export.
- Added authenticated `/api/v1/ddt/**` endpoints using existing service-account tokens, project RBAC,
  CSRF protection and audit events. Duplicate identity, LDAP, audit, backup and diagnostics stacks
  were deliberately replaced by the existing AutoForge implementations after a capability audit.
- Added reverse case-suite membership filtering in case management, allowing users to select a task,
  show only cases not yet included and add the resulting selection.

### Database

- Added SQLite migration `0042_ddt_management.sql` and PostgreSQL migration
  `0041_ddt_management.sql` for scoped DDT cases, history, recycle snapshots, templates, import jobs,
  per-file progress and imported CaseID outcomes. Full confirmation uses the transactional outbox;
  Lite confirmation uses the SQLite persistent queue.

### Tests

- Added domain/parser tests for templates, journey synchronization, spreadsheet round trips and
  Chinese ZIP entries, plus matching SQLite/PostgreSQL repository integration coverage.
- Added a compact Playwright DDT lifecycle covering import, UI layout at 1024/1536 pixels, dynamic
  editing, history, templates, bulk mutation, recycle and authenticated API access. CI runs it in a
  separate parallel browser partition so it does not extend the existing serial scenario critical
  path; the task lifecycle scenario now also verifies reverse membership filtering and add-back.

### Compatibility

- Runner Protocol v1 is unchanged. DDT data is new and isolated by project, version and test stage.
  Downgrading after either new migration requires restoring the pre-upgrade database/object backup.
- The `v1.1.0` Jenkins HPI plugins keep the existing Pipeline step contracts and require Jenkins
  `2.479.3` or newer.

## 1.0.2 - 2026-08-24

### Fixed

- Dynamic retry and Jenkins recovery rule creation now works when AutoForge is opened through a
  plain-HTTP host or container IP. Client rule IDs use `crypto.getRandomValues`, which remains
  available outside secure contexts, instead of the secure-context-only `crypto.randomUUID`.

### Tests

- Playwright now removes `crypto.randomUUID` before exercising the task policy editor, matching the
  published offline-container acceptance origin and preventing the secure-localhost blind spot.

### Compatibility

- No database, API or Runner Protocol changes. This release supersedes `v1.0.1` for plain-HTTP
  deployments; all `v1.0.1` migrations and persisted policies remain compatible.

## 1.0.1 - 2026-08-24

### Added

- Added ordered dynamic concurrency rules for round retries. A rule can combine the actual execution
  round, previous-round pass-rate range and current-round remaining-case range; the first match sets
  the in-flight limit and unmatched rounds retain the task's base concurrency.
- Added persisted Jenkins recovery boundaries between retry rounds. AutoForge rebuilds the previous
  Pipeline through the Jenkins Rebuilder endpoint, follows the exact rebuild cause to completion,
  waits the configured minutes and only then atomically releases the next round. The single
  `username:API Token` credential is encrypted outside task policy JSON and is never returned to the
  browser.

### Fixed

- Current-round pass rate now divides passed cases by terminal attempts only. Assigned and running
  attempts remain visible as in progress but no longer lower the displayed pass rate.
- Removing a Jenkins round-recovery rule now deletes its separately encrypted task credential in
  the same task-update transaction.

### Database

- Added SQLite migration `0041_retry_round_orchestration.sql` and PostgreSQL migration
  `0040_retry_round_orchestration.sql` for encrypted per-task Jenkins credentials and leased
  per-batch recovery state. Existing task and batch snapshots default to no rules and preserve prior
  scheduling behavior.

### Tests

- Added domain/application regressions for terminal-only pass rate, ordered concurrency matching and
  Jenkins recovery transitions; added matching Lite/Full repository coverage and Jenkins HTTP
  transport tests, including rebuild-cause correlation and returned-URL scope enforcement.
- Extended Playwright task lifecycle coverage at 1024 and 1536 pixels to configure both rule types,
  persist them, verify credential redaction and copy the encrypted configuration.

### Compatibility

- Runner Protocol v1 is unchanged. Jenkins recovery requires Jenkins `2.479.3` or newer plus the
  Rebuilder plugin; the configured Jenkins identity needs read/build permission for the selected job.

## 1.0.0 - 2026-08-23

### Added

- Added persistent delayed execution to the global task/single-case dialog. Users can choose an
  immediate start or a second-accurate countdown up to seven days, use common presets, and inspect
  the planned local start time before submitting. Execution records and batch details show the
  authoritative planned start and a live countdown.
- Added real Jenkins Pipeline DSL end-to-end tests for both HPI plugins using the Jenkins test
  harness and mock AutoForge HTTP contracts. A packaged-HPI verifier now checks manifests, declared
  dependencies, embedded plugin JARs and step classes after every Maven build.
- Added a complete declarative [Jenkinsfile](examples/jenkins/Jenkinsfile) covering Java build/test,
  version-scoped dependency publication, task execution, credentials and archived diagnostics.

### Changed

- Unified execution-history result counts with the detail “总结” rule: a case that passed in any
  round counts as passed; otherwise its highest attempt round supplies the final failure, timeout or
  cancellation. The adapters aggregate this rule inside SQLite/PostgreSQL without loading large
  attempt histories into application memory.
- Queue deadlines and priority aging now begin at the planned start, so a countdown never consumes
  queue timeout or gains artificial scheduling priority. Queue availability and the scheduling
  service independently reject early dispatch.

### Database

- Added SQLite migration `0040_delayed_run_batches.sql` and PostgreSQL migration
  `0039_delayed_run_batches.sql`. They backfill `run_batches.scheduled_for` from `created_at` and add
  a due-batch scheduling index. Existing batches therefore preserve their original start semantics.

### Tests

- Added contract/application regressions for delay bounds, authoritative planned time and direct
  scheduling guards; added shared SQLite/PostgreSQL integration coverage for due-time visibility and
  final-round counts.
- Extended Playwright functional/UI coverage at 1024 and 1536 pixels to configure a countdown,
  verify the exact persisted start offset, confirm no early assignment and inspect live detail
  countdown/layout behavior.

### Compatibility

- Runner Protocol v1 is unchanged. Existing clients that omit `delaySeconds` remain immediate; task
  policy remains the sole execution configuration because the new field is scheduling metadata.
- The `v1.0.0` HPI plugins require Jenkins `2.479.3` or newer and are verified against Pipeline Job
  `1508.v9cb_c3a_a_89dfd` and Pipeline Groovy `4009.v0089238351a_9` in CI.

## 0.9.11 - 2026-08-23

### Changed

- Made the selected project version the visible scope for case-suite lists, case-to-suite selection,
  the global run dialog, execution history, dashboard summaries, Quality Insights, Runner activity
  and schedule operations. The UI displays the human-readable version name instead of leaking its
  internal identifier.
- Strengthened task execution invariants: new tasks bind an active version, task members must come
  from that version, moving a populated task across versions is rejected, and copies retain the
  validated association. Batch and single-case preflight now reject missing, archived or mismatched
  version context across browser, schedule, Jenkins and API entry points.
- Added version filtering to the task and execution-history repository contracts before pagination,
  so a busy neighboring version cannot starve the selected version's rows.

### Database

- No schema migration is required. Existing task and batch policy snapshots already persist
  `projectVersionId`; legacy ambiguous records remain readable from detail/audit paths but are blocked
  from new execution until a valid version is selected.

### Tests

- Added application regression coverage for ambiguous task creation, cross-version membership,
  version moves and execution preflight, plus matching SQLite/PostgreSQL filter assertions.
- Added Playwright functional and visual coverage for two versions in one project at 1024 and 1536
  pixels, including task/history isolation, human-readable scope, global-run options and cross-version
  mutation rejection.

### Compatibility

- Runner Protocol v1 and all persisted schemas are unchanged. `v0.9.11` can read existing task and
  batch snapshots; only unsafe legacy records without an unambiguous version require administrator
  repair before they can execute.

## 0.9.10 - 2026-08-23

### Added

- Added project-scoped completion Webhooks with a dedicated “回调通知” page. Endpoints support GET
  query notifications or POST JSON templates, documented batch/result variables, enable/disable,
  optimistic editing, deletion, recent delivery diagnostics and task-level multi-endpoint binding.
- Persisted each eligible terminal batch notification once and dispatch it through a leased,
  restart-safe queue in both Lite and Full. Network errors and non-2xx responses use four bounded
  retries; notification failures never change the authoritative batch or TestNG result.

### Changed

- Expanded Quality Insight detail dialogs to the available desktop viewport and switched every
  detail table to fixed, viewport-aware columns. Long cells truncate with their complete value
  available as a title, tables scroll vertically only, and no dialog requires a horizontal
  scrollbar at the supported 1024-pixel minimum width.

### Database

- Added SQLite migration `0039_webhook_notifications.sql` and PostgreSQL migration
  `0038_webhook_notifications.sql`. They add project-scoped endpoint configurations, task bindings
  and immutable delivery request snapshots with due time, lease, retry and response diagnostics.

### Tests

- Added contract and application coverage for URL/template validation, GET/POST rendering, 2xx
  completion and bounded retry behavior; added SQLite/PostgreSQL adapter coverage for idempotent
  terminal-event materialization, binding time boundaries and assertion-failure summaries.
- Added browser coverage for endpoint configuration and task binding, plus 1024/1536-pixel UI
  integrity checks that open every available Quality Insight detail dialog and reject horizontal
  overflow.

### Compatibility

- Runner Protocol v1 is unchanged. Webhook delivery is inactive until an administrator creates and
  binds an endpoint, so upgraded offline deployments make no new outbound requests by default.
- Release images, deployment bundles, embedded static Runner binaries, Jenkins HPI plugins, SBOMs,
  checksums and build provenance are regenerated for `v0.9.10` by the tagged Release workflow.

### Known limitations

- Webhooks intentionally support JSON request bodies without arbitrary secret headers. Credentials
  must not be embedded in URLs; place an authenticated internal relay in front of receivers that
  require proprietary authentication.

## 0.9.9 - 2026-08-23

### Changed

- Kept execution lifecycle separate from TestNG outcomes throughout execution records and batch
  details. A batch whose Adapter attempts all completed normally is shown as `执行完成` even when
  assertions or TestNG configuration methods failed; only scheduling, Runner, process, timeout,
  upload and other incomplete-execution failures are shown as `执行异常`.
- Added deletion to the offline schedule overview. Authorized users can now pause, resume, edit or
  permanently delete a suite schedule from the same bounded table.
- Replaced the flattened `版本 → 阶段一、阶段二` text with an accessible nested version/stage tree,
  including stage counts, descriptions and stable empty states.
- Scoped JDK and dependency archives to individual project versions. Administrators can upload or
  register independent resources, inherit another version's resources through shared database/object
  references without copying bytes, and remove either resource without affecting versions that still
  reference it. Newly created case suites explicitly bind the currently selected project version,
  so execution preflight and batch snapshots always resolve that version's resources.
- Added bounded cross-version case inheritance between explicit source and target test stages. The
  target receives independent case IDs and immutable v1 snapshots while sharing the source JAR;
  existing fully qualified class names are skipped, and later target-stage imports retain the target
  case ID.
- Stabilized the empty case-library layout with a fixed readable work area that does not collapse or
  stretch surrounding cards.

### Database

- Added SQLite migration `0038_version_assets_and_batch_status.sql` and PostgreSQL migration
  `0037_version_assets_and_batch_status.sql`. They make both JDK and dependency references
  version-scoped, preserve existing installations by materializing legacy project resources into
  existing versions, allow explicit inherited references, replace the obsolete source/class unique
  index with scoped lookup indexes, and repair historical failed batch rows whose only failures are
  normal TestNG outcomes.
- Uploaded runtime objects are removed only after the last configuration and active batch reference
  disappears. Metadata is finalized after object-store deletion so a failed Lite/MinIO deletion does
  not silently lose the cleanup reference.

### Tests

- Added domain/presentation regressions for authoritative completed status with failed assertions,
  application tests for paginated case inheritance and runtime-resource cleanup, and SQLite/PostgreSQL
  adapter coverage for version isolation, reference inheritance, guarded deletion and stable-ID
  target reimport.
- Extended browser coverage for schedule deletion, nested version/stage rendering, version-aware
  resource selection and the non-collapsing empty case-library state.

### Compatibility

- Runner Protocol v1 is unchanged. Existing project-level runtime settings are copied into existing
  project versions during migration; newly created versions start without implicit resources and
  must upload, register or explicitly inherit them.
- Release images, deployment bundles, embedded static Runner binaries, Jenkins HPI plugins, SBOMs,
  checksums and build provenance are regenerated for `v0.9.9` by the tagged Release workflow.

### Known limitations

- Runtime-resource and case inheritance stay within one project. Cross-project references remain
  forbidden by repository scope checks and foreign-key validation.

## 0.9.8 - 2026-08-22

### Changed

- Reworked Quality Insights into a compact visual dashboard: method history uses a multi-series line
  chart, failure clusters use a pie chart, flaky samples use stacked columns, and batch changes use
  comparison columns alongside the existing outcome donuts. Every chart exposes its exact data from
  a top-right detail action instead of expanding long tables directly in the page.
- Bounded insight detail dialogs to the desktop viewport with sticky table headers, independent
  horizontal and vertical scrolling, comfortable row spacing and 50-row client windows for large
  batch comparisons. The 1024-pixel desktop layout retains two chart columns without page overflow.
- Replaced permission codes in role, service-account, project-permission and API-token controls with
  concise Chinese names and purpose descriptions. Forms and HTTP contracts continue to submit the
  stable permission codes, including a visible fallback for permissions introduced by newer versions.
- Refined dense administration and execution pages with localized state/action labels, clearer
  control grouping, bounded identifiers and logs, and viewport-safe low-frequency action dialogs.
- Extended tagged release assembly to 45 minutes so variable GitHub upload throughput cannot cancel
  publication while transferring the four large, platform-specific offline backend archives.
- Added graceful task termination to the execution-record list and batch details. A termination
  request immediately blocks scheduling and claims, closes work that has not started, lets valid
  in-flight leases finish naturally, suppresses retries, and then presents the batch as terminated.
  The legacy batch-cancel endpoint now delegates to the same semantics.
- Moved Lite scheduling, high-frequency Runner control transactions and attempt-log writes to a
  bounded worker-thread pool. Runner claim recovery and same-key scheduling are coalesced, scheduling
  snapshots scale with configured capacity, and SQLite assignment input/Runner data is bulk-loaded
  instead of queried once per decision.
- Optimized the complete Lite/Full control path rather than relying on worker count alone: batch
  status aggregation now uses indexed presence checks and skips unchanged hot-row writes, claim and
  recovery context reads are batched, execution-record summaries avoid per-row queries, and burst
  refills perform one leading plus at most one trailing scan. SQLite control and log writes now use
  short immediate transactions so multiple WAL worker connections wait instead of failing on a
  deferred read-to-write lock upgrade.
- Added streamed route skeletons and deferred in-page filtering feedback to case management, task
  management, execution records and batch details so large queries do not appear frozen.
- Raised task policy concurrency to 10,000 while retaining bounded scheduling windows and storage
  transactions; the Runner registration per-node safety boundary remains unchanged.
- Reimporting a different TestNG JAR into the same project version and test stage now updates the
  existing case with the same fully qualified class name. The stable case ID, manual display name,
  description, tags and task memberships are retained; executable metadata and methods are replaced
  and an immutable `source.reimport` version is appended.
- Added permission-scoped single and bulk deletion to the case library. Deletion removes the case,
  its version/method catalog and task memberships while retaining already materialized execution and
  analytics records.
- Scoped import idempotency and queue deduplication to project/version/stage. The same content-addressed
  JAR can now be imported into multiple project versions without a false duplicate conflict.

### Database

- No migration is required for task termination or Lite worker threads. They reuse the existing
  `run_batches.cancel_requested_at`, WAL database and per-batch attempt-log stores.
- Added SQLite migration `0036_shared_case_source_objects.sql` and PostgreSQL migration
  `0035_shared_case_source_objects.sql`. They replace the global unique JAR object-key index with a
  non-unique lookup index; project-hierarchy SHA-256 indexes remain the source-import idempotency
  boundary.
- Added SQLite migration `0037_run_batch_list_index.sql` and PostgreSQL migration
  `0036_run_batch_list_index.sql` for project-scoped execution-record cursor reads.

### Tests

- Added a complete permission-presentation mapping test and browser regressions that verify role and
  service-account pages never expose known permission codes as their primary labels.
- Added production-build browser coverage for the insight line, pie and comparison-column charts,
  fixed-height 1024/1536 layouts, viewport-bounded detail dialogs, sticky scrollable tables and
  paginated batch-comparison details.
- Added domain, application and SQLite/PostgreSQL adapter regressions for graceful termination,
  completed-assignment cancellation, retry suppression, concurrent claim coalescing and worker-pool
  sizing. The browser scheduling scenario terminates a five-case task with two in-flight attempts,
  verifies that no new assignment is issued, and captures the final execution-record screenshot.
- Added a repeatable Lite capacity gate that atomically reserves 500 assignments across 25 Runners
  in under five seconds; the current local run completed the bounded pass in under 300 ms.
- Added a production-build Playwright gate used by CI and Release checks. Eight virtual Runners claim
  500 slots, upload 500 logs and submit 500 completions while execution-record reads are timed; the
  JSON measurements and failure trace are retained as workflow artifacts. The local regression
  completed the protocol phase in 5.28 seconds with 141.77 ms read P95 and 196.96 ms maximum latency.
- Added a 100,000-run graceful-termination gate; set-based SQLite transitions completed locally in
  under one second instead of iterating through every run on the Web event loop.
- Added Lite and Full adapter regressions for stable-ID overwrite, immutable version creation,
  method replacement, cross-version shared JAR objects and scoped deletion.
- Extended the browser regression to import one JAR with the same idempotency key into two versions,
  and to screenshot and exercise case-library single and bulk deletion.

### Compatibility

- The insight and permission changes are presentation-only: permission values in APIs, persisted role
  definitions, database schemas and Runner Protocol v1 are unchanged.
- Runner Protocol v1 and database schemas are unchanged. Existing clients may continue calling
  `/cancel`; new integrations should use `/terminate`. The Lite release now includes a bundled
  Node 24 worker entry and adds `esbuild` as a build-time-only, offline-locked dependency.
- Runner Protocol v1 is unchanged. Existing case and source data remains readable; old duplicate
  cases created under the former source-scoped identity are consolidated on the next matching JAR
  reimport, with task memberships moved to the oldest stable case ID.
- Release images, deployment bundles, embedded static Runner binaries, Jenkins HPI plugins, SBOMs,
  checksums and build provenance are regenerated for `v0.9.8` by the tagged Release workflow.

### Known limitations

- The authenticated UI supports desktop browser widths of 1024 pixels and above; mobile layouts are
  intentionally outside the supported and tested interface baseline.

## 0.9.7 - 2026-08-21

### Changed

- Added a standalone Groovy/Java package-path repair utility for repository test sources. It derives
  package declarations from directory paths, validates Java/Groovy identifiers, preserves UTF-8 BOM
  and comments, writes atomically, and remains idempotent across repeated runs.
- Removed the fixed 20,000-entry rejection from TestNG JAR inspection, background import and source
  viewing. JAR entry and discovered-class counts are no longer capped; compressed upload size,
  declared uncompressed bytes, individual class/source size and warning output remain bounded.

### Database

- No migration is required. JAR discovery and the source-tree repair utility do not change persisted
  records or configuration schemas.

### Tests

- Added discovery/source-reading and authenticated HTTP inspection regressions using real JARs with
  more than 20,000 ZIP entries.
- Added package-path repair coverage for Java/Groovy declarations, root/default packages, comments,
  idempotency and validation-before-write behavior.
- Stabilized browser acceptance helpers by targeting native select controls without changing the
  user-visible selection behavior.

### Compatibility

- No database migration or Runner Protocol change is required. The former `TOO_MANY_ENTRIES`
  inspection failure is no longer emitted.
- Release images, deployment bundles, embedded static Runner binaries, Jenkins HPI plugins, SBOMs,
  checksums and build provenance are regenerated for `v0.9.7` by the tagged Release workflow.

### Known limitations

- JAR entry and discovered-class counts are unrestricted, but deployment-configured compressed
  upload size, declared uncompressed bytes and individual class/source size remain resource safety
  boundaries.

## 0.9.6 - 2026-08-21

### Changed

- Added direct `.xlsx` case-list import using the first worksheet's first column. Text lists now
  decode UTF-8, UTF-16 and GB18030 instead of treating binary workbooks or Chinese Windows CSV as
  UTF-8 text and displaying mojibake.
- Promoted every administration destination to a four-character first-level sidebar entry; the
  former one-item and two-item collapsible groups were removed so permission-filtered destinations
  remain directly visible.
- Extended the server-validated top-bar context from project only to project, project version and
  test stage. The case library, single-case picker, quality analytics and TestNG JAR importer now
  consume that same hierarchy, and JAR imports no longer expose page-local version/stage selectors.
- Kept task execution sourced exclusively from each task's saved policy: the top-bar version and
  stage scope single-case choices and imports but no longer hide otherwise executable project tasks.
- Restored quality metrics and daily trends to the top of Quality Insights. Long per-case outcome
  details and batch comparison now follow the summary, while analytics queries and exports are
  scoped to the selected project version and test stage in both SQLite and PostgreSQL.

### Database

- No migration is required. Version/stage analytics scoping joins existing case-definition
  hierarchy columns and does not change persisted analytics facts.

### Tests

- Added XLSX Chinese-text, GB18030 CSV and UTF-16 list parser coverage, plus browser verification
  that an XLSX list matches and selects cases from the case library.
- Added CI structure guards for flat four-character sidebar entries and the three-part global
  context, adapter-level analytics hierarchy coverage, and Playwright checks for cross-page context
  persistence, JAR import targets and summary-before-detail layout.

### Compatibility

- Runner Protocol v1, persisted configuration schema v1 and the `0.9.x` embedded Agent compatibility
  line are unchanged. Existing project, task, case and analytics records require no data migration.
- Release images, deployment bundles, embedded static Runner binaries, Jenkins HPI plugins, SBOMs,
  checksums and build provenance are regenerated for `v0.9.6` by the tagged Release workflow.

### Known limitations

- The authenticated UI supports desktop browser widths of 1024 pixels and above; mobile layouts are
  intentionally outside the supported and tested interface baseline.
- Case-list upload supports `.xlsx` but not the legacy binary `.xls` format. Legacy workbooks must be
  saved as `.xlsx`; encrypted or damaged workbooks are rejected with an actionable error.

## 0.9.5 - 2026-08-21

### Changed

- Added one server-validated global project switch to the top bar. Dashboard, cases, imports, suites,
  execution records, insights, sources, audit and project settings now share that project context;
  page-local project switches were removed while project-version/stage filters remain contextual.
- Removed configurable TestNG parameter overrides from case-suite policy and single-case requests.
  Imported TestNG parameter metadata remains read-only and is still frozen into execution snapshots.
  Single-case execution now enables the CoTest Adapter by default.
- Case-suite members now use a searchable package tree with group selection and transactional bulk
  removal that creates one suite version per operation.
- Case-library directory checkboxes now select or clear every manageable descendant and expose a
  mixed state for partial selection. Case and task trees render large folders in bounded pages.
- Removed the former 500-case task capacity. Lite and Full now persist 100,000-member tasks and
  100,000-run batches through bounded SQL batches; scheduling reads a 4,096-run refill window rather
  than materializing the complete pending batch on every heartbeat.
- JAR import retry is now idempotent when an automatic queue retry wins the race and has already
  queued, started or completed the same import. Full 100k capacity contracts run in their own CI
  partition so the real-Agent acceptance remains below the five-minute target.
- SQLite historical migration tests use an explicit bounded timeout that accommodates hosted-runner
  disk variance without weakening migration assertions.
- Consolidated related access and platform settings behind page-local four-character tabs, removed
  stale platform/LDAP links from operations, and moved low-frequency create, password reset, role
  assignment and suite-copy actions into centered full-viewport dialogs.

### Database

- No migration is required. Legacy suite-policy `parameters` keys remain readable during upgrade and
  are discarded by policy normalization before a new suite version or batch is written.
- No migration is required for 100k task capacity; existing membership and execution tables are used
  with chunked reads/writes and aggregate summary queries.

### Tests

- Added 100,000-case folder-selection, Lite task-membership, Lite execution-batch and Full PostgreSQL
  execution-batch capacity coverage. The assets browser job now uploads screenshots of selected case
  and task folders in addition to the fixed-viewport layout screenshots.
- Expanded fixed-viewport UI evidence to cover the task execution-policy region, the single-case
  dialog with its default CoTest Adapter state, and every low-frequency management dialog introduced
  by this redesign. Screenshot jobs install a system CJK font so Chinese labels remain reviewable in
  uploaded artifacts.

### Compatibility

- Runner Protocol v1 and the `0.9.x` embedded Agent compatibility line are unchanged. Existing task
  records remain readable, but new suite versions and single-case requests no longer accept manual
  TestNG parameter overrides; imported parameter metadata remains part of immutable case snapshots.
- Release images, deployment bundles, embedded static Runner binaries, Jenkins HPI plugins, SBOMs,
  checksums and build provenance are regenerated for `v0.9.5` by the tagged Release workflow.

### Known limitations

- The authenticated UI supports desktop browser widths of 1024 pixels and above; mobile layouts are
  intentionally outside the supported and tested interface baseline.
- Tasks containing 100,000 cases use bounded persistence, scheduling and browser windows. Actual
  completion throughput still depends on Runner capacity, dependency download speed and database or
  object-storage performance.

## 0.9.1 - 2026-08-21

### Changed

- Case suites now own the complete reusable execution configuration: Runner or Runner Group,
  project version, Adapter addresses, parameters, retry policy and queue/claim/upload recovery
  windows. The global dialog starts a selected suite without asking users to reconstruct its policy.
  The duplicate suite execution-timeout setting was removed; all case processes use the platform
  `caseExecutionTimeoutSeconds` setting.
- Normal TestNG completion now ends a batch as `执行完成` even when cases ultimately fail. Exhausted
  infrastructure faults end as `执行异常`, while user cancellation ends as `执行中断`; case outcomes
  remain visible in the summary and analytics instead of being conflated with lifecycle status.
- Product-managed execution environments and execution secrets were removed from navigation, pages,
  HTTP routes and new execution inputs. Historical schema fields remain readable for upgrade safety
  but new batches always store an empty compatibility snapshot.
- Assertion summaries now decode HTML space entities and keep only the assertion expression above
  Groovy-style power-assert `|` diagrams, preventing multiline diagrams from falling back to a class
  and method placeholder.
- Added API-Key-authenticated Jenkins endpoints and two Pipeline plugins. `autoforgeRun` waits for the
  complete batch lifecycle, prints a compact progress line every 30 seconds and exposes a signed
  progress-only link; `autoforgePublishDependencies` replaces the dependency archive for one project
  version without retaining an application-level file history.
- Execution records now give the table an explicit fixed-layout pixel width derived from the
  70th-percentile column widths, so a single long cell cannot make every row in that column wider.
- Successful Runner installation/manual update now stores the SSH host, port, username, password
  and optional private CA as an AES-256-GCM encrypted connection profile. Saved profiles support
  passwordless reinstall/update from the browser and bounded four-way batch updates of up to 50
  Runners with per-node results.
- Batch details add a virtual `总结` round with exactly one final row per initial case. A case that
  passes in any attempt counts once as passed; otherwise its latest attempt supplies the final result.
- Runner/infrastructure result codes now receive up to two immediate rescheduling attempts independent
  of the configured case-failure retry budget. Scheduling prefers a different eligible Runner, falls
  back for single-Runner deployments, and exposes grouped Runner incidents from the execution detail.
  These recoverable infrastructure attempts are excluded from TestNG quality rates, failure insight
  clusters and flaky-case detection.
- Runner capacity accounting now includes assignments in every non-terminal batch phase, including
  `dispatching` and `scheduled`, preventing claim-triggered recovery scheduling from exceeding the
  declared concurrency before the first Agent claim updates the batch to `running`.
- GitHub Actions now partitions Full, network-blocked Lite, tagged-source quality and published
  Release acceptance into independent state-isolated jobs. The longest browser and infrastructure
  paths no longer serialize unrelated scenarios behind one 10-17 minute job.
- Published-asset acceptance starts from the successful `Release` workflow completion instead of
  spending several minutes polling for a Release that is still being built. A manual dispatch still
  supports rechecking an existing immutable tag with the current acceptance harness.
- Lite browser coverage now reuses one production build within four duration-balanced scenario
  groups instead of consuming eleven concurrent runners on eleven duplicate builds.
- Main CI balances Full adapter/Agent and execution/LDAP/dependency recovery across two shared-platform
  jobs, and folds deployment checks into Lite operations so the initial wave stays within hosted
  concurrency without creating a new serial bottleneck.

### Tests

- Added browser coverage for both Jenkins endpoints, signed no-login progress rendering without the
  application shell, 30-second polling metadata and complete task lifecycle. Added Maven Harness
  tests for both Pipeline steps and an independent Jenkins plugin CI job.
- Migrated real-Agent, java-cases, shared-input and container E2E fixtures away from the removed
  environment/secret planner. Container execution now supplies its mode through a saved TestNG
  parameter, while restart recovery carries its marker through the task Adapter address snapshot.
- Added domain and dual-database contracts for independent infrastructure retry budgets, immediate
  round-mode recovery and alternate-Runner preference; browser coverage verifies the summary round,
  incident dialog and fixed table geometry after injecting an extreme long cell.
- Added dual-database capacity regressions for scheduled/dispatching batches and analytics coverage
  proving recoverable Runner failures remain available as incidents without becoming test failures.
- Added AES-GCM/profile service and SQLite/PostgreSQL repository tests. The real SSH/systemd scenario
  verifies that APIs never return the password and updates an installed Runner through its saved
  encrypted profile in the batch endpoint.
- Added workflow contract coverage that rejects reintroducing the unpartitioned Full and offline
  commands and verifies the post-publication acceptance matrix retains asset, Agent, LDAP, backup,
  rollback and upgrade coverage.
- Made the published backup/restore scenario seed and verify its own persisted settings instead of
  depending on another browser scenario to run first.
- Stabilized the batch-shared-input E2E by waiting for Agent workspace links to finish materializing
  after a later attempt reports `running`, removing a filesystem sampling race.
- Updated the real-Agent restart acceptance paths to require automatic recovery: interrupted attempts
  remain visible as Runner incidents while replacement attempts complete the batch successfully.
- Replaced the recovered real-Agent fixture's fixed two-minute sleep with an isolated one-shot attempt
  marker, preserving abrupt-restart coverage while keeping both Lite and Full Agent CI jobs bounded.

### Database

- Added SQLite migration `0035_project_version_dependencies.sql` and PostgreSQL migration
  `0034_project_version_dependencies.sql`. Each project version has at most one active dependency
  archive; a Jenkins publication atomically replaces the prior row.
- Added SQLite migration `0033_runner_installation_profiles.sql` and PostgreSQL migration
  `0032_runner_installation_profiles.sql`. Existing Runner rows are unchanged; connection profiles
  are created only after a successful install or manual update.
- Added SQLite migration `0034_runner_fault_scheduling_events.sql` and PostgreSQL migration
  `0033_runner_fault_scheduling_events.sql` so the persisted scheduling-event constraint accepts
  the additive `runner_fault_rescheduled` incident event without changing existing history.

### Compatibility

- Runner Protocol schema v1 and Runner binaries are unchanged. Existing historical environment and
  secret snapshots remain readable, but their management/lease HTTP routes are removed and cannot be
  used for new execution. `POST /api/v1/run-batches` task mode now accepts only `{ "suiteId": ... }`;
  callers that previously rebuilt suite policy per request must save it on the suite first.
- Infrastructure scheduling events and Jenkins routes are additive; existing manual Runner
  install/update requests remain accepted.
- Release images, deployment bundles, embedded static Runner binaries, Jenkins HPI plugins, SBOMs,
  checksums and build provenance are regenerated for `v0.9.1` by the tagged Release workflow.

### Known limitations

- The authenticated UI supports desktop browser widths of 1024 pixels and above; mobile layouts are
  intentionally outside the supported and tested interface baseline.
- Jenkins controllers must be able to reach the AutoForge control plane. Dependency URLs published
  by Jenkins must remain reachable by the control plane and Runner network when an execution uses them.

## 0.9.0 - 2026-08-20

### Changed

- Standardized every first- and second-level sidebar entry on a four-Chinese-character label and
  added a CI-enforced source test so navigation redesigns cannot silently regress the naming rule.
- Redesigned analytics trends, failure reasons and flaky-case presentation to use compact card
  proportions, method-level TestNG totals, human-readable error descriptions and case names.
- Expanded the dashboard fluid desktop width through 4K while keeping 1024px as the supported
  minimum; mobile layouts are explicitly outside the product and test baseline.
- Execution-record columns now use their 70th-percentile row content for initial sizing while
  retaining manual resize persistence. Failed rows sort by their human-readable failure description
  after the primary status category instead of falling back to case names under one shared code.

### Fixed

- Current top-level TestNG result counts are now aggregated correctly while legacy nested summaries
  remain readable. Successful result codes can no longer produce failure facts, and stale analytics
  facts are rebuilt automatically with the corrected schema version.
- The global execution dialog is mounted through a body portal so its backdrop covers the complete
  viewport and the dialog remains geometrically centered instead of being constrained by the topbar.
- Multiline power-assert diagnostics are recognized without an Adapter marker and compacted to one
  line without discarding their values. The CoTest Adapter installs explicit UTF-8 stdout/stderr
  streams before loading user classes, preserving mixed Chinese/English `Assert.assertTrue` messages.
- Runner log uploads now split batches by the actual encoded 2 MiB request limit and shrink/retry
  batches rejected by a lower proxy limit; transient failures retain bounded exponential retries.
- Pre-launch input failures now distinguish execution disk-policy overflow from actual Runner
  workspace disk exhaustion with `EXECUTION_INPUT_DISK_LIMIT_EXCEEDED` and
  `WORKSPACE_DISK_INSUFFICIENT` instead of the misleading `PROCESS_START_FAILED`.
- The JAR importer keeps its controls disabled until client hydration completes, preventing an early
  file selection from being discarded and leaving the scan action permanently disabled.

### Tests

- Added shared analytics unit and SQLite recovery coverage, a PostgreSQL success-fact assertion, a
  real completion-protocol browser scenario for 50% pass/fail analytics, and desktop viewport checks
  for dashboard scaling and full-screen dialog geometry.
- Added regressions for percentile column sizing, failure-description sorting, multiline
  power-assert extraction, encoded log-request splitting and transient retry, disk-capacity result
  classification, a real Adapter assertion carrying mixed Chinese/English text, and hydrated JAR
  upload readiness in the Full real-Agent recovery path.

### Database

- No database migration or persisted platform-configuration migration is required.

### Compatibility

- Runner Protocol schema v1 and the offline asset layout remain unchanged. The new workspace-disk
  result codes are additive; older stored result codes remain readable.
- Release images, deployment bundles, embedded static Runner binaries, SBOMs, checksums and build
  provenance are regenerated for `v0.9.0` by the tagged Release workflow.

### Known limitations

- The authenticated UI supports desktop browser widths of 1024 pixels and above; mobile layouts are
  intentionally outside the supported and tested interface baseline.

## 0.8.5 - 2026-08-20

### Added

- Added persistent Runner Groups for Lite/SQLite and Full/PostgreSQL, including optimistic updates,
  member management, dual-adapter contract tests and immutable member snapshots when an execution
  batch is created. Both suite and single-case execution can select either direct Runners or one
  Runner Group.
- Added a global “开始执行” dialog to the top bar on every authorized page. It supports suite and
  single-case execution, managed or inline environments, Runner Groups, retry policy, parameter
  overrides and CoTest Adapter Suite/Test/environment addresses.
- Added an implementation-facing UI review and information-architecture guide; it now lives at `docs/design/product-interface-implementation.md`.

### Changed

- Rebuilt the authenticated homepage around the six sections from the approved dashboard design:
  weekly quality, active execution, case library, Runner Groups, failure insight and recent
  activity. Empty states use real product actions instead of placeholder metrics.
- Removed the standalone batch planner from primary navigation and regrouped administration into
  project collaboration, identity/access, execution configuration and platform operations.

### Fixed

- Execution failure descriptions now preserve the complete multiline UTF-8 adapter summary instead
  of truncating it or falling back to `class#method 执行失败`. Runner JVM processes explicitly use
  UTF-8 console encodings, and oversized writes are split at the Runner Protocol chunk boundary.
  The internal Base64 summary control record remains in authoritative logs for extraction but is
  hidden from interactive and public log views.
- Round totals now use the cases eligible for each round: the initial round contains all cases and
  each retry round contains the preceding round's failures/timeouts. Not-executed counts update while
  a round is active, and the all-rounds row sums every displayed round consistently.
- Completed attempt rows no longer expose cancellation actions merely because their execution run is
  queued for a later retry. Execution detail tables use compact fixed layouts with 70th-percentile
  content widths so isolated long values wrap without stretching the whole column.
- Single-case execution now resolves the case's actual project instead of silently falling back to
  the default project, schedules through the shared batch state machine, and persists Adapter
  environment IP/address settings into the immutable execution specification.
- The global execution dialog now resolves each managed environment's current immutable version
  before rendering it. A non-empty environment list can no longer crash the dialog by treating
  environment summaries as version details.

### Tests

- Added multiline/long/Chinese failure-summary coverage across Adapter, control plane, UI and public
  log views, plus live round aggregation, retry eligibility, compact layout and terminal-row action
  E2E coverage. The existing all-rounds scenario is now part of the GitHub Actions browser matrix.
- Added a Lite browser scenario that creates a Runner Group, starts one case through the global
  dialog and verifies the claimed assignment contains the selected Runner, parameters and Adapter
  environment address.

### Database

- SQLite migration `0032_runner_groups.sql` and PostgreSQL migration `0031_runner_groups.sql` add
  `runner_groups` and `runner_group_members`. Existing execution data is unchanged.

### Compatibility

- Runner Protocol schema v1 and the offline asset layout are unchanged. The Base64 failure marker
  and Runner Group HTTP contracts are additive; control planes continue to accept the legacy
  plaintext marker during rolling upgrades.
- Existing Lite and Full installations must apply the new Runner Group migrations during upgrade.
  No persisted platform-configuration migration is required.

### Known limitations

- The authenticated desktop UI continues to require a viewport width of at least 1024 pixels;
  mobile layouts remain outside the supported interface baseline.

## 0.7.2 - 2026-08-19

### Fixed

- CoTest batch sharing now gives every attempt a real `test-jars` directory whose JAR files are
  hard-linked to the single batch-level extraction. This preserves inode-level reuse while allowing
  the Adapter's non-following Java directory walk to discover the JARs; the optional JDK remains a
  controlled directory symlink.
- Expiration recovery now ignores queued, active-lease and unclaimed records whose batch is already
  terminal, and verifies run/attempt/assignment states before recovery. Stale records can no longer
  make later Runner claims fail with an invalid terminal batch transition.
- The GitHub Actions batch-sharing acceptance packages a bounded `jlink` runtime instead of the
  hosted runner's complete JDK, keeping the real-JDK extraction scenario within execution disk and
  file budgets.
- Restart reconciliation now removes a killed attempt's obsolete workspace even when its old lease
  expired before the completion could be reported. The persisted completion and spools remain
  available for a later retry, while batch-input hard links and workspace disk are released. The
  Agent now persists the execution process-group leader with its Linux kernel start time; restart
  reconciliation verifies that identity, kills the surviving group without PID-reuse risk, and then
  performs a second orphan scan. Local attempt-state schema v2 remains able to read and automatically
  upgrade v1 records.
- Scheduler project and Runner capacity accounting now excludes stale active attempts whose run or
  batch is already terminal. Scheduling-refill adapter fixtures use isolated projects and clean up
  their PostgreSQL records, so Full-mode acceptance cannot be blocked by prior contract-test data.

### Compatibility

- No database migrations, platform persisted-configuration changes, Runner Protocol changes, or
  offline asset format changes. Runner local attempt state advances from schema v1 to v2; existing
  v1 records are read and upgraded automatically.

## 0.7.1 - 2026-08-19

### Fixed

- Batch sharing now materializes the CoTest `test-jars` tree and optional JDK once under
  `work/batches/<batchId>/runtime/cotest/`; attempts reuse the extracted dependency files through
  symlinks instead of extracting the same archive again.
- Batch workspace closure is remembered until the final local attempt exits. Idle cached batch IDs
  are reconciled through heartbeats and assignment claims, so every participating Runner cleans its
  copy in a multi-Runner batch, including draining or disabled Runners that no longer claim
  assignments; disabled heartbeat remains drain/cleanup-only and does not restore execution rights.
- Safe batch workspaces now survive Agent restart and are reused after reconcile while the batch is
  still active; terminal, deleted, foreign and malformed cache entries are cleaned deterministically.
- Reconcile completion now also removes crashed attempt workspaces, so hard links to batch inputs do
  not keep downloaded files alive after the batch cache is deleted.
- A failed terminal batch-directory deletion is retained for the next heartbeat/claim cleanup
  handshake instead of becoming an untracked leak.
- Completion-triggered scheduling failures now return an error so the Agent replays the persisted
  completion with the same ID and retries the idempotent slot-refill operation.
- Version-diff labels and historical snapshot presentation now use readable Chinese method
  signatures as well; raw JVM descriptors are no longer exposed through method tooltip text.

### Tests

- The scheduling-refill browser scenario now covers an immediate retry starting while a sibling
  first attempt remains in flight.
- The real-Agent batch-input-sharing scenario is wired into a dedicated GitHub Actions job and now
  verifies concurrent attempts, a later refill attempt and a post-crash attempt all reuse the same
  raw inputs and extracted dependency inode before terminal cleanup.

## 0.7.0 - 2026-08-19

### Features

- Batch-level shared execution inputs on the Runner Agent: all test-jar / dependency-jar /
  jar-bundle / jdk-archive inputs of one batch are downloaded and extracted exactly once per
  runner into `<agent data dir>/work/batches/<batchId>/`. Concurrent attempts of the same batch
  reference them through hard links (with a copy fallback across filesystems) and a shared
  `runtime/jdk` symlink, so five parallel attempts no longer download the same JAR five times.
  Existing inputs are re-validated by streaming SHA-256 and only re-downloaded on mismatch. The
  shared directory is removed once the control plane confirms the batch is terminal
  (`batchClosed`) and no local attempt of that batch is still running; agent startup reconcile
  now also removes orphaned `work/<attemptId>-*` leftovers and unreferenced `batches/*`
  directories left behind by crashes.
- Runner Protocol completion responses carry the optional `batchId` and `batchClosed` fields
  (additive change, schemaVersion unchanged) so agents can recycle batch workspaces and the
  control plane can trigger refill scheduling.

### Changed

- Scheduling now refills freed concurrency slots immediately: accepting an attempt completion
  re-runs batch scheduling at once, and batches in `running` status remain schedulable, so a
  runner with 10 slots starts the next case as soon as any case finishes instead of waiting for
  the whole wave of 10 to complete (previously assignments were only created at batch creation
  and on heartbeats, and `running` batches were excluded from scheduling).
- Method signatures in the UI are shown as Chinese readable text instead of raw JVM descriptors:
  the import scan preview, the case-source preview, the case details method table (column
  “描述符” renamed to “方法签名”) and the case-library selection table now render
  “入参：…，返回值：…” — `()V` reads as “入参：空，返回值：空”,
  `(Ljava/lang/String;I)Z` as “入参：String、int，返回值：boolean”. The raw descriptor
  moves to a hover tooltip so overloaded methods stay precisely identifiable. Data, contracts
  and execution matching are unchanged (still `methodName + descriptor`).

### Tests

- New dual-database contract suite `packages/db/test/scheduling-refill.integration.test.ts`:
  `running` batches stay schedulable, completions report the correct `batchId`/`batchClosed`,
  and a freed slot is refillable while sibling runs are still in flight.
- New end-to-end spec `tests/e2e/scheduling-refill.spec.ts`: five cases on a two-slot runner,
  each accepted completion immediately yields the next assignment without any heartbeat, and
  `batchClosed` only turns true on the final completion.
- New end-to-end spec `tests/e2e/batch-input-sharing.spec.ts` driving the real Go Agent: two
  concurrent attempts of one batch share the same downloaded inputs (identical inodes via hard
  links, stable mtimes proving no re-download), the batch workspace is removed after the
  terminal state, and a crashed-then-restarted agent cleans up the orphaned batch directory.
- `tests/e2e/all-rounds.spec.ts` export step hardened against the tab-navigation re-render race.

### Compatibility

- Runner Protocol change is additive and optional on both sides; older agents and servers
  interoperate unchanged (agents without batch sharing simply re-download per attempt).
- No database migrations, no persisted-configuration changes, no offline asset changes.

## 0.6.6 - 2026-08-18

### Fixed

- All-rounds virtual round layout: the panel reused the two-column `round-detail-body` grid whose
  first column is reserved for the donut charts, so the case table was squeezed into a ~320px
  column — the 轮次 cell wrapped vertically and the status/runner/duration/action columns were
  clipped. The all-rounds panel now renders the table full width and the 轮次 cell is
  `nowrap`. A new end-to-end spec (`tests/e2e/all-rounds.spec.ts`) drives a real two-round batch
  through the Runner Protocol and asserts the per-round annotations, the status filters, the
  “previously passed cases disappear from later rounds” behaviour, the `scope=all` export, and a
  table-width layout regression check.

### Compatibility

- Style/test-only change on top of 0.6.5; no migrations, configuration, or API changes.

## 0.6.5 - 2026-08-18

### Features

- Batch details gains an “全部轮次” virtual round (`?round=all`): every attempt of every case is
  listed as its own row with a 轮次 column, so cases with records in several rounds are explicitly
  annotated. The view supports the existing status filter, name search, sorting, pagination, log
  viewing, and inline details, and its export dialog defaults to the new export scope.
- New result-export scope `all` (“全部轮次，逐条记录，标注轮次”): the Excel workbook contains one
  row per terminal attempt across all rounds with a leading 轮次 column and a
  `...-all-rounds.xlsx` filename. The previous “全部轮次（每个用例最终结果）” option is renamed
  “最终结果”; never-executed cases remain excluded, consistent with the existing scopes.

### Fixed

- Later rounds no longer list cases that already passed in an earlier round as “未执行”: per the
  scheduling semantics those cases never re-enter subsequent rounds, so the per-round case table
  now filters them out and only shows cases genuinely waiting for the selected round.
- JAR import scan preview and the case-source persisted preview no longer degrade into a long
  strip of blank-looking rows for large imports: above 100 test classes the list is replaced by a
  count summary pointing at the scan warnings (import progress still comes from the background
  job status), and duplicate `className` candidates are de-duplicated before rendering to avoid
  duplicate React keys.

### Compatibility

- No migrations, no persisted-configuration changes. The export API gains `scope=all` as an
  additive value; existing `round`/`final` exports are unchanged.

## 0.6.4 - 2026-08-18

### Changed

- The public log-access page (`/share/attempt-log/...`) is now fully dark themed: the page
  previously mixed a white chrome with the dark log panel, which was straining to read. The
  page overrides the semantic color tokens (canvas, surfaces, text, borders, status colors,
  shadows) locally, so the info card, status badges, truncation warning, and the
  invalid-link view all follow the same dark palette as the log output. No markup or API
  changes.

### Compatibility

- Style-only change; no migrations, configuration, or API changes.

## 0.6.3 - 2026-08-18

### Features

- Execution-records page size selection: the filter form gains a “每页条数” dropdown with
  10 / 50 / 100 / 500 options (URL `limit` parameter; unsupported values fall back to 50).
  The page-size choice survives pagination and refresh links, which keep `limit` and `cursor`
  in the query.
- Runner names on the batch details page: the case-table runner column, the 执行机 sub-tab
  card headings, and the scheduling-log viewer title now show the registered runner name
  (typically `runner-<ip>`) instead of a bare UUID prefix. The full UUID remains in the
  tooltip; runners that cannot be resolved (no `runner.read` permission, purged runners)
  fall back to the UUID short code. The directory is loaded server-side under `runner.read`
  and never leaks the runner list to accounts without that permission.
- Runner cards in the 执行机 sub-tab now show the latest resource snapshot
  (`CPU x% · 内存 y% · 负载/CPU z`, load normalized per core, collection time in the
  tooltip, same format as the runners page). Active batches already refresh server data
  every 5 seconds, so the snapshot stays current while a batch runs; “暂无资源快照” is
  shown before the first heartbeat reports metrics.

### Fixed

- 0.6.2 regression: `AGENT_RESTARTED_DURING_EXECUTION` disappeared from the batch details
  page (the failure-summary enrichment replaced the agent-reported summary with a heuristic
  log line, and the status column then preferred the summary over the reason code).
  Reconcile-replayed completions (`AGENT_RESTARTED_DURING_EXECUTION`,
  `EXECUTION_CANCELLED_DURING_RECONCILE`) no longer undergo log-tail summary enrichment —
  their logs belong to the killed process — and the case-table failure hint now follows the
  blocked taxonomy: normal adapter failures keep the stack-line summary, blocked terminations
  (restart, timeout, adapter never started, …) show the reason code.

### Compatibility

- No migrations, no persisted-configuration changes, no API field changes; upgrades are
  drop-in.

## 0.6.2 - 2026-08-18

### Features

- Global artifact-collection switch: a new platform setting `limits.artifactCollectionEnabled`
  (default `true`, editable in 平台设置 as “启用产物收集”). When disabled, execution specs are
  generated without artifact rules, so the Runner Agent skips artifact scanning and upload entirely
  (no agent change — it only scans when rules are present), and the batch details page no longer
  renders or fetches the artifacts block. The switch applies to batches created after saving;
  already-scheduled batches keep the spec they were created with.
- Natural-incrementing batch display numbers: `run_batches` gains a `sequence_number` column
  (migrations `sqlite/0031`, `postgresql/0030`; existing rows backfilled densely in
  `(created_at, id)` creation order). The execution-records table now shows the full `#N` instead
  of a truncated UUID, the batch details hero shows `批次 #N` (UUID in the tooltip), and the
  public log-access page shows `批次 #N`. UUIDs remain the authoritative identifiers everywhere
  (URLs, Runner Protocol, foreign keys, dedup keys); list ordering/cursors are unchanged.

### Changed

- Failure summaries show the concrete stack line instead of result codes or class-path prefixes.
  When the completion log tail contains the adapter failure marker
  (`TestCase Run Failed Stack: [...]`) — or, without structured results, a heuristic exception
  line — the attempt summary is replaced by that line rather than concatenated as
  `类路径#方法 | 堆栈`. This affects the batch details status column (which now renders the
  summary instead of codes like `TESTNG_ASSERTIONS_FAILED`, falling back to the code only when no
  summary exists), the public log-access page “错误描述”, and the exported spreadsheet error
  column. The `类#方法 执行失败` placeholder remains as fallback when no stack line is found.

### Compatibility

- Persisted configuration gains `limits.artifactCollectionEnabled`; older configuration files
  parse with the default `true`, keeping current behavior.
- Batch API responses and the shared log view gain `sequenceNumber` / `batchSequenceNumber`
  fields (additive only).

## 0.6.1 - 2026-08-18

### Fixed

- Artifact collection no longer fails a test attempt. After an execution finishes (logs already
  collected), the Runner Agent scans the attempt workspace for files matching the execution spec's
  artifact rules — by default the TestNG report tree `reports/testng/**` — and uploads them as
  downloadable artifacts. Previously any matched symbolic link or special file, more than 256
  matched files, or a size/byte-budget breach rejected the whole scan and overrode the attempt's
  real result with `ARTIFACT_DISCOVERY_REJECTED`, so a passed case could be reported as failed.
  The scan is now best-effort: uncollectable files are skipped (symbolic links are never followed
  or read), healthy files are still collected, and the attempt result stays authoritative — it is
  determined by the parsed TestNG report and the process exit code. Only a missing `required: true`
  artifact still fails the attempt (`REQUIRED_ARTIFACT_MISSING`). Case result classification,
  scheduling semantics and custom artifact rules (for example `artifacts/*.txt`) are unchanged.

## 0.6.0 - 2026-08-18

### Features

- Case execution timeout, managed by the adapter itself: a new platform setting
  `limits.caseExecutionTimeoutSeconds` (default 600s, editable in 平台设置 as
  “用例执行超时（秒）”) flows through `executionSpec.adapter.caseTimeoutSeconds` into a new
  optional CoTest adapter CLI flag `--case-timeout-seconds`. The adapter runs TestNG on a daemon
  worker thread with a bounded wait; when the case exceeds the limit it prints the machine-readable
  marker `TestCase Execution Timeout: ...` and exits with code 3 (exit-code contract: 0 success,
  1 failure/adapter error, 2 argument error, 3 case timeout). The Runner Agent maps exit code 3 to
  `timed_out` with the new result code `ADAPTER_CASE_TIMEOUT`, which stays authoritative even if a
  partial TestNG report exists. Omitting the flag keeps the adapter's own 600s default, so older
  control planes remain compatible; the agent and adapter ship together in the agent resources,
  so the new flag never reaches an adapter build that predates it.

### Changed

- Blocked redefined per the operational rule “any non-normal exit is blocked”: only adapter-normal
  success (`TESTNG_SUCCEEDED`, `TESTNG_SUCCEEDED_WITH_SKIPS`, `TESTNG_ALL_SKIPPED`, legacy
  `PASSED`) and adapter-normal failure (`TESTNG_ASSERTIONS_FAILED`,
  `TESTNG_CONFIGURATION_FAILED`, legacy `TEST_ASSERTION_FAILED`) result codes count as
  succeeded/failed; every other terminal outcome — timeout kills (including
  `ADAPTER_CASE_TIMEOUT`), cancellations, adapter never started or crashed, log-limit breaches,
  unknown or missing result codes — is classified blocked via a whitelist
  (`packages/domain/src/attempt-result.ts`). The new classification drives the case-list
  selection statistics (总数/成功/失败/阻塞 with success/failure/blocked rates), the case-list
  “最近执行结果” filter and badges (超时/取消 latest runs now render as 最近阻塞), the quality
  insights project/version case-outcome report, and the Excel export.
- Export semantics follow the new blocked rule: rows always come from a real attempt — cases that
  never executed have no terminal result and are no longer exported (they used to appear as
  “阻塞（未执行）” rows with empty timestamps); use the round table or the 未执行 case filter to
  list them. The `timed_out`/`cancelled` export filters remain as narrow aliases of blocked
  (timeout-family vs cancellation-family result codes), the blocked option is now labeled
  “阻塞（异常结束）”, and the default checked outcomes changed from 失败+超时 to 失败+阻塞 so a
  first export covers every non-normal exit.
- Batch round table column 阻塞数 renamed to 未执行数: it counts runs still held by that round
  (scheduling semantics) and is a different concept from the result-classification blocked above.

### Fixed

- Access management (用户管理/会话管理) rendered timestamps with locale-dependent
  `toLocaleString()`, producing a React hydration mismatch whenever the server locale differed
  from the browser locale. Under load the hydration rebuild could replace a half-filled form input
  and swallow the create-user submit. All affected timestamp cells now use the locale-pinned
  `formatLocalDateTime` shared by the rest of the UI.

### Compatibility

- Persisted platform configuration gains `limits.caseExecutionTimeoutSeconds`; missing values in
  older configuration files fall back to 600s on load (no migration).
- Execution specs gain `adapter.caseTimeoutSeconds` (optional, defaults to 600 when absent), an
  additive contract change; agents older than this release keep running without the flag.

## 0.5.0 - 2026-08-18

### Features

- Run batch detail: each round panel now offers 导出结果, exporting that round's (or every round's
  final) case results to Excel. Columns are 用例路径、名称、执行结果、错误描述（一行堆栈，仅失败/超时）、
  执行开始时间、执行结束时间、执行耗时(s)、日志链接. The 日志链接 column points at a new
  login-free log public-access page `/share/attempt-log/[token]` that renders the adapter's full
  execution log with the same keyword highlighting as the in-app log viewer; tokens are random
  32-byte values of which only the SHA-256 hash is stored. Links are **permanent**: the
  `expires_at` column keeps its NOT NULL contract and new records carry the sentinel expiry
  `9999-12-31T23:59:59.999Z`, replacing the former 30-day TTL (records signed by older releases
  expire naturally and are replaced by permanent links on re-export). Blocked (not-yet-executed)
  cases export without timestamps or links. Export performance is sized for 50k+ rows within one
  minute: link issuance runs through a batched existence-check / lookup / single-transaction
  `createMany` path and the workbook is streamed (measured ~11s for 50,000 rows in the performance
  suite).
  - Migrations: `sqlite/0030_attempt_log_shares.sql`, `postgresql/0029_attempt_log_shares.sql`
    (new `attempt_log_shares` table, cascade-deleted with attempts/batches).
  - API: `GET /api/v1/run-batches/[batchId]/export?scope=round|final&round=<n>&outcomes=...`
    (auth + `run.read`; returns the xlsx attachment; errors use stable codes BATCH_NOT_FOUND /
    INVALID_SCOPE / INVALID_ROUND / INVALID_OUTCOMES), plus
    `POST /api/v1/run-attempts/[attemptId]/log-share` for issuing a single public-access link
    from the batch detail page (audited as `attempt_log.share`).
  - Known limitation: permanent links have no revocation channel; deleting the attempt/batch
    (cascade) is currently the only way to retire one. There is no manual revocation UI yet.
- Case management list: cases can be filtered by their latest terminal run outcome
  (成功 / 失败（含超时与取消）/ 从未执行), and selecting cases shows aggregate statistics —
  总数、成功数、失败数、阻塞率（未执行占比）— in the selection toolbar.
- Quality insights: a new 项目 / 版本用例执行情况 report lists every case of the chosen project
  version with its latest outcome and execution time, bounded to 500 detail rows.
- Runner Agent data directory: the SSH installer and the post-install update flow both accept a
  custom absolute working directory (default remains `/var/lib/autoforge-agent`); the installer
  validates the path (absolute, no `..`) and the 8th script argument stays optional, so older
  control planes that omit it keep the default. Updating without a directory reads the remote
  config back and keeps the current value. Existing data under the old directory is not migrated.
- Execution records page: every column can be resized by dragging; widths persist per browser in
  localStorage (`autoforge.execution-records.column-widths.v1`) with per-column minimums, and
  batch details open through a dedicated 详情 button instead of clicking the batch id.
- Run batch detail: rows no longer auto-expand; page size is selectable up to 500 with a
  single-load per-attempt detail cache (artifacts/events are fetched once per session), a refresh
  button, name/status/runner/duration sorting, and a 公开日志 button on finished attempts that
  opens the permanent public log page in a new tab.
- Layout: page content width now follows the viewport — `clamp(1540px, 90vw, 2160px)` for
  `.page-stack` and `clamp(1280px, 82vw, 1920px)` for the case detail page — so large screens use
  their space while viewports below the old caps render exactly as before; mobile breakpoints are
  untouched.

### Fixed

- Case suite detail page: the 离线计划触发 enable checkbox no longer clips against the card edge; it
  now sits in the schedule actions row instead of a squeezed fourth grid column, so the label stays
  fully visible at any viewport width and with any platform CJK font.
- Sidebar navigation: opening a run batch detail (`/run-batches/[id]`) now keeps 执行记录 active
  instead of jumping to 用例批跑, matching the detail page's 返回执行记录 back link.

## 0.4.18 - 2026-08-17

### Fixed

- Scheduling logs (both the batch-wide 调度日志 and the per-runner log) now explain failures that
  happen outside the test case itself. Completion events for failed/timed-out attempts include the
  result code and a compact single-line failure summary (for example
  `ARTIFACT_DISCOVERY_REJECTED：discover artifacts: ...`) directly in the event message, and the
  recovery sweep now writes scheduling events for attempts reclaimed after lease expiry, execution
  timeout, upload/completion timeout, or assignment claim timeout, so a dropped or offline runner no
  longer leaves the schedule log silent.

## 0.4.17 - 2026-08-17

### Fixed

- Runner artifact discovery no longer fails the whole attempt when the workspace contains symbolic
  links or special files that match no artifact rule (for example the in-bounds symlinks inside an
  extracted JDK `legal/` directory). Only symlinks or non-regular files matched by an artifact
  pattern are still rejected, which keeps the upload safety contract; unmatched entries are skipped.
  Previously a successful test run could be reported as failed with
  `discover artifacts: artifact scan rejected symbolic link ...`.

## 0.4.16 - 2026-08-17

### Fixed

- TestNG adapter exit code no longer derives from TestNG's raw status bitmap, which includes the
  skip bit: executions with skipped-but-no-failed tests exited 1 and were reported as failed even
  though the case log showed success. The adapter now fails the process only when failed or
  configuration-failure counts are non-zero; skipped-only executions are classified from
  `testng-results.xml` as succeeded (all-skipped / with-skips). The raw status bitmap is still
  printed to the case log for diagnostics.
- Run batch detail round case table now shows the terminal result code (for example
  `AGENT_RESTARTED_DURING_EXECUTION` or `TESTNG_ASSERTIONS_FAILED`) directly under the status badge,
  so scheduling-level failures are visible without expanding the row; this also restores the
  real-Agent acceptance expectation that the restart reason is visible on the batch page.

## 0.4.15 - 2026-08-17

### Added

- Case library bulk import by table: the 用例管理 page now offers an 导入用例 dialog that
  accepts a single-column 用例路径 table from a .csv/.tsv/.txt file or pasted text (one path
  per line, optional header), parses and previews exact path matches against the case library
  (including an unmatched-path report), and checks all matched cases in one action. Paths are
  accepted in both directory form (`com/example/CheckoutTest`) and dotted class-name form
  (`com.example.CheckoutTest`). Matching runs entirely in the browser; no server API changes.

### Changed

- Run batch detail page redesigned around retry rounds: a metrics band (status, overall pass rate,
  case counts, start time, ticking elapsed time, current round) followed by a rounds table with
  per-round status, totals, pass rates (round and cumulative), passed/failed/blocked counts, start
  time and duration. Selecting a round (persisted in the `?round=` URL parameter) opens a detail
  panel with self-drawn SVG donut charts (round outcome distribution and cumulative pass progress),
  a filterable paginated case table with per-case live log viewer and inline TestNG/artifact/event
  details, a per-runner tab with runner scheduling log access, and an overall scheduling log
  button. Active batches refresh every 5 seconds.

### Fixed

- Failed attempt summaries now use the adapter's machine-readable marker line
  (`TestCase Run Failed Stack: [...]`, content equals the first line after `Stack Trace:` in the
  adapter report, i.e. `exception class: message`) instead of a heuristic scan for the last
  exception-like line in the log tail, which could pick up unrelated later lines such as
  `Exception in thread "main" ...`. The marker is appended even when a structured TestNG summary
  exists; the log-tail heuristic remains as fallback when no marker is present.
- Run batch detail page no longer overflows horizontally at narrow widths: the detail layout's
  single grid column now allows shrinking (`minmax(0, 1fr)`), so wide round/case tables scroll
  inside their own containers instead of stretching the page.

## 0.4.14 - 2026-08-17

### Changed

- Sidebar information architecture: the workbench entry is renamed to 工作概览, and 文件来源 moves
  from the top level into the 执行与平台 management group. The dashboard bento cards now use a
  uniform 3×2 equal-width grid (and equal two-column widths on medium screens) instead of mixed
  5/4/3 column spans.

### Fixed

- Runner agent workspace preparation now accepts in-bounds relative symlinks in JDK tar archives
  (some JDK repacks use symlinks instead of hard links for duplicated legal files); absolute or
  escaping symlink targets are still rejected, and the forbidden-type error now reports the actual
  tar entry type to make future archive incompatibilities diagnosable.
- Run batch detail page: the attempt selector in the output section no longer stretches across the
  full width (the width rule targeted the hidden native control instead of the drawn select), and
  terminal attempts no longer open a live log stream or show a stale "updating live" badge.
- Case suite detail page: the schedule form's enable checkbox renders as a single row aligned with
  the other controls, and the copy-as-new-suite row uses the same field styling as the rest of the
  form. The `--shadow-elevated` design token is now declared in `:root`.

## 0.4.13 - 2026-08-17

### Added

- One-click in-place runner agent updates: the runners page marks nodes whose agent is older than
  the bundled build and offers an update dialog (SSH probe, fingerprint confirmation, backup and
  rollback via the existing installer chain) that keeps the runner identity, credentials,
  configuration and execution history. Deregistered runners cannot be updated in place.

### Fixed

- Runners without the `isolation:cgroup-v2` capability (for example openSUSE nodes without cgroup
  v2 delegation) are no longer rejected by execution preflight; the agent executes with its
  documented degraded isolation (rlimits, process-group cleanup, timeouts) instead.
- The runner agent now extracts hard link entries from JDK tar.gz archives instead of rejecting
  them as forbidden types; OpenJDK distributions reuse duplicated legal files via hard links, so
  JDK workspace preparation failed on those archives. Link targets must stay inside the attempt
  workspace and must already be extracted.

## 0.4.12 - 2026-08-17

### Added

- Deregistered runners can now be deleted from the runners page: a tombstone purge clears the
  credential permanently, removes the record from listings, keeps historical execution references,
  and writes an audit event. Deleting a runner that has not been deregistered is rejected.

### Changed

- JDK and dependency JAR archive uploads are staged inside the platform data directory
  (`upload-staging/`) instead of the OS temp dir, so uploads no longer fail with ENOSPC on hosts
  where /tmp is a small tmpfs; a full data disk now returns an explicit storage error (HTTP 507).

### Database

- SQLite migration 0029 and PostgreSQL migration 0028 add the `runners.purged_at` column.

## 0.4.11 - 2026-08-17

### Added

- Introduce a dedicated execution records page: every batch is listed with suite/test name,
  status, pass rate, passed/failed counts, current round, retry mode, runner count, creation
  time and duration, with the project/suite/status/runner/time filters moved there from the
  batch planner page.
- Add a selectable round-based retry mode alongside immediate retry: failed runs can now wait
  for the next round so the whole suite re-runs together, with the current round tracked on the
  batch and shown in records and batch details.
- Split execution logs into three scoped terminal-style viewers: batch scheduling log with
  per-round assignments and low-frequency runner resource snapshots, per-runner scheduling log,
  and the per-attempt stdout/stderr/agent output log.
- Add the java-cases fixture module plus a full E2E pipeline covering JAR import, task creation,
  case selection, runner assignment, execution and log/artifact verification, including a
  concurrent multi-attempt log isolation check.

### Changed

- Store attempt log chunks in a per-batch SQLite file (`attempt-logs/<batch>.sqlite`) instead of
  the primary database in both lite and full modes; the primary database now keeps only the file
  path, run results and the failure summary, so heavy log volume can no longer pressure the main
  store. Retention and batch deletion remove the log file.
- Enrich failure summaries with the last exception or stack line from the attempt log tail when
  no structured TestNG report exists, and show that line directly in the batch runs table.
- Regroup the sidebar administration entries into collapsible two-level groups （项目与权限 /
  执行与平台） collapsed by default, rename 用例库 to 用例管理 and LDAP 目录 to 目录配置， and move
  运维审计 under administration.
- Replace native selects, date-time inputs and related form controls with shared self-drawn UI
  components across the app.

### Fixed

- Restore exact-text matching for the run result code by rendering it in its own element, and
  keep navigation group expansion robust across the post-login second page load.

### Database migrations

- SQLite: `0026_retry_mode_round`, `0027_scheduling_events`, `0028_attempt_logs_external`.
- PostgreSQL: `0025_retry_mode_round`, `0026_scheduling_events`, `0027_attempt_logs_external`.
- Upgrade note: `attempt_log_chunks` in the SQLite primary database is dropped; attempt logs
  recorded before this version are removed during migration, run/attempt results are kept.

## 0.4.10 - 2026-08-14

### Changed

- Load the complete selected case hierarchy instead of stopping at 50 records, keep directories
  collapsed by default, and add an in-page search plus a scrollable split workspace that shows case
  details, history, source and actions without leaving the case library.
- Promote administration modules with their own sections to permission-aware primary navigation
  entries instead of nesting them under a crowded management center.
- Move CoTest Suite/Test/environment settings from project configuration into versioned case-task
  policy, add an explicit Adapter switch, and assign multiple environment addresses to cases in
  stable round-robin order when the batch snapshot is created.
- Stream uploaded JDK and dependency archives to object storage without a fixed business-size cap;
  execution still enforces protocol, workspace-disk, extracted-byte and file-count safety budgets.
- Remove the remaining 5000-class `testng.xml` selection ceiling so it cannot reintroduce a test
  discovery count limit; validated JAR entry, expansion, per-class and warning budgets remain.
- Discover every dependency JAR up to three directories below `test-jars`, remove the separate JAR
  count ceiling, and verify the distributed Adapter plus nested dependency archive in the
  network-blocked real-Agent GitHub Actions acceptance path.

### Fixed

- Stabilize the file-source filters and tables, insight success/failure metrics, Runner inventory,
  project execution configuration and compact top bar across desktop viewport widths.
- Add browser layout regression coverage for every primary product and administration route at
  multiple viewport widths, including minimum text/control sizes, boundary overflow, page overflow
  and overlapping interactive controls.

## 0.4.9 - 2026-08-14

### Added

- Add the standard Maven CoTest TestNG Adapter and embed its verified JAR into every backend image so
  Runner attempts can execute selected classes with an isolated class loader and project-level
  suite, test and environment-IP parameters.
- Add project versions and test stages, project-scoped Adapter configuration, and JDK plus dependency
  archive runtime assets supplied by upload or an integrity-pinned Runner-accessible HTTP(S) URL.
- Add resumable Runner log streaming through the existing acknowledged log-chunk protocol and an
  authenticated same-origin WebSocket relay for live attempt output in the platform.
- Add directory-based case navigation and project hierarchy management while keeping case execution
  and analysis history available from each case detail page.

### Changed

- Run Runner installation and attempt scripts with Bash, allow an administrator to force the
  openSUSE installation profile when operating-system detection is ambiguous, and execute the Agent
  from its configured working directory.
- Remove the separately published Java/TestNG Runner toolchain archives. Administrators now provide
  the exact JDK and complete test-dependency archive required by each project; the Agent verifies and
  unpacks those assets before starting the embedded Adapter.
- Reorganize the management center, operations/audit area and platform settings into route-backed
  tabs, replace the native project selector, and stabilize the case detail, audit and insights layouts
  at desktop and compact viewport widths.
- Preserve fast publication by keeping the tagged `Release` workflow independent from
  `Release checks`; only required Adapter, backend image, SBOM, manifest, signature and provenance failures
  block publication.

### Fixed

- Return resolved project hierarchy DTOs from the project structure API instead of serializing a
  pending repository promise.
- Preserve Runner log ordering and replay semantics while relaying live stdout/stderr updates, and
  keep class paths isolated between Adapter invocations with potentially conflicting dependency
  classes.

### Database migrations and compatibility

- Add PostgreSQL migration `0024_project_version_test_stage.sql` and SQLite migration
  `0025_project_version_test_stage.sql` for project versions, test stages, Adapter configuration,
  runtime assets and case hierarchy references. Existing cases are intentionally not migrated into
  the new project/version/stage hierarchy.
- Extend Runner Protocol v1 additively with Adapter execution and runtime-asset fields. Existing
  command assignments remain valid; upgraded Agents are required for CoTest Adapter assignments.

### Offline assets

- Rebuild all four immutable backend variants with the updated static amd64/arm64 Agents and embedded
  CoTest Adapter JAR, plus SPDX SBOMs, deployment bundle, signed checksums, release manifest and
  provenance for `0.4.9`. JDK and test dependency archives are intentionally project-managed inputs
  rather than Release assets.

### Known limitations

- Runtime-asset URL downloads require network reachability from the selected Runner; fully offline
  deployments should upload the JDK and dependency archives to the platform instead.
- Previously imported cases remain outside the new hierarchy by design and should be re-imported into
  an explicit project version and test stage.

## 0.4.8 - 2026-08-14

### Changed

- Remove the independent 5,000 TestNG test-class discovery ceiling while retaining bounded JAR size,
  archive entry, uncompressed byte and per-class byte limits.
- Treat cgroup v2 as an optional Runner capability: supported hosts keep full cgroup enforcement,
  while hosts without it remain schedulable with visible degraded-isolation status, rlimits,
  process-group cleanup, timeouts and workspace monitoring.
- Allow Runner Agent control-plane URLs to use HTTP for trusted internal IP connectivity and add an
  explicit installer option to run the systemd service as root. HTTPS and the dedicated non-root
  service account remain the recommended defaults.
- Normalize the retired `isolation:cgroup-v2` requirement out of persisted Runner Protocol v1
  execution specifications so assignments queued before upgrade can still be claimed.

### Fixed

- Use unambiguous accessible roles when asserting project-scoped execution environments in browser
  isolation coverage.
- Request a stable authenticated document after first-administrator bootstrap or login so upgrade
  acceptance can test older Releases that navigate with a public root document prefetched before the
  session cookie without racing the current Release's landing hand-off.
- Let manually dispatched Release checks use the selected branch's current acceptance harness while
  retaining tagged-source quality checks and immutable published assets.
- Wait for the real Agent's durable attempt state before simulating an abrupt restart in acceptance,
  preventing lease expiry from winning a harness-only race.
- Resolve the migration-integrity fixture from the packaged Web workspace so Release upgrade checks
  use the production pnpm dependency layout.

### Database migrations and compatibility

- No database migration or Runner Protocol schema-version change is required. HTTP and root mode
  weaken transport or host isolation and should be limited to dedicated trusted networks and hosts.

### Offline assets

- Rebuild all four immutable backend variants with the updated embedded amd64/arm64 Agents, both
  offline Java/TestNG Runner toolchains, SPDX SBOMs, deployment bundle, signed checksums, release
  manifest and provenance for `0.4.8`.

### Known limitations

- Without cgroup v2, CPU, memory and descendant-process counts do not have hard cgroup enforcement;
  HTTP and root Agent modes are intended only for dedicated trusted networks and hosts.

## 0.4.7 - 2026-08-14

### Changed

- Split tagged Release publication from quality and Gate E checks. The Release workflow now publishes
  as soon as all required platform assets, SBOMs, manifests, signatures and provenance are complete;
  the independent Release checks workflow preserves visible failures without blocking or withdrawing
  the published version.
- Start all four backend variants and both Runner toolchains immediately after tag validation, reuse
  per-variant BuildKit caches, avoid the signed-candidate artifact upload/download round trip and use
  parallel medium-level zstd compression for the offline Docker archives.
- Stop ordinary CI and dependency-security workflows from rerunning on tag pushes, leaving Release
  capacity to the publication and its two independent checks.
- Allow a Release workflow retry to update the same tag's existing draft or published assets
  idempotently.

### Database migrations and compatibility

- No SQLite or PostgreSQL migration, persisted configuration change or Runner Protocol change is
  included. Runtime compatibility is unchanged from `0.4.6`.

### Offline assets

- Rebuild the four immutable backend variants with embedded amd64/arm64 Agents, both offline
  Java/TestNG Runner toolchains, SPDX SBOMs, the deployment bundle, signed checksums, release manifest
  and provenance for `0.4.7`.
- Quality and Gate E failures remain visible on the tag but are post-publication signals; asset build,
  integrity, signing or manifest failures still prevent an incomplete Release from being published.

### Known limitations

- The first Release after enabling BuildKit caching has an empty cache; subsequent releases can reuse
  compatible layers. Actual duration still depends on GitHub-hosted runner and artifact service load.

## 0.4.6 - 2026-08-14

### Added

- Support bounded TestNG discovery from Java `*-sources.jar` archives, preserve per-class source
  references and show integrity-checked UTF-8 source content on the case detail page. Source-only cases
  are explicitly read-only and blocked from Agent execution; bytecode JAR imports remain executable.
- Add a visible management center with direct entries for users, roles, projects, LDAP, sessions,
  execution environments, secrets and platform configuration.
- Add real SSH protocol regression coverage for both Password and Keyboard-Interactive/PAM
  authentication, rejected credentials and Runner host prerequisite diagnostics.
- Add an account security self-service page: local users change their own password, review and
  terminate their own sessions, and accounts flagged for a mandatory password change are redirected
  until they comply; LDAP-managed users see a read-only explanation instead of a local password form.
- Generate the main navigation and management center entries from the caller's real RBAC permissions
  (`case.*`, `run.*`, `runner.*`, `environment.*`, `audit.*`, `settings.*`) instead of showing every
  entry to every signed-in user.
- Scope the case library, JAR import, file sources and case suite pages to an authorized project
  selected via URL filter, and block cross-project case/suite mixing in both UI and application
  services.
- Complete the user, project membership and role binding management UI: member listings, assigned
  role review and revocation, owner transfer, and impact confirmation for last-administrator and
  last-project-owner protections.
- Add a standalone audit page governed by `audit.read`/`audit.export` with actor, action, resource,
  result and UTC time filters, cursor pagination, per-event details and bounded CSV export.
- Complete the service account lifecycle UI: edit name, description, permissions and project scope,
  disable/restore accounts with impact hints, and mark tokens of disabled accounts as invalidated.
- Add a per-`ExecutionRun` cancel action with reason capture on the batch details page, alongside the
  existing whole-batch cancellation.
- Add an automation operations view listing all authorized schedules (enable/disable, last/next
  trigger, miss policy, related batches) and LDAP synchronization history (progress, checkpoint,
  processed/disabled counts, error summaries, retry).
- Extend the case version history with read-only snapshot details, adjacent or arbitrary version
  diffs, source information, related execution links and a pre-restore change summary.
- Add a maintained functional E2E coverage matrix (`tests/e2e/coverage-matrix.json`) validated in CI,
  and split browser coverage into isolated suites for identity/RBAC, project isolation, case suite
  lifecycle, execution recovery, management operations, platform operations and JAR import.
- Add acceptance suites that run only on GitHub Actions: real Go Runner Agent Lite/Full loop with the
  offline Java/TestNG toolchain, real offline LDAP directory flows, SSH-based Runner install and
  rollback, container executor isolation, Full dependency business recovery and release-asset offline
  upgrade acceptance.

### Changed

- Raise the new-install JAR upload default from 32 MiB to 256 MiB and present the persisted 1–256 MiB
  limit as an administrator-friendly setting instead of a raw byte count. Existing installations keep
  their configured value until an administrator changes it and restarts Web and worker.
- Gate the Release workflow's publish step behind an offline-acceptance job that verifies signatures,
  checksums, SBOMs and licenses, installs from the immutable assets without outbound network, runs the
  core business loop with the embedded Agent, and exercises upgrade, failed-migration rejection and
  rollback from the previous stable release.

### Fixed

- Exclude the deployment-specific public-statistics refresh interval from Release backup/restore
  comparisons while continuing to require every persisted business count and rate to match.
- Compare stable persisted business statistics after Release backup/restore instead of requiring the
  regenerated observation timestamp and time-window Runner presence fields to remain byte-identical.
- Route the immutable Release fixture's real Agent connection through a host-loopback TCP proxy, so
  offline container acceptance retains the Agent's HTTPS-or-loopback transport policy.
- Generate analytics export idempotency keys with the Web Crypto primitive available on remote HTTP
  origins, where the secure-context-only `crypto.randomUUID()` API is unavailable.
- Give each Release acceptance Runner registration a short-lived token derived from the fixture master
  key instead of reusing the persisted one-time bootstrap token across browser suites.
- Create the immutable Release acceptance data directory as the non-root runner before mounting it
  into the migration container, preserving the production image's non-root write-permission check.
- Pin the production PostCSS dependency chain to `nanoid` 3.3.18, the first patched 3.x release for
  `GHSA-2v37-7h3g-55p8`, and keep the version locked for offline builds and SBOM generation.
- Initialize the immutable Release acceptance fixture with a bounded aggregate login allowance so its
  deliberate account-lock checks do not exhaust the shared container-address limiter; production
  installations retain the secure default of 10 login attempts per 15-minute window.
- Reload the server-rendered root layout after login, initial administrator creation and logout so the
  authenticated home page always remains inside the same navigation shell as the other console pages.
- Keep API uploads outside the Next.js page proxy's 10 MiB request-body limit, bound both declared and
  chunked multipart bodies at the configured JAR limit, return HTTP 413 for oversized uploads and map
  malformed or invalid JAR input to stable client errors instead of 500 responses.
- Support Runner hosts whose OpenSSH/PAM password flow is exposed through Keyboard-Interactive rather
  than the legacy password method, and allow host probing before the Agent control-plane URL is set.
- Distinguish SSH authentication, DNS, refused connection, timeout and handshake failures, and report
  missing systemd, cgroup v2 or sudo prerequisites with actionable messages.

### Database migrations and compatibility

- SQLite migration `0024` and PostgreSQL migration `0023` backfill every immutable `CaseVersion` with
  its owning source, add the required source foreign key and index, and prevent deletion of a source
  still referenced by version history.
- Persisted platform configuration schema v1 and Runner Protocol v1 remain unchanged. Control plane
  `0.4.x` accepts protocol-compatible `0.3.x` Agents subject to capability checks, although upgrading
  to the Agent embedded in the control-plane image is recommended.
- Existing JAR upload limits are preserved during upgrade; the 256 MiB default applies only to new
  installations until an administrator explicitly changes and restarts an existing deployment.

### Offline assets

- Rebuild the four immutable backend variants with embedded amd64/arm64 Agents, both offline
  Java/TestNG Runner toolchains, SPDX SBOMs, the deployment bundle, signed checksums, release manifest
  and provenance for `0.4.6`.
- No new runtime CDN, telemetry service or automatically downloaded dependency is introduced.
- The signed `v0.4.0` through `v0.4.5` candidates did not pass Gate E and were not published;
  `v0.4.6` rebuilds the full immutable asset set from the corrected acceptance revision.

### Known limitations

- The process executor remains a constrained process boundary rather than a complete sandbox; the
  optional container executor requires a locally installed OCI runtime and pinned policy.
- Direct terminal sessions require load-balancer affinity to the Web replica that issued the ticket.
- The management UI targets desktop screens. Browser/driver toolchains remain administrator-supplied
  offline resources and are never downloaded at runtime.
- Database downgrade is unsupported after the new case-version source migrations; rollback requires
  restoring the matching pre-upgrade database and object backup with the previous immutable image.

## 0.3.4 - 2026-08-12

### Fixed

- Preserve administrator bootstrap and login sessions when the production server is accessed directly
  over HTTP by deriving the session cookie's `Secure` attribute from the external request protocol;
  HTTPS reverse-proxy requests remain protected with secure cookies.
- Keep form focus indication on the active input, select or text area instead of drawing a second large
  outline around the entire label container.

### Database migrations and compatibility

- No SQLite or PostgreSQL migration is added by this release.
- Persisted platform configuration schema v1, Runner Protocol v1 and embedded Agent compatibility are
  unchanged from `0.3.3`; the existing `0.3.x` compatibility matrix remains authoritative.

### Offline assets

- Rebuild the four immutable backend variants and their embedded amd64/arm64 Agent resources, SPDX
  SBOMs, deployment bundle, signed checksums, release manifest and provenance for `0.3.4`.

### Known limitations

- The process executor remains a constrained process boundary rather than a complete sandbox; the
  optional container executor still requires a locally installed OCI runtime and pinned policy.
- Direct terminal sessions still require load-balancer affinity to the Web replica that issued the
  ticket.
- The management UI targets desktop screens; JDK/TestNG/browser toolchains must still be assembled
  from approved offline artifacts and are never downloaded at runtime.

## 0.3.3 - 2026-08-12

### Added

- Added an offline-bundled AutoForge application icon without introducing a remote asset dependency.
- Added automated visual consistency coverage across the public dashboard, setup, case, task, object,
  execution, Runner and settings workflows, including desktop overflow, zoom, readable text and control
  target checks.

### Changed

- Unified page surfaces, typography, spacing, controls, settings navigation, execution-environment and
  secret-management workspaces through shared semantic visual tokens and layout styles.
- Raised explicit interface text to a 12 px minimum, increased compact action targets to at least 32 px
  and refined the first-start headline and desktop scaling for clearer hierarchy.

### Fixed

- Replaced legacy button and color-token references that could render inconsistent forbidden, import and
  run-history controls.
- Stabilized the browser layout audit after zoom restoration and kept the authenticated session available
  until the secondary Full replica readiness check completes.

### Database migrations and compatibility

- No SQLite or PostgreSQL migration is added by this release.
- Persisted platform configuration schema v1, Runner Protocol v1 and embedded Agent compatibility are
  unchanged from `0.3.2`; the existing `0.3.x` compatibility matrix remains authoritative.

### Offline assets

- Rebuild the four immutable backend variants and their embedded amd64/arm64 Agent resources, SPDX
  SBOMs, deployment bundle, signed checksums, release manifest and provenance for `0.3.3`.

### Known limitations

- The process executor remains a constrained process boundary rather than a complete sandbox; the
  optional container executor still requires a locally installed OCI runtime and pinned policy.
- Direct terminal sessions still require load-balancer affinity to the Web replica that issued the
  ticket.
- The management UI targets desktop screens; JDK/TestNG/browser toolchains must still be assembled
  from approved offline artifacts and are never downloaded at runtime.

## 0.3.2 - 2026-08-11

### Changed

- Redesigned the first-start experience as a two-step deployment and administrator setup flow with
  clearer Lite/Full guidance, offline/security context and desktop layout.
- Routed all Web buttons, text/number/file/choice inputs, text areas and select controls through shared
  UI components, including consistent focus, disabled and scrollbar styling.

### Fixed

- Preserve and display field-specific validation details during platform and administrator bootstrap
  instead of reducing invalid usernames, passwords, tokens or URLs to a generic request error.
- Validate bootstrap forms before sending requests and document the accepted username and credential
  formats next to their fields.

### Database migrations and compatibility

- No SQLite or PostgreSQL migration is added by this release.
- Persisted platform configuration schema v1, Runner Protocol v1 and embedded Agent compatibility are
  unchanged from `0.3.1`.

### Offline assets

- Rebuild the four immutable backend variants and their embedded amd64/arm64 Agent resources, SPDX
  SBOMs, deployment bundle, signed checksums, release manifest and provenance for `0.3.2`.

### Known limitations

- The process executor remains a constrained process boundary rather than a complete sandbox; the
  optional container executor still requires a locally installed OCI runtime and pinned policy.
- Direct terminal sessions still require load-balancer affinity to the Web replica that issued the
  ticket.
- The management UI targets desktop screens; JDK/TestNG/browser toolchains must still be assembled
  from approved offline artifacts and are never downloaded at runtime.

## 0.3.1 - 2026-08-11

### Added

- Persisted first-start and administrator-managed platform configuration; application settings are no
  longer supplied through environment variables.
- Public live statistics dashboard and desktop-responsive management pages.
- Internal Linux amd64/arm64 Runner Agent resources with SSH installation for Ubuntu and openSUSE.
- Service accounts/API tokens, scheduled suites, notifications, global search, retention operations,
  analytics and asynchronous bounded analytics exports.
- Background JAR imports with progress, cancellation, diagnostics and retry.
- Optional constrained OCI container executor and Agent liveness/readiness commands.
- Offline backup, restore, migration preflight and Runner toolchain packaging helpers.

### Changed

- GitHub Releases publish four backend image variants with embedded Agent resources and no standalone
  Agent binaries.
- JAR and execution-artifact object keys are explicitly scoped by project.

### Fixed

- Package the production workspace dependencies required by the custom Next.js server and verify the
  database migration entry point inside every release image.

### Database migrations

- SQLite `0015`–`0022`; PostgreSQL `0014`–`0021` add product completion, Runner credential lifecycle,
  execution policy, source comparison metadata, schedule claims, LDAP sync claims, JAR import jobs and
  analytics export jobs.

### Known limitations

- The process executor is not a complete sandbox. The optional container executor depends on a locally
  installed OCI runtime and an administrator-pinned image/seccomp profile.
- Direct terminal sessions require load-balancer affinity to the Web replica that issued the ticket.
- Browser/mobile layouts are not supported; the UI targets desktop screens and narrow desktop windows.
- JDK/TestNG/browser toolchains must be assembled from approved offline artifacts; AutoForge and Agent
  never download them at runtime.
