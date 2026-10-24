# 执行期间常用操作的阻塞复查

2026-10-10 在 1.19.9 的诊断读取隔离基础上，沿执行页面、公开日志及控制协议复查常用操作。目标是让查看信息、搜索和导出失败局限于当前请求，避免拖延有效租约的续期与完成确认。本次没有连接用户的局域网或生产数据库。

## 发现与修复

- 异常原因聚合、未缓存的轮次筛选/排序、执行记录分页及旧版整批详情仍可能在 Lite Web 主线程执行同步 SQL。返回行数有限不能限制 SQL 扫描量。上述读取连同公开日志的快照及轮次/手动重跑历史，改由既有只读诊断进程执行；只允许明确列出的读取方法，参数在 IPC 边界再次校验。单批次权限校验所需的轻量元数据点查仍保留本地执行。
- 执行记录列表原来会选取不需要的完整 Adapter 运行快照；公开日志历史也会读取完整 TestNG 结果。现在查询仅投影所需字段，手动重跑历史使用两次有界批量查询，不再逐批加载执行用例、动态字段及 TestNG 报告。
- 用例结果/失败分析 Excel 原来先读取整批 runs/attempts，再建立全部链接并构造内存工作簿。现在使用最多 200 条候选记录的游标页，只读取导出字段；每页沿用现有结果分类、逻辑轮次和最终 attempt 选择规则，再批量生成链接和读取分析信息。Excel 按行提交，每 25 行和每页之间让出事件循环，处理背压与下载取消，不保留整批数据或全量共享字符串表。保留表头、列宽规则、状态样式、链接及平台时区。
- 导出游标同时包含用例名称、ID 和逻辑轮次；新增批次/类名/显示名/ID 索引及独立的 run 游标前缀，让数据库在关联 attempts 前定位成员范围，避免每页重新扫描之前的全部结果。数据库自身的文本排序规则参与游标顺序；运行中的导出逐页读取已持久化结果，不引入跨整个下载的长读事务。
- 完成上报的日志确认水位原来与查看/搜索日志共用读取队列，可能在 Full 完成事务内等待一个慢搜索。水位点查现在与同 attempt 的追加/确认写入共用顺序通道，脱离查看队列。只读日志通道改用可终止子进程，五秒超时能终止原生 SQLite SQL；不依赖不能可靠打断原生调用的 Worker terminate。
- Lite 单用例取消原来仍在 Web 主线程执行事务，现交给已有执行控制工作线程，并纳入后台退让计数。取消、完成与超时竞争继续使用原版本条件和权威状态机。

## 操作链路

| 操作                                | 读取或执行路径                                | 失败边界及验证                                                         |
| ----------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------- |
| 执行记录列表、详情摘要              | 轻量权限点查、隔离的摘要/分页、既有统计读模型 | 不读取完整运行快照；项目过滤、游标与历史仓储回归                       |
| 概览、轮次统计                      | 既有后台统计快照                              | 等待/更新状态沿用原交互；并发浏览器读取                                |
| 轮次切换、状态/用例筛选、排序和翻页 | 隔离 SQL 或已发布快照的有界明细               | 真实 SQLite/PostgreSQL 慢 SQL、续租及恢复测试                          |
| 异常原因悬浮/弹框                   | 隔离的异常查询；鉴权仍在入口                  | 保留终态原因、历史异常及无 attempt 的排队超时口径                      |
| 异常原因 Excel                      | 既有分页流式 Excel，SQL 转入隔离读取          | 全页导出、权限、时区与下载失败重试回归                                 |
| 公开日志首次打开、轮次历史          | 有界正文预览、轻量历史、独立只读进程          | 历史查询不读取整批或 TestNG 正文；执行中打开已完成用例                 |
| 日志搜索、正文翻页                  | 日志读取进程                                  | 原 16 请求/通道、五秒期限；真实原生慢 SQL 超时后释放连接并恢复         |
| 总体/单执行机调度日志、资源监控     | 既有只读诊断进程                              | 搜索、翻页、关闭、错误重试及浅色/深色页面检查                          |
| 用例结果/分析 Excel                 | 隔离的 200 条 SQL 页、分批链接、流式工作簿    | 双数据库 10 万行完整翻页；单元格、样式、时区、链接及已提交分析信息回归 |
| attempt 时间线、产物读取            | 现有按 attempt 的有界查询、受控对象流         | 代码路径复核；不把整批结果或完整对象读入初始页面                       |
| 执行机终端                          | 现有鉴权与直连终端                            | 终端挂载、关闭和重新打开回归；终端不参与 lease 正确性                  |
| 取消用例、终止批次、领取/续租/完成  | 既有执行控制通道和权威事务                    | 单用例取消卸载；取消/完成竞争、幂等与四阶段恢复回归                    |

诊断读取继续只容纳两个在途/排队请求，提交起五秒超时；SQLite 只读、25ms 锁等待，PostgreSQL 单连接只读、四秒语句期限和 25ms 锁等待。超时或满载返回可重试错误，重建前先等待旧进程退出。SQL 驱动嵌套 cause 中的 PostgreSQL 超时同样识别为繁忙。日志写事务不会被只读超时杀死。响应已经开始的 Excel 若后续读取失败，会中止下载而非把截断文件当作完整导出。

## 升级与离线包

新增 SQLite `0078_execution_export_order_index.sql`、PostgreSQL `0076_execution_export_order_index.sql`，仅创建非唯一读取索引，不修改业务行。新建库、从 1.19.9 的 schema 升级、失败事务回滚及保留历史已经测试。升级前按现有流程备份、排空执行；大库需要预留索引创建时间。若索引创建失败，启动迁移事务回滚，排除磁盘/数据库错误后重启重试；不要修改已经记录的迁移文件或手动伪造迁移水位。

后端新增内置 `apps/web/dist-server/server/attempt-log-process.js` 并加入离线包校验。只读进程复用已有资源预算和镜像内 Node，没有新增生产依赖、服务、环境变量或持久配置。需更新并重启主平台；Runner Protocol、Agent、租约时长和真实过期判定没有改变。

## 验证记录与边界

定向回归使用临时 Lite 生产服务、本地 Chromium，以及 UTF-8 临时 PostgreSQL。SQLite/PostgreSQL 同组测试验证导出口径、重复名称、物理重调度与逻辑轮次、未执行/取消/异常结果、十万条游标完整性、读取投影和迁移恢复。原生慢 SQL 使用十亿行递归/集合视图，测试独立读取超时期间 HTTP 续租和日志确认仍能完成，恢复后可以重新读取。

相关命令包括：

```sh
pnpm test
pnpm format:check
pnpm lint
pnpm typecheck
pnpm --filter @autoforge/web build
pnpm --filter @autoforge/worker build
pnpm test:e2e:matrix
# 数据库测试设置一次性 AUTOFORGE_TEST_POSTGRES_URL，分别运行：
pnpm exec vitest run packages/db/test/run-batch-export-page.integration.test.ts packages/db/test/diagnostic-read-database.integration.test.ts
pnpm exec vitest run packages/db/test/attempt-log-snapshot.integration.test.ts packages/db/test/sqlite-management.integration.test.ts packages/db/test/postgres-platform.integration.test.ts packages/db/test/execution-exceptions.integration.test.ts
pnpm exec vitest run apps/web/server/runner-diagnostic-reads.integration.test.ts packages/db/test/scheduling-events.integration.test.ts packages/db/test/runner-resource-samples.integration.test.ts apps/web/server/log-io-pool.integration.test.ts
```

浏览器覆盖 500 个协议槽位，持续执行跨越原始 45 秒租约期限；执行期间读取列表、轮次、异常原因、导出和执行机浮窗。另回归异常原因 Excel、异常分类、权威恢复/取消、终端重开、日志搜索/关闭/重试及两种结果导出。XLSX 下载检查读取实际单元格，不依赖 sharedStrings 或 inline 字符串的编码细节。

调度日志和资源监控实际截图覆盖 1024×768、1536×960、浅色与深色，已经逐张检查；弹窗、表格、图表和按钮没有新增错位、变形或越界。导出弹框同样检查这两个视口和深色模式，另保留 1024×560 的短桌面错误状态检查。

最终构建的 500 槽位回归先完成一个用例，在其余 499 个用例持续执行/续租期间首次打开它的公开日志并导出结果，然后完成其余全部用例。1,996 次续租均为 200，服务端 P95 为 36ms、最大 88ms；500 次协议完成均成功，批次通过 500、失败零。首次公开日志请求为 780ms；416 次列表读取探针的客户端 P95 为 166.35ms、最大 295.66ms。以上是当前测试环境的观测结果，不承诺其他硬件和生产数据库具有相同延迟。进程隔离不能消除共享 CPU、磁盘和数据库容量限制。

最终检查结果：

- `pnpm test`：221 个文件、1,304 项 TypeScript 测试、Go Agent 测试和 63 项脚本测试通过。
- 三组 SQLite/PostgreSQL 集成回归分别为 10、54、40 项，共 104 项通过，没有跳过 Full 场景；覆盖十万行导出、读取投影、索引升级/回滚、既有管理/执行语义、原生 SQL 超时及恢复。对应新契约已加入 Full 适配器与分布式契约门禁。
- 受影响的九项独立 Playwright 场景通过；最终构建下并发执行与带已完成分析信息的 Excel 下载两项通过。发布整理时完整失败分析文件五项检查通过，涵盖完整工作台、证据提交、导出、长文本、弹窗刷新和日期宽度。
- 跨轮次完整流程一项通过；JAR 导入完整流程在独立 Lite 数据目录下一项通过，覆盖结果及分析 Excel 的实际下载、链接和原样式。初次复用压力测试数据时，JAR 场景因大目录默认收起而被原先的小目录展开断言阻止；独立数据目录恢复该场景的初始条件，未修改或跳过原断言，没有增加重试。
- `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、Web 生产构建、18 行 E2E 矩阵校验及 `git diff --check` 通过。最后的工作簿类型收窄另通过 Web TypeScript 检查，没有更改运行时逻辑。
- 实际查看最终 10 张执行期间截图（调度/资源监控八张、已完成用例公开日志两张）及导出弹框六张截图；上述桌面尺寸、浅色/深色和短桌面状态没有新增错位、变形或越界。

发布整理中复现了既有完整工作台的卡片高度断言：在 1024px 桌面宽度下，完整认领时间超过原列宽，换成两行后卡片从 89px 增至 105px。时间列现按内容保留宽度，不改变字号或移除完整日期。新增固定 `2026/12/31 23:59:59` 的回归，验证单行、无溢出及原卡片高度；完整失败分析文件五项检查全部通过。实际查看 1024×768、1536×960 深浅色四张日期宽度截图，标题、时间和操作按钮没有新增错位、变形或越界。

Full 整体中间件部署、真实 Java Agent 执行及新离线包阻断出网验收本地未运行，由现有发布验收继续覆盖。

## 2026-10-15：日志页手动重跑提交隔离

用户报告从失败的中文 DDT 用例公开日志点击“执行此用例”后一直停留在“正在提交…”，其他页面也失去响应。检查发现既有批次创建代理只卸载普通任务和直接 DDT 执行，`rerunCaseFromAttempt` 仍绑定本地服务，其快照读取、SQLite 写入及首次调度会在 Web 事件循环中执行。重跑快照还通过 `getSummary` 聚合原批次计数，虽然只选择一个用例，准备工作仍受整个批次规模影响。该链路不按 CaseID 是否包含中文分支，中文是必须保留并验证的输入条件，不作为已证实的编码根因。

Lite/Full 现在通过同一个 `rerun-case-from-attempt` 内部任务在已有调度工作线程执行整个重跑用例，入口仍先检查同源、登录、`log.read` 与 `run.retry` 权限。只传执行尝试 ID 和已认证拉起人，工作线程重新校验输入并读取权威快照；不把原批次成员或 DDT 内容传回 Web。批次元数据替代汇总计数，保留选中用例、Adapter 环境轮换、当前项目版本依赖、原始执行锚点和既有终态校验。该改动不涉及 Runner 协议、数据库迁移或新配置。

新增工作线程代理及元数据回归在修复前有三项失败。真实 SQLite 集成测试持有短期写锁，中文 DDT 重跑等待期间 HTTP 探测可响应；释放后创建成功、CaseID 和执行类不变、原执行租约续期成功。应用、权限、工作线程及 SQLite/PostgreSQL 快照/调度回归共九个文件、145 项通过；数据库测试连接独立临时 PostgreSQL 实例，结束后关闭。本次未访问用户局域网或生产数据。

生产构建下，失败中文 DDT 日志重跑和从其手动重跑日志继续重跑通过；Runner Protocol 实际领取的 CaseID 与执行类保持原值，原批次失败计数不被后续手动成功覆盖。另回归 501 用例活动批次中已完成用例及其手动执行的重跑，保持来源任务可继续执行。两场景各通过一次最终验收；新增中文场景起初把生命周期 `status` 当作用例结果，并尝试从元数据接口读取计数，末尾断言失败。按既有规则改用单用例批次详情中的失败/成功计数后通过，未修改生产结果判定。

中文场景最新两次重跑提交耗时 187ms、105ms，同期健康检查耗时 9ms、5ms。它们是单核限额下的本机样本，不代表生产性能上限。已实际查看 1024×768、1536×960 截图，中文标题、执行按钮、三条执行历史、当前记录标记及两侧滚动边界正常，无新增横向溢出或页面变形。浏览器使用协议模拟执行机，没有执行真实 Java 用例、连接用户部署或启动 Full 整体中间件；Runner/Adapter 编码未改动。

实际验证命令：

```sh
pnpm exec vitest run packages/db/test/attempt-log-snapshot.integration.test.ts packages/db/test/scheduling-refill.integration.test.ts packages/db/test/manual-execution-context.integration.test.ts packages/application/test/rerun-run-batches.test.ts packages/application/test/single-ddt-run.test.ts apps/web/src/lib/work-dispatch.test.ts apps/web/src/lib/authorization-paths.test.ts apps/web/server/worker-pool.test.ts apps/web/server/case-log-rerun.integration.test.ts --maxWorkers=1 --no-file-parallelism
pnpm format:check
pnpm exec eslint apps/web/src/lib/work-dispatch.ts tests/e2e/ddt-management.spec.ts --max-warnings=0
pnpm --filter @autoforge/web typecheck
pnpm exec tsc --noEmit -p tsconfig.tests.json
pnpm test:e2e:matrix
pnpm --filter @autoforge/web build
pnpm exec playwright test tests/e2e/ddt-management.spec.ts tests/e2e/single-case-run.spec.ts --grep 'public logs rerun failed Chinese DDT cases|log detail reruns a completed case' --workers=1
pnpm exec playwright test tests/e2e/ddt-management.spec.ts --grep 'public logs rerun failed Chinese DDT cases' --workers=1
git diff --check
```

数据库回归显式设置本地 `AUTOFORGE_TEST_POSTGRES_URL`，因此两种适配器均实际运行。构建、数据库和浏览器串行执行并设定 CPU/内存限额；测试平台和临时 PostgreSQL 均已关闭。

### 重跑提交响应与实时日志目标的补充复核

v1.19.22 后再次逐步检查请求链路，发现重跑创建已隔离，但返回实时日志入口的 `getCaseLogRerunLogTarget` 仍调用完整批次 `get`。即使手动批次仅有一个用例，也会加载运行快照和详细 TestNG 报告；Lite 的 attempt 关联子查询从 `run_attempts` 起扫，查询计划可出现 `SCAN run_attempts`，使请求耗时受全库执行历史规模影响。因此已有冷启动和负载测试通过不足以证明该响应阶段没有遗留风险；本次未将其认定为已复现的用户现场根因。

现改用双数据库专用读取端口，以手动批次 ID 和类型定位，按批次关联执行用例及其 attempt，只投影项目、批次状态、最新 attempt ID/状态并限制一条结果。不读取快照、报告、汇总计数或状态历史；不存在与普通批次返回空，由应用层沿用原错误；尚未分配返回 `attempt: null`，相同创建时间继续以 ID 决定最新记录。权限入口、响应结构和轮询机制不变。

新增应用回归明确拒绝读取完整详情；共享 SQLite/PostgreSQL 回归覆盖缺失、普通批次、待调度、中文用例和最新 attempt，检查只有一次定向查询且不投影 JSON。SQLite 额外检查真实生成 SQL 的查询计划使用 attempt 索引搜索而非全表扫描。修复前本地三项回归失败。无数据库迁移、配置、依赖或 Runner 变更，验证记录与现场边界在本次交付说明中列出。

本地八个文件共 87 项回归通过，两种数据库均实际运行；包括冷/热启动重跑、隔离的慢调度日志/异常/用例分页 SQL、HTTP 与有效租约续期及恢复。单独增加的 SQLite 查询计划断言通过，其余测试由筛选跳过，不把这次筛选记录当作双数据库完整重跑。新生产构建下，两项 Playwright 在同一服务中通过，覆盖中文 DDT 连续重跑和 501 用例活动批次；四次重跑提交耗时 142ms、80ms、68ms、68ms，中文场景同期健康检查为 15ms、6ms。已实际查看 1024×768、1536×960 截图，标题、按钮、历史选中与滚动区域正常。

实际执行以下检查，所有重负载任务串行限制在一个 CPU；临时 PostgreSQL 和浏览器测试平台结束后关闭。未访问用户现场、重新运行 Full 完整部署或真实 Java Agent，也未发布本次补强，不能据此保证任何生产负载下永不出现平台阻塞。

```sh
pnpm --filter @autoforge/web build:work-thread
pnpm exec vitest run packages/db/test/attempt-log-snapshot.integration.test.ts packages/db/test/manual-execution-context.integration.test.ts packages/application/test/rerun-run-batches.test.ts apps/web/server/case-log-rerun.integration.test.ts apps/web/server/runner-diagnostic-reads.integration.test.ts apps/web/server/worker-pool.test.ts apps/web/src/lib/work-dispatch.test.ts apps/web/src/lib/authorization-paths.test.ts --maxWorkers=1 --no-file-parallelism
pnpm exec vitest run packages/db/test/attempt-log-snapshot.integration.test.ts --testNamePattern='reads a manual log target' --maxWorkers=1 --no-file-parallelism
pnpm format:check
pnpm exec eslint packages/application/src/ports.ts packages/application/src/schedule-run-batches.ts packages/application/test/rerun-run-batches.test.ts packages/db/src/sqlite-run-batch.ts packages/db/src/postgres-run-batch.ts packages/db/test/attempt-log-snapshot.integration.test.ts --max-warnings=0
pnpm --workspace-concurrency=1 -r --if-present typecheck
pnpm exec tsc --noEmit -p tsconfig.tests.json
pnpm --filter @autoforge/web build
pnpm exec playwright test tests/e2e/ddt-management.spec.ts tests/e2e/single-case-run.spec.ts --grep 'public logs rerun failed Chinese DDT cases|log detail reruns a completed case' --workers=1
git diff --check
```

## 2026-10-21：DDT 管理分页与全部导出

DDT 管理的 GET/POST 列表原来直接调用本地仓储，复杂字段筛选在 Lite 下仍可能同步占用 Web 事件循环；“加载更多”也会持续挂载所有已加载行，没有请求超时或取消。独立十万条普通摘要探针约 1 ms，没有复现现场的慢请求，因此不能把现场卡死直接归结为缺索引；本次没有访问用户局域网或生产数据。

列表和新增导出分页现在通过既有可终止只读进程执行，IPC 再次校验完整范围和窗口参数，不接纳写方法。进程沿用最多两个待处理请求、5 秒终止期限和 Full 4 秒 SQL 期限，不回退 Web 同步执行。分页先选定有界摘要，再一次关联当前页的 SR、分类、执行类。浏览器增加单请求准入、15 秒超时、作用域取消、旧响应隔离、重复游标保护；超过 120 条时只挂载可见窗口，保留摘要、勾选、键盘切换和原有导航外观。

“导出全部用例”按当前项目、版本、测试阶段导出全部活动用例，不受当前勾选、筛选或已加载数量影响；原有当前范围和勾选导出保持各自范围语义。数据库每页最多 64 条、目标正文预算 2 MiB，首条大用例仍完整前进。导出以立即取消目录链接的私有临时文件暂存一次读取到的数据，跨页共享列别名规划，再从磁盘逐行提交 Excel；行数和原始值不因分页或缺失旅程步骤丢失。处理数据及写行时定期让出事件循环，完成后才发送下载头，失败和取消关闭文件；GET 下载与 HEAD 只取头部都覆盖句柄关闭。没有新迁移、配置、生产依赖、Runner 或 Adapter 变更。

真实 SQLite/PostgreSQL 的对抗测试让 DDT 列表和导出 SQL 无法在预算内结束，同时验证 HTTP 与有效执行租约续期。两个模式、两类 DDT 读取的 40 次 HTTP 续租探测全部成功，单次均在 1.5 秒测试界限内；慢查询按期限失败，恢复原表后读取及续租继续成功。原有调度日志、异常聚合和执行列表的隔离场景一并通过。此证据验证请求隔离与恢复，不是现场延迟或整个平台容量上限承诺。

生产 Lite 的四个 Playwright 场景分别验证 SR 分类筛选并加入任务、分栏编辑/导航、完整导出并重新导入，以及新增的失败重试/连续加载/完整导出/取消。新增场景从 60 条加载到 190 条后挂载行数小于 50，键盘切换有效；筛选并勾选一条后仍逐行核对导出的全部 190 条。首次新增验收因全局 alert 与路由辅助提示重名而失败，后限定到工作台；还发现 Ant Design 加载图标影响按钮的无障碍名称，补充明确按钮名称后复验通过。准备状态的文字与取消按钮共处一个状态区域，验收按状态区域定位，保留取消和按钮恢复断言，不增加测试重试。

已实际查看 1024×768、1536×960 的浅色/深色、失败提示及准备/取消截图，没有新增横向溢出、按钮挤压或分栏变形。190 条真实下载通过原解析器逐行回读、ZIP CRC、所有 XML 与关系部件解析及官方 ECMA 基础格式 schema 校验，并用 LibreOffice 打开、渲染审查。没有使用 Microsoft Excel 桌面客户端验收。详细命令和日志保存在本地 `/var/tmp/autoforge-ddt-management-20261021/`；本轮未运行 Full 整套中间件部署、真实 Java Runner 或新离线发布包验收。

## 2026-10-23：已领取后首条日志的等待

用户补充 Lite 中所有执行入口首次和后续均约等待十秒，期间页面已经显示“执行中”。领取成功后 Runner 仍需要下载和校验输入、准备批次共享目录、解压项目 JDK/依赖，再创建进程；运行态不能证明这些阶段已经完成。本地未访问现场依赖包或执行机，没有复现并确认这十秒的完整来源。

串行限制一个 CPU 的真实准备路径探针使用 207 MiB JDK 21 压缩包、完整 TestNG 7.11.0 依赖和最小用例，通过 Runner 原有输入下载、校验、共享目录准备函数后实际启动 Java。首次准备约 4.39 秒，同批次继续执行约 0.20 秒，新批次即使压缩包已缓存仍约 4.02/3.49 秒；准备后 Java 首条输出约 63–78 ms。独立 JVM 探针三次约 63–88 ms。以上只说明该夹具中新批次重复解压有明显成本，不把本地测量等同于现场根因，也不代表完整浏览器到远程 Agent 的耗时。

Agent 诊断新增 `workspace_ready` 与 `process_created` 阶段的 `elapsedMs`，沿用已有 spool、脱敏、上传与确认水位，不新增数据库字段或协议字段。前者记录输入与运行时就绪，后者记录进程创建及身份持久化；进程创建仍可能早于资源握手和 JVM/用例初始化。阶段日志错误保留 cause，启动路径不会在记录失败后假装成功。旧 Runner、Lite/Full 和原有执行终态继续兼容。这些诊断用于下一次实际执行区分耗时，不作为已消除十秒等待的承诺。

阶段回归先在原实现因缺少 `workspace_ready` 失败；修改后 Go 全量测试通过，覆盖阶段日志、输入准备、完成上报、水位、批次清理及上一轮首条唤醒、缓存损坏恢复。测试服务按实际上传块确认 Agent 水位，不再将诊断流永远固定在序号零。本轮不修改页面样式，上一轮两项完整 Lite Playwright 和桌面截图仍作为页面验证；未重新运行完整 Full 部署或完整离线镜像验收。探针、失败记录和验证命令保存于 `/var/tmp/autoforge-startup-20261023/`。

## 2026-10-23：公开日志跳转用例历史

公开日志操作区新增“用例详情”，以原生新标签页链接打开详情，保留当前日志及轮次。普通用例定位到平台用例 ID；DDT 定位到当前 DDT 记录自身的 CaseID 和项目、版本、阶段，不跳到关联测试类。DDT 独立详情页复用现有执行历史、分析结论和统计历史组件，沿用已完成记录过滤、服务端有界分页与日志权限。业务地址、旧日志令牌地址和旧批次日志地址共用布局与权限决策，手动重跑继续指向同一个用例。

公开授权仍只允许原日志家族的读取，不扩大为全部用例历史的匿名授权。匿名访客通过日志页本页登录框恢复 session，登录后仍停留在原日志地址，再新开详情；详情独立要求目标项目的 `case.read` 权限，与日志读取、重跑和停止权限分别判定。用例不存在、缺少完整 DDT 范围或强制改密时不会绕过原有权限边界。

Lite/Full 在原来的单行日志快照查询中补充用例标识，DDT 通过主键关联取得 CaseID 和完整范围，不读取 DDT 正文、全部批次成员、计数聚合或重跑准备数据。SQLite 查询计划确认没有扫描执行成员或 DDT 表；DDT 记录删除后仍保留原执行事实及公开日志。没有数据库迁移、持久配置、生产依赖或 Runner/Adapter 协议变更。

第一次浏览器验收发现，新 DDT 详情页的单段路径参数仍保留中文 URI 编码，而同一用例的 workspace API 可正常读取。经本地生产构建定向核验后，改用 `/cases/ddt?caseId=...&projectId=...&projectVersionId=...&testStageId=...`，统一由查询参数解析，避免手动重复解码损坏包含 `%`、`/`、`?`、`&` 等字符的 CaseID。随后重新构建并完成中文 DDT、连续手动重跑及原地登录回归。

本轮 45 项应用、权限、导航与 Ant Design 检查，以及 16 项真实 SQLite/PostgreSQL 集成测试通过。生产 Lite 下两条完整 Playwright 流程通过，覆盖 501 用例活动批次中的普通用例、中文 DDT、手动重跑、旧令牌链接、鼠标和键盘新标签页、匿名会话失败重试、登录弹框取消和登录后保持地址。已实际查看 1024×768、1536×960 的浅色/深色截图，按钮层级、对齐、表格和滚动边界正常，没有新增页面变形。受影响文件 Prettier、ESLint、Web/服务端/工作线程与测试类型检查、18 行 E2E 矩阵和 Web 生产构建通过。

主要验证命令：

```sh
pnpm exec vitest run packages/application/test/attempt-log-shares.test.ts apps/web/src/lib/shared-attempt-log.test.ts apps/web/src/lib/shared-attempt-log-access.test.ts apps/web/src/components/ui-usage.test.ts --maxWorkers=1 --no-file-parallelism
pnpm exec vitest run packages/db/test/attempt-log-snapshot.integration.test.ts --maxWorkers=1 --no-file-parallelism
pnpm --filter @autoforge/web typecheck
pnpm exec tsc --noEmit -p tsconfig.tests.json
pnpm test:e2e:matrix
pnpm --filter @autoforge/web build
pnpm exec playwright test tests/e2e/single-case-run.spec.ts tests/e2e/ddt-management.spec.ts --grep 'log detail reruns a completed case from an active 501-case batch|public logs rerun failed Chinese DDT cases' --workers=1
git diff --check
```

数据库测试显式连接一次性 PostgreSQL，两个适配器均实际执行；浏览器使用 Lite 和 Runner Protocol 夹具。因变更限于导航、权限与单行读取投影，本轮没有重跑 Full 整套基础设施、真实 Java Runner 或完整离线发布验收。所有重负载任务串行限制一个 CPU、4 GiB 内存；日志、截图、首次失败与复验记录保存在本地 `/var/tmp/autoforge-log-case-detail-20261023/`。

## 2026-10-24：执行记录页双向分页

主执行记录页的「任务执行」「单用例执行」原来仅提供「查看更早记录」，现在复用共享游标分页栏，提供当前页、本页记录数、上一页、下一页和返回第一页。原有筛选表单、每页 10/50/100/500 条、表格列宽与操作按钮保持原规则；应用筛选或切换执行类型会回到第一页。

页位置及最近五个回退游标保存在 URL，刷新后保留当前位置，支持浏览器前进/后退；更早位置可以返回第一页重新导航。切换项目、版本或测试阶段会清除游标、页码及回退历史，避免跨范围复用位置。最后一页禁用下一页，第一页禁用上一页；空结果仍显示清晰的页状态。

仍使用既有服务端游标分页和只读隔离查询，不追加已浏览页面的 DOM，不新增全量历史读取、OFFSET 或总记录数扫描；Lite/Full 共用页面与分页行为，无数据库迁移、配置、依赖或 Runner 协议变化。

本次验证：31 项 Vitest 回归通过（筛选、列宽、Ant Design 规范及表格），生产 Lite 的任务执行分页、单用例执行分页、顶栏项目切换三条 Playwright 场景通过。分页场景各使用 23 条历史记录，验证 10/10/3 的分段、不重复不遗漏、上一页/第一页、刷新保留、筛选与页大小重置、空结果和任务/单用例隔离；历史由夹具构造，不是 Runner 执行验收。

实际查看两类列表在 1024×768、1536×960 浅色/深色下的分页栏和表格截图，新增分页未造成变形或页面横向溢出。初次检查将固定顶栏对表格横向固定列的正常遮挡判为冲突；保留完整性检查，在无遮挡的页首执行，同时单独截图审查页尾分页，不放宽检查规则。截图在布局稳定后滚动定位，并断言分页栏完整进入视口。

实际执行 `pnpm exec vitest run`（`run-batch-filter.test.ts`、`execution-record-columns.test.ts`、`ui-usage.test.ts`、`ui/table.test.tsx`，`--maxWorkers=1 --no-file-parallelism`）、受影响文件 `pnpm exec eslint ... --max-warnings=0`、`pnpm exec tsc --noEmit -p tsconfig.tests.json`、`pnpm format:check`、`pnpm test:e2e:matrix`、`pnpm --filter @autoforge/web build` 和 `git diff --check`。浏览器命令为 `pnpm exec playwright test tests/e2e/management-operations.spec.ts tests/e2e/ui-layout.spec.ts --grep 'execution record pagination|top-bar project context persists' --workers=1`，布局定位调整后单独复验两条分页流程。

本次未改数据库读取语义、迁移、Worker 或 Runner，也未重跑 Full 整体部署、真实 Java 用例和离线包验收。检查与浏览器测试串行限单核、4 GiB；日志及截图位于 `/var/tmp/autoforge-record-pages-20261024/`。

## 2026-10-24：公开日志入口与独立节点内存准入

- 复现：站外打开公开日志时 Strict Cookie 不随首个文档请求发送；同源 session 恢复随后触发 `location.reload`，同一 URL 产生两次 document 请求。恢复改为 Router 刷新并合并服务端内容，保留日志文档及滚动；当前登录按钮也使用该路径。首次加载使用同布局 Ant Design 骨架，避免中心加载图切换到双栏的整体位移。
- 准入漏洞：一次调度循环只扣并发槽位，同一旧心跳的内存百分比会让多个 JVM 集中拉起。新增有效可用容量、2 GiB/attempt 保守预留和系统余量，规划及 Lite/Full 原子预留重复核验全节点预算。Full 同步排除终态批次、终态 run 的残留 active attempt，保持与 Lite/快照查询一致。
- 143 不能直接等同资源不足：新增内核信号、数值退出的诊断，防止部分 TestNG XML 把中断原因改写为普通失败；保留取消、超时和 cgroup OOM 的优先判定。未取得用户局域网执行节点系统日志，无法确定其历史 143 的信号发送方。

验证证据位于 `/var/tmp/autoforge-log-resource-20261024/`：`before.log` 记录同一心跳过量派发的失败回归；`e2e-before.log` 记录同一公开日志 URL 两次 document 请求，`e2e-final.log` 中四条生产 Lite Playwright 场景通过。`db-final.log` 的 54 项双数据库回归覆盖跨批次原子内存预留、释放后补槽、旧心跳覆盖与迁移失败回滚。已实际查看 1024×768、1536×960 下的深浅色日志、会话恢复和登录弹窗截图，双栏、按钮、滚动边界及弹窗正常。

本轮验证命令：

```sh
pnpm format:check
pnpm lint
pnpm exec tsc --noEmit -p tsconfig.tests.json
pnpm exec vitest run packages/domain/test/{scheduler,attempt-result}.test.ts packages/contracts/test/management.test.ts packages/application/test/{manage-runners,normalize-testng-completion}.test.ts packages/runner-sdk/test/protocol-compatibility.test.ts apps/web/src/components/ui-usage.test.ts --maxWorkers=1 --no-file-parallelism
pnpm exec vitest run packages/db/test/scheduling-refill.integration.test.ts packages/db/test/runner-resource-samples.integration.test.ts packages/db/test/runner-memory-migration.integration.test.ts --maxWorkers=1 --no-file-parallelism
go -C apps/runner-agent test -p 1 ./...
pnpm --filter @autoforge/web build
pnpm exec playwright test tests/e2e/ddt-management.spec.ts tests/e2e/public-dashboard.spec.ts --grep 'public logs rerun failed Chinese DDT cases|public logs log in locally|public execution login preserves|public login retains' --workers=1
pnpm test:e2e:matrix
```

数据库验证通过临时 PostgreSQL 实例注入 `AUTOFORGE_TEST_POSTGRES_URL`，未访问用户局域网；生产构建、测试和浏览器均串行限制为 1 CPU / 4 GiB，未使用 OOM 压测。未运行整套 Full 基础设施 E2E 或完整离线镜像验收，本轮证据不能确认用户历史 143 的发送来源，也不承诺外部进程突增或服务管理器主动停止时没有进程中断。

## 2026-10-24：执行记录表格列宽均衡

此前压缩操作列后，将全部剩余宽度交给任务列，导致超宽屏任务列明显失衡。现在保留按内容估算的基础宽度，把剩余整像素均分给自动数据列，差值最多一个像素；操作列继续按当前按钮实际宽度显示，不承担额外填充。

手动调整的列不参与自动扩展，刷新后保持显示宽度，避免已扩展的显示值再次叠加。列边界按 Home 可清除该列覆盖并恢复自动分配，「重置列宽」恢复整表自动分配；所有数据列均由用户设定时，表格采用明确的总宽度，不再由 CSS 强制二次拉伸。继续使用同一 Lite/Full 页面组件，无数据库、查询、配置或执行协议变更。

回归先在原实现因其他数据列没有分到剩余宽度而失败；修改后列宽、Ant Design 约定与表格三组测试共 27 项通过。Lite 生产 Playwright 的 `execution record actions stay on one line after sharing and resizing saved columns` 场景通过，覆盖任务列大屏占比、分享控件展开、鼠标/键盘调宽、刷新持久化、Home 单列恢复、整表重置、终止确认和查看详情。实际查看 1024×768、1536×960、2560×960 深浅色共 12 张截图；列宽分配均衡、操作保持单行，窄屏沿用横向滚动，没有新增页面越界或按钮变形。

实际执行：`pnpm exec vitest run apps/web/src/lib/execution-record-columns.test.ts apps/web/src/components/ui-usage.test.ts apps/web/src/components/ui/table.test.tsx --maxWorkers=1 --no-file-parallelism`、受影响文件的 Prettier/ESLint、`pnpm exec tsc --noEmit -p tsconfig.tests.json`、`pnpm --filter @autoforge/web build`、`pnpm exec playwright test tests/e2e/ui-layout.spec.ts --grep 'execution record actions stay on one line' --workers=1` 和 `git diff --check`。构建和浏览器串行限单核、4 GiB；证据保存在 `/var/tmp/autoforge-record-columns-20261024/`。本轮为共享前端列宽修复，未重跑 Full 部署、数据库集成或真实 Runner 执行。
