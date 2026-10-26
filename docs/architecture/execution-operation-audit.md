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

## 2026-10-24：执行记录首屏列宽闪动

执行记录原来在服务端和水合首轮使用默认列宽，随后通过浏览器 store 恢复手动列宽，再由两个异步 ResizeObserver 更新容器及操作列宽；用户可见的表格因此经历多次排布。先补充生产 Lite Playwright 回归，延迟静态脚本以保留真实服务端首屏，逐帧比较已可见列宽，原实现复现了 136 像素的列宽跳变。

现在服务端保留表格的布局空间，使用共享 Ant Design 骨架屏提供加载状态；浏览器完成列宽恢复和同步布局测量后才显示表格。页面内导航通过 useLayoutEffect 在绘制前完成初次测量，后续容器、分享按钮尺寸变化仍由一个可清理的 ResizeObserver 处理，仅测量当前有界分页，尺寸不变不更新状态。骨架屏高于 Ant Table 的背景，最多预览六行，避免随每页条数重复生成大量加载控件。原有列宽均分、拖动、持久化、Home 和整表重置保持原规则。

Lite/Full 共用同一前端组件；无数据库迁移、后台读写、调度、Runner 协议、配置或新依赖变化。定向验证使用原列宽、表格和 UI 约定测试，生产浏览器回归覆盖延迟水合、页面内跳转，以及自动/保存列宽、分享、鼠标/键盘调宽、刷新恢复和终止/详情入口。复制提示的短时文本不作为布局场景的同步条件，直接核验实际剪贴板地址。

最终验证：27 项列宽、Ant Design 与共享表格定向测试通过；受影响文件 ESLint、测试 TypeScript 检查和 Web 生产构建通过。生产 Lite 的两条 Playwright 场景全部通过：首屏场景覆盖浅深色、1024×768 保存列宽、2560×960 自动及保存列宽，分别验证冷启动和页内导航；原交互场景覆盖 1024×768、1536×960、2560×960 浅深色。实际查看本轮 24 张截图，加载占位、最终列宽、按钮单行、固定列、横向滚动与边界正常，未发现新增页面溢出。

主要命令：

```sh
pnpm exec vitest run apps/web/src/lib/execution-record-columns.test.ts apps/web/src/components/ui-usage.test.ts apps/web/src/components/ui/table.test.tsx --maxWorkers=1
pnpm exec eslint apps/web/src/components/execution-records-table.tsx tests/e2e/ui-layout.spec.ts
pnpm exec tsc --noEmit -p tsconfig.tests.json
pnpm --filter @autoforge/web build
pnpm exec playwright test tests/e2e/ui-layout.spec.ts --grep 'execution records keep their first visible|execution record actions stay on one line' --workers=1
```

格式及差异检查另行通过。构建和浏览器均串行限制一个 CPU、4 GiB；复现、构建、浏览器日志及截图保存在 `/var/tmp/autoforge-record-first-paint-20261024/`。此次限于共享前端首次显示时序，未重跑 Full 整体部署、数据库集成、真实 Runner 或完整离线包验收。

## 2026-10-24：DDT 子 Tab 切换闪动

原实现点击子 Tab 时先修改本地 `tab`，再调用原生 History API。`useSearchParams` 尚未更新时，同步 effect 会把选中项撤回旧值；随后新 URL 再次触发切换。生产 Lite 回归复现了一次点击三次内容淡入、用例双栏重复挂载，高度在 320/373 像素之间多次变化；仅在动画结束后检查位置无法发现该问题。

现在点击只更新 URL，由既有的未保存修改保护统一提交选中状态，不再与旧 URL 快照竞争。DDT 子页取消整块淡入，其他页面的共享动效保持原规则。双栏首次挂载同步测量宽度和可用高度，在绘制前完成调整，后续 resize 继续合并到帧并保留清理逻辑；隐藏的 TestNG/DDT 面板仍不会覆盖布局。没有新增后台读取、配置、依赖、迁移或执行协议变化，Lite/Full 使用同一组件。

新增 Playwright 在八个子页之间往返，通过 MutationObserver 断言一次点击仅提交一次选中状态，检查无内容变淡，并逐帧核对用例双栏宽度、高度及导航宽度。覆盖 1024×768、1536×960 深浅色，以及后退、前进和刷新定位。25 项定向单元/UI 约定测试与四条生产 Lite 浏览器场景通过；其他三条场景覆盖 TestNG/DDT 导航位置、共享页面动效/弹窗焦点，以及导入、按需详情、字段类型校验、保存/恢复、未保存修改确认、旧响应隔离、错误重试、筛选历史、分页、分栏拖动与折叠。

子页场景生成 32 张截图，实际查看了全部八个子页在最小桌面浅色和大屏深色的 16 张截图；另检查有数据的双栏 1024×768、1536×1024、2560×1440 截图。层级、对齐、换行、滚动和操作控件未发现新增变形。浏览器无未捕获错误；受影响文件格式、Lint、测试类型与 Web 生产构建通过。

主要验证命令：

```sh
pnpm exec vitest run apps/web/src/components/ui-usage.test.ts apps/web/src/lib/ddt-case-selection.test.ts apps/web/src/lib/ddt-filtered-case-selection.test.ts --maxWorkers=1
pnpm exec eslint apps/web/src/components/ddt-management-workspace.tsx apps/web/src/components/use-ddt-browser-layout.ts tests/e2e/tab-navigation.spec.ts
pnpm exec tsc --noEmit -p tsconfig.tests.json
pnpm --filter @autoforge/web build
pnpm exec playwright test tests/e2e/tab-navigation.spec.ts --grep 'DDT subtabs keep opaque' --workers=1
pnpm exec playwright test tests/e2e/tab-navigation.spec.ts tests/e2e/ddt-management.spec.ts --grep 'case tabs keep their navigation|navigation and dialogs use bounded|DDT split workspace loads details on demand' --workers=1
```

所有构建、类型检查和浏览器任务串行限制一个 CPU、4 GiB；复现、指标、构建和浏览器日志与截图保存在 `/var/tmp/autoforge-ddt-tab-flash-20261024/`。本轮只调整共享前端时序，未重跑 Full 整体部署、数据库集成、真实 Runner 或完整离线包验收。

## 2026-10-24：版本共享 SR 标签及两列表格分类

新增独立的 SR 标签，不改变既有 SR 测试类关联或需求分类。标签按项目和版本隔离，同版本跨阶段共享；任务详情显示标签并支持匹配／反选当前任务的 DDT 成员，普通用例勾选保持原值。查询每次最多读取 201 个轻量成员候选，稀疏标签也不在一个请求扫描完整任务；取消或失败不应用部分勾选。

SR 标签弹窗支持下载模板、预览导入和导出全部分类。首行识别 SR／标签表头，同 SR 可以关联不同标签，同 SR 与标签的重复组合明确报错；未知 SR、公式、额外列和缺失值均定位到工作表及行号。预览问题阻止全部写入，正式提交重新解析校验；后台解析、每批 100 行短事务和分页流式导出保持有界负载。已有标签和关联复用，导出可直接重导；中断显示已完成进度，允许重试。

SQLite `0082_ddt_sr_tags.sql`、PostgreSQL `0080_ddt_sr_tags.sql` 新增标签表及复合外键，版本完整复制纳入标签和关联，并沿用目标版本占用保护。无新依赖、持久配置、Runner/Adapter 协议或离线资源类型变化。迁移失败沿用事务回滚及重试，降级恢复升级前备份。

标签和复制阶段完成双数据库、选择及 UI 定向验证；表格功能最终 62 项测试通过，两种数据库均注入关联写入故障验证整批回滚。工作区类型、Web 服务／线程／测试类型、受影响文件格式与 Lint、Web 生产构建通过。四条生产 Lite Playwright 场景覆盖新标签及表格闭环、原 SR 分类筛选和子 Tab 回归，1024×768、1536×960 深浅色截图已实际审查；小屏成功提示、分页及嵌套导入弹窗完整可见。真实下载模板和分类文件通过 ExcelJS、ZIP CRC/XML 及 LibreOffice Calc 保存回读，单元格一致；未使用 Microsoft Excel 桌面客户端。

具体命令和边界见 [DDT SR 标签](./ddt-sr-tags.md)。日志、截图及工作簿保存在 `/var/tmp/autoforge-sr-tags-20261024/` 和 `/var/tmp/autoforge-sr-tag-sheets-20261024/`，所有重负载任务串行限 1 CPU、4 GiB。未重跑整仓、十万成员完整复制规模、Full 全栈浏览器、真实 Runner 或完整离线部署验收。

此次按维护者要求以 `v1.20.14` 快速发布，仅触发 Release；其他五项 workflow 在推送前暂停，发布结束后恢复原启用状态。Release 仍执行双架构构建、镜像内置资源校验、SBOM、签名及完整资产发布，其他流水线不记为通过。

## 2026-10-24：任务详情按标签直接勾选 SR

任务 SR 标签现在可以直接点击，勾选本任务所有匹配 SR 分组及其 DDT 用例，包括未展开分组与其他测试阶段的同名 SR；工具栏明确为“勾选带标签的 SR”“勾选不带标签的 SR”，完成后显示 SR 分组数与用例数。普通用例选择保持不变，后续移除仍需原确认，不产生立即执行或成员写入。

快捷入口和多标签工具栏共用原有分页 API，进度保留在工具栏内部，避免每页更新整棵任务树。没有数据库、接口、配置、依赖或 Runner 协议变更，Lite/Full 复用实现。

20 项分页选择与 UI 规范测试、变更文件格式及 Lint、测试 TypeScript、Web 生产构建通过。生产 Lite Playwright 回归通过，覆盖多 SR、跨阶段、折叠分组、鼠标与键盘、匹配和反选、普通用例选择保留及实际移除后刷新。UI 检查曾发现快捷按钮点击区域不足，已按主题调整到 32px；实际查看 1024×768、1536×960 深浅色八张最终结果截图，没有新增变形或越界。具体命令、边界与证据见 [DDT SR 标签](./ddt-sr-tags.md)。本轮未重跑双数据库集成、Full 全栈、真实 Runner 或完整离线部署验收。

## 2026-10-25：v1.20.15 快速发布

发布任务详情按 SR 标签直接勾选功能，复用上一节已经完成的定向测试、类型检查、生产构建和 Playwright 视觉验证。发布前核对工作树、远端主分支与最新版本，补齐变更日志，再检查受影响文件格式、E2E 覆盖矩阵和提交差异。

按维护者要求，仅触发 Release 的双架构构建、内置 Agent／Adapter 资源校验、SBOM、签名和完整资产发布；其他五项 workflow 在推送前临时暂停，发布结束后恢复原启用状态，不记为本次验收通过。发布后核对 tag／提交一致、完整附件集合、可信公钥签名、下载元数据校验和与远端资产摘要。发布记录保存在 `/var/tmp/autoforge-release-1.20.15/`。本版没有新增数据库迁移、依赖、配置或执行协议变更。

## 2026-10-25：按清单从指定任务移除 DDT 成员

DDT 管理已选操作区新增“从用例任务移除”，复用清单、手动或筛选产生的完整选择。选择目标任务后，以每批 200 条轻量元数据匹配当前版本和阶段的成员交集，显示匹配和跳过数量；取消或预览失败不写入，没有交集时禁用确认。确认复用原有原子移除接口及版本快照，保留普通成员、其他任务／阶段的同名成员、用例资产和既有执行记录。新增任务后刷新可选任务，窄桌面操作栏允许自然换行。

新增只读匹配端点使用现有 `case_suite.manage`、同源校验、请求体边界和显式 DTO，不读取完整任务或 DDT 正文，不修改迁移、队列、存储、依赖或 Runner 协议。Lite/Full 共用应用服务与既有持久化事务。

45 项定向测试通过，SQLite/PostgreSQL 均实际验证任务／阶段隔离、执行快照和用例保留及重复提交幂等。Web／测试类型、变更文件格式与 Lint、生产构建通过；生产 Lite 的新增移除和原有清单添加两条 Playwright 场景通过。新场景的初次夹具缺失项目上下文已修正，按钮类型检查问题已改用共享 Ant Design 按钮；均保留失败证据，没有放宽检查。实际查看 1024×768、1536×960 的六张操作区、深浅色预览截图，控件、表格与弹窗布局正常。

详细命令与限制见 [DDT 管理](./ddt-management.md#按清单从任务移除)。本轮重负载任务串行限 1 CPU、4 GiB，临时 PostgreSQL 和 Web 服务已停止，证据保存在 `/var/tmp/autoforge-list-removal-20261025/`。未重跑整仓、Full 全栈、真实 Runner 或完整离线部署验收。

## 2026-10-25：两个独立任务的补槽阻塞

用户报告一个全普通用例任务与一个全 DDT 任务同时使用相同独立执行节点，任务并发均设为 40、没有开启动态并发，DDT 仅约 5～11 个在执行。按两个独立批次复查，而非一个包含两种成员的任务；未访问用户的局域网或生产库。

确认可复现的调度缺陷：候选列表包含仍有排队用例、但已达到批次并发上限的任务；Runner 只空出一个槽位时，领取触发的补调度原来只检查队首一个批次。若普通任务位于队首且已有 40 个在途用例，调度在它上面得到零额度后结束，后续只有五个在途用例的 DDT 任务无法利用空槽。这个缺陷取决于排序和补槽时机，交换任务类型同样可复现，不是 DDT 专用并发上限。

Lite/Full 的全局及按 Runner 候选查询现先按当前生效的并发状态排除已满批次，再执行排序和窗口限制；历史 NULL 策略仍无批次上限，缺少并发字段的策略对象仍默认四。领取补调度继续合并同一 Runner 的并发请求，候选窗口固定最多八个，不随空闲槽缩成一个。分配事务继续权威复核 Runner、项目、批次及资源额度；没有提高资源阈值或绕开内存预留。

另复现 Lite 的并发计数不一致：已结束的 DDT 执行用例若遗留运行中 attempt，仍被 `batchActiveRuns` 算作在途；Full 已排除此类记录。Lite 现同时要求执行用例和 attempt 为已分配／执行中，避免终态残留虚占批次名额。SQLite 在修复前的对应调度用例失败、PostgreSQL 通过；修复后保持一致。

双数据库共享回归用两个独立批次分别构造“40 个在途普通用例＋5 个在途 DDT 用例”和相反顺序，共用一个只剩一槽的 Runner。测试候选筛选、真实应用调度、分配事务和协议仓储领取，检查补到后续批次、原批次不超限、中文 DDT CaseID 原样传递，并覆盖待领取占额、动态并发生效状态、历史策略及槽位释放后重新参与排序。用持久化记录模拟在途执行，没有启动 45 个 JVM。

无新增迁移、配置、生产依赖、对象存储／队列或 Runner 协议变化。Lite 继续使用 SQLite 和本地对象存储，Full 继续使用 PostgreSQL；不依赖 Redis／NATS 缓存决定并发正确性，已有租约恢复、取消及资源保护规则不变。需要更新主平台及独立 Full worker，无需为本修复更改 Agent 协议。

验证结果：调度、执行控制及共享双数据库回归四个文件共 130 项通过；补充历史策略检查后，双数据库 50 项再次通过。数据库／应用／测试 TypeScript、受影响文件格式与 ESLint、Web 和独立 worker 生产构建通过。SQLite 实际查询计划使用 `execution_runs_batch_status_idx` 和 `run_attempts_run_round_number_idx` 定位活跃记录，没有扫描全部 attempt 历史。

生产 Lite 的原即时补槽 Playwright 场景通过，覆盖单例完成后立即补位、同轮即时重试、重复完成上报、执行期间首次读取已完成用例公开日志及执行记录取消。浏览器使用协议模拟执行机，未启动真实 Java；此次没有修改 UI。所有重任务串行限制 1 CPU、4 GiB，临时 Web 服务和 PostgreSQL 验证实例结束后关闭。证据保存在 `/var/tmp/autoforge-ddt-refill-20261025/`。

实际运行：

```sh
# 临时 PostgreSQL URL 显式注入 AUTOFORGE_TEST_POSTGRES_URL，两种数据库均实际运行。
pnpm exec vitest run packages/db/test/scheduling-refill.integration.test.ts packages/application/test/control-executions.test.ts packages/application/test/schedule-run-batches.test.ts packages/domain/test/scheduler.test.ts --maxWorkers=1
pnpm --filter @autoforge/db typecheck
pnpm --filter @autoforge/application typecheck
pnpm exec tsc --noEmit -p tsconfig.tests.json
pnpm --filter @autoforge/web build
pnpm --filter @autoforge/worker build
pnpm exec playwright test tests/e2e/scheduling-refill.spec.ts --workers=1
git diff --check
```

本次没有运行 Full 整体部署、真实 Runner／Java 或完整离线镜像验收，也没有访问用户现场。已证明并修复上述补槽缺陷及 Lite 计数差异；实际并发仍受 Runner、项目、内存与资源新鲜度等准入条件约束，不能据此承诺任何节点均可持续跑满 40。

### 持续补槽补充复查：先启动任务挤占

用户补充普通任务结束后 DDT 明显加速，并确认共同选择 8 台节点、每台 Agent 最大并发 10，普通任务并发 30、DDT 任务并发 40，项目最大在途执行数为 128。总配置需求 70 小于节点槽位 80 和项目额度 128，不能归因为这两项配置不足；内存等实际准入仍需单独计算。

上一轮只覆盖了队首批次已经满额的情况。进一步确认两条未覆盖路径：完成接口及控制协议快路径只调用原批次的 `schedule(batchId)`，释放的容量会先被原任务补回；候选排序又持续按较早计划时间累积加分，即使改为扫描多个批次，先启动任务尚差一槽时仍可能一直先补。因此仅排除已满候选不足以解决持续占用比例不均。新增“普通 30 降为 29、DDT 在途 5、共享池仅空出一槽”及类型互换的双数据库测试，补强前四项失败，补强后通过。

完成上报现在让该 Runner 的候选任务共同补位，accepted 和 duplicate 都保持幂等，调度失败仍传回供 Agent 重放；late、不关联批次的历史结果不补位。原任务没有排队用例或刚结束时，也不能依据它自己的 `hasSchedulableRuns=false` 跳过其他任务。普通 Route Handler 与快路径共用完成后补槽规则，同一 Runner 的请求继续通过已有工作线程代理合并，不把同步 SQL 移回 Web 事件循环。

候选排序保持显式优先级；等待时间加分只提升尚无在途执行的排队任务。已启动的同优先级任务按在途数从少到多补位，相同时仍按计划时间和 ID 稳定排序。没有在途的低优先级任务仍可通过原有等待加分提升，避免永久饥饿。不是抢占正在执行的用例，也不改变任务基础／动态并发上限；共享容量不足时逐步均衡，不能保证每个任务独享其配置上限。

按实际配置新增 8×10 节点、普通 30、DDT 40 的 SQLite/PostgreSQL 分配回归。节点携带 16 CPU、32 GiB 绝对内存指标，选择有资源余量的样本，分别验证：

| 项目最大在途数  | 普通任务在途 | 后启动 DDT 在途 | 普通任务结束并释放额度后 DDT |
| --------------- | ------------ | --------------- | ---------------------------- |
| 128（用户配置） | 30           | 40              | 40                           |
| 40（对照）      | 30           | 10              | 40                           |

每种情况均检查八个节点分别不超过 10，总项目额度不被绕过；对照场景说明平台限额可产生相似表象，但不符合用户给出的 128。测试使用真实仓储分配和模拟终态释放，没有启动 70 个 JVM，也不把低内存占用的准入样本当作用户现场 70% 内存的性能证明。原内存预留保护保持不变。

最终七个文件 183 项回归通过，其中双数据库共享回归共 60 项；新增快路径检查覆盖鉴权成功后才补位、已关闭批次／重复完成仍补其他任务，以及拒绝鉴权不触发调度。多节点夹具初次复用了普通用例身份和来源摘要，触发真实唯一约束；已修正夹具为独立普通类身份和来源摘要，未放宽约束，保留首次失败证据。数据库、应用及测试类型、受影响文件格式和 ESLint、Web 与独立 worker 生产构建通过。实际 SQLite 查询计划继续使用批次状态与 attempt 索引，没有扫描全部执行历史。

生产 Lite 三项 Playwright 全部通过：双任务并发补槽没有 `schedule-batch` 数据库保护事件；500 协议槽位持续续租、诊断／日志／导出及完成后全部成功，读取 P95 小于 1.5 秒、最大值小于五秒的门禁通过；原即时重试、重复完成上报及完成后补位保持通过。这里记录门禁结果，不把它当作用户现场实测延迟。浏览器使用模拟 Runner Protocol，没有启动 500 个 JVM；此次没有修改 UI。

实际验证命令：

```sh
# 为数据库测试显式设置临时 AUTOFORGE_TEST_POSTGRES_URL，SQLite/PostgreSQL 均实际运行。
pnpm exec vitest run packages/db/test/scheduling-refill.integration.test.ts packages/application/test/control-executions.test.ts packages/application/test/schedule-run-batches.test.ts packages/domain/test/scheduler.test.ts apps/web/src/lib/refill-runner-after-completion.test.ts apps/web/src/lib/runner-fast-path-bridge.test.ts apps/web/src/lib/work-dispatch.test.ts --maxWorkers=1
pnpm --filter @autoforge/db typecheck
pnpm --filter @autoforge/application typecheck
pnpm exec tsc --noEmit -p tsconfig.tests.json
pnpm --filter @autoforge/web build
pnpm --filter @autoforge/worker build
pnpm exec playwright test tests/e2e/scheduling-refill.spec.ts tests/e2e/lite-high-concurrency.spec.ts --workers=1
pnpm test:e2e:matrix
git diff --check
```

格式和 ESLint 仅检查本轮受影响文件。500 槽位测试使用独立临时数据目录并把测试项目额度设为 500，未修改用户部署。全部重任务串行限 1 CPU、4 GiB；临时 Web 与 PostgreSQL 在结束后关闭，证据保存在 `/var/tmp/autoforge-concurrent-tasks-20261025/`。无新增迁移、配置、依赖或 Runner 协议变化，未运行 Full 整套基础设施、真实 Java／Agent 或完整离线镜像验收。

## 2026-10-25：活动任务未达并发上限的只读诊断

执行详情增加按需打开的“并发诊断”，明确区分执行中、已分配待领取、立即可调度及等待轮次释放；展示生效并发上限、项目额度、节点本任务／其他任务占用、资源阈值和内存保守预留依据。无可用预算时列出具体条件，有空闲但还未分配时明确等待共同补位，不把一次采样推断成调度故障。读取复用领域准入规则和已有隔离只读进程，响应仅包含有界聚合与所选节点，避免诊断本身阻塞执行控制。需批次项目范围内的执行记录及节点查看权限，不开放匿名诊断。

最终 158 项定向测试通过，含实际 SQLite/PostgreSQL、新端点权限、白名单和 UI 约定。生产 Lite 两条 Playwright 通过，覆盖诊断按需读取／分页／错误重试／焦点及原有执行补槽、重试、日志和取消。实际查看最终 1024×768、1536×960 深浅色、入口与错误共 11 张截图；长节点名经视觉复查改为两行后，未发现新增错位或页面越界。格式、Lint、受影响类型、Web／worker 构建与矩阵通过，无新增迁移、配置、依赖或协议变化。具体命令、证据及边界见[执行任务并发诊断](./execution-concurrency-diagnostics.md)。

## 2026-10-25：v1.20.16 快速发布

本版整理并发布按清单移除 DDT 任务成员、独立任务持续补槽修复与按需并发诊断，复用前述已完成的双数据库、生产构建、浏览器及视觉验证。发布前核对远端主分支与版本、整理变更日志，再执行有界的格式、许可、矩阵和提交差异检查。

按维护者要求走最快发布路径：仅触发 Release，保留双架构镜像、内置 Agent／Adapter 校验、SBOM、清单、签名及完整资产发布。其他五条 workflow 在推送前临时暂停，发布结束后恢复原状态；未运行的流程不记为通过。发布从指向已检查提交的 `v1.20.16` tag 构建，完成后核对资产集合、签名、元数据校验和、源码 revision 和工作流状态。发布过程与最终校验证据保存于 `/var/tmp/autoforge-release-1.20.16/`。

## 2026-10-25：内存增长预留与节点均分

现场并发诊断显示节点有效总量 31.4 GiB、可用 13.26 GiB、系统保留约 3.14 GiB、每例 2 GiB，却无法继续派发。旧算法在有效可用量之外，又为所有在途用例重复预留完整上限；已有执行的真实占用越大，额外保守空间越多。

新规则保留系统预算和每例上限，只抵扣同一心跳采样中已经计入的受控执行匿名内存，继续预留到各自上限的增长空间。抵扣还受实时／心跳忙碌槽位限制，实时 claim 确认旧执行结束后，不把旧抵扣借给未启动的 assignment。数据库原子预留复用相同领域规则，跨任务共享预算，指标过期或预算不足只停止新增，不终止已有用例。

Agent 只读取当前 supervisor 跟踪的最多 64 个执行组，采样前后按同组取较小匿名占用；孤儿执行组不授予抵扣。宿主机继续使用 `MemAvailable`，各层 cgroup 仅回收干净非活跃文件页，排除脏页和写回页；不扫描全机进程，不把整份 Cached 或共享内存当成可借用预算。Agent 及执行目录的祖先限制逐级求交。字段、公式、迁移与限制详见 [Runner 内存准入](./runner-agent.md#内存准入与进程终止诊断2026-10-24)。

首次分配与重试均优先补齐健康节点较少的共享在途占用，同占用再比较资源评分或重试轮换；基础设施排除、能力、资源阈值、任务／项目限额继续优先。真实 SQLite/PostgreSQL 仓储的八节点测试中，普通任务 30、DDT 任务 40、项目额度 128 时，最终每节点 8 或 9 个预留；没有启动 70 个 JVM。

验证结果：

- 最终八个 Vitest 文件 182 项通过，其中双数据库集成 76 项，包含并发预留、冷热指标、任务间共享、完成补位、分页诊断、心跳落库、上一版迁移升级及失败 DDL 回滚；SQLite 和 PostgreSQL 均实际执行。
- `go test ./...`、`go vet ./...`、格式检查通过，执行生命周期测试验证当前 workspace 的组注册及完成后的清理，匿名占用单元测试排除未跟踪的遗留组、非执行内存、重复组、进出采样窗口及不包含执行目录的限制。
- 在一次性 systemd 委派目录中运行真实进程，子组硬限 64 MiB、实际触碰 16 MiB；Agent 在父组 4 GiB 限制内识别约 17 MiB 的已计入匿名内存，进程结束后抵扣归零，`oom_kill=0`。测试不探测宿主机 OOM，不等同于真实业务 JVM 压测。
- Linux amd64／arm64 Agent 静态构建通过现有脚本的 ELF、架构、无解释器／动态库依赖及 CGO 校验；未新增依赖、外部服务或运行时下载。
- 数据库、应用、领域、Web 服务／工作线程、测试类型和 Web／独立 worker 构建通过；18 行 E2E 覆盖矩阵、受影响文件格式／Lint 与差异检查通过。
- 最终生产 Lite Playwright 两项通过：诊断实际读取并展示新内存预算、权限／按需读取／错误恢复／节点分页；原即时补槽用例继续覆盖满载、实时领取、失败重试、重复完成、日志和终态／取消流程。第一次运行因更新测试时误改旧满载场景的断言失败，纠正后两项从新数据目录完整重跑通过。
- 实际查看最终 11 张截图，覆盖 1024×768 与 1536×960 的深浅色概览／节点表格、页面入口及错误态；未发现新增对齐、换行或控件变形，内容沿既有弹窗滚动边界显示，页脚操作保持可见。

实际命令（重任务串行、限制 1 CPU／4 GiB）：

```sh
# 集成测试使用一次性 AUTOFORGE_TEST_POSTGRES_URL，不连接生产数据库。
pnpm exec vitest run packages/domain/test/scheduler.test.ts packages/contracts/test/management.test.ts packages/db/test/runner-resource-samples.integration.test.ts packages/db/test/runner-memory-migration.integration.test.ts packages/db/test/scheduling-refill.integration.test.ts packages/application/test/read-concurrency-diagnostics.test.ts packages/application/test/manage-runners.test.ts apps/web/src/components/ui-usage.test.ts --maxWorkers=1
go -C apps/runner-agent test ./...
go -C apps/runner-agent vet ./...
# 单独的一次性委派 unit 中运行编译后的真实内存采集测试。
AUTOFORGE_TEST_LIVE_MEMORY=1 ./metrics.test -test.run='^TestLiveExecutionMemoryCredit$' -test.v -test.timeout=20s
pnpm --filter @autoforge/db typecheck
pnpm --filter @autoforge/application typecheck
pnpm --filter @autoforge/domain typecheck
pnpm exec tsc --noEmit -p tsconfig.tests.json
pnpm exec tsc --noEmit -p apps/web/tsconfig.server.json
pnpm exec tsc --noEmit -p apps/web/tsconfig.worker.json
pnpm --filter @autoforge/web build
pnpm --filter @autoforge/worker build
pnpm exec playwright test tests/e2e/scheduling-refill.spec.ts --workers=1
pnpm test:e2e:matrix
git diff --check
```

完整日志、脚本、双架构校验物与截图在 `/var/tmp/autoforge-memory-admission-20261025/`。新增 SQLite 0083／PostgreSQL 0081 可空列，旧 Agent 缺失抵扣时清空旧值并继续保守计算；没有绝对容量的更旧 Agent 保留既有百分比行为。生效需同步更新平台、Full worker 和独立节点 Agent，并启用现有 cgroup v2 配置。未运行 Full 整套部署、真实业务 Java 批跑或完整离线镜像验收，也未接入用户局域网；外部进程突发分配、运维收紧限额或用例自身突破上限仍可能 OOM，不能承诺任意现场绝不中断。

## 2026-10-26：v1.20.17 快速发布

本版发布内存增长预留、可回收缓存采集、节点均分和内存诊断展示，复用上一节已完成的 182 项定向测试、Go／真实 cgroup／双架构静态构建，以及两项生产 Lite Playwright 和 11 张视觉截图证据；不重复启动高负载验收。发布前检查远端主分支与已有版本、变更日志、格式、许可证、矩阵和提交差异。

按维护者要求仅运行 Release，保留双架构镜像、内置 Agent／Adapter 校验、SBOM、清单、签名及完整资产发布；其他五条 workflow 在推送前暂停，发布流程结束后恢复原状态。正式资产从指向本次提交的不可变 `v1.20.17` tag 构建，发布后核对资产集合、签名、元数据校验和、源码 revision 和工作流恢复状态，证据保存于 `/var/tmp/autoforge-release-1.20.17/`。

升级新增 SQLite 0083／PostgreSQL 0081 可空抵扣列，应按现有运维流程备份后更新平台及 Full worker，并同步更新独立执行节点 Agent、启用 cgroup v2。旧 Agent 继续兼容并采用保守预算；本地验证不等于用户现场 70 个 JVM 的业务压测，也不承诺外部进程抢占等边界下绝无 OOM。

## 2026-10-26：三种内存调度策略与旧节点兼容

为避免 SLES 12 等无 cgroup v2 的现有节点只能承受完整内存预留，平台配置新增 `scheduler.memoryAdmissionMode`。管理员可在“平台设置 → 平台配置 → 内存调度策略”选择默认 `reserved`（阈值与预留）、`threshold`（仅按内存使用率）或 `disabled`（不限制内存）；不通过填写超过 100% 的阈值隐式绕过。百分比仍只接受 1–100%，设为 100% 不会关闭每例预留。

新字段通过 Web、隔离调度工作线程与独立 Full worker 的组合根传入同一领域规则，SQLite/PostgreSQL 原子预留继续复核同一策略；诊断展示当前进程生效策略，非预留模式不展示无效的系统／增长预算。三种模式均保留 CPU、负载、指标新鲜度、节点槽位、任务与项目并发以及兼容性检查，节点均分与重试轮换不变。

配置沿用既有生命周期，保存后提示重启 Web，Full 同时重启 worker 后应用。旧配置缺字段时默认保留保护；旧 v1 客户端省略策略的配置写入会保留管理员当前选择。无需数据库迁移、生产依赖、Agent 协议变更或节点升级，分布式部署仍由统一部署配置管理。策略不改变 Agent 已有的执行器硬限制，也不授予修改配置以外的权限。

验证结果：

- 先增加复现测试：旧规则在低使用率但完整预留耗尽时拒绝追加，也无法显式关闭内存检查；两项新行为断言失败后才接入策略分支。
- 最终十个 Vitest 文件 160 项通过，含真实 SQLite/PostgreSQL 分配回归 70 项；覆盖默认保护、阈值／关闭模式、跨任务原子预算及释放、CPU／槽位／过期指标仍拦截、配置默认／持久化、旧客户端写入保留、200% 拒绝及 Full worker 配置读取。
- Web／worker 生产构建、配置／契约／数据库／应用／worker 与 Web 服务／工作线程和 E2E 类型、受影响格式／Lint、许可、18 行 E2E 矩阵与差异检查通过。服务端 NodeNext 配置类型通过契约独立入口读取，不改变全局模块解析或放宽类型校验。
- 最终生产 Lite Playwright 四个场景全部通过：一个设置场景，以及三个独立进程配置下的实际调度与 Runner 领取。模拟节点不声明 cgroup v2、上报旧 Agent 版本与绝对内存指标，任务并发和节点槽位均为 8；默认模式在 16 GiB／可用 12 GiB 时领取 4 个，阈值模式领取 8 个，关闭模式在内存 100%／可用零时仍领取 8 个。该结果是协议分配验证，不表示实际启动八个 JVM 或运行 SLES 12 实机。
- 设置场景实际操作三个 Ant Design 选项，验证保存／刷新、重启提示、旧客户端保留和 HTTP 拒绝 200%；实际查看最终 10 张 1024×768／1536×960 截图，覆盖设置页浅色兼容模式／深色关闭模式以及诊断三种策略，未发现新增错位、控件变形或页面越界。
- 浏览器首轮修正了测试对表单桥接、任务卡片可访问名称和异步导入等待的假设；异步导入使用已有测试相同的 20／60 秒有界等待，最终从新目录完整跑通，没有放宽调度并发断言。
- v1.20.18 标准发布整理时，新增场景接入 CI 的 Lite 操作分区、Full 治理分区及源码／已发布镜像的离线治理验收；没有关闭任何工作流。发布前全仓 `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、八项发布工作流契约测试、三个验收脚本的 `bash -n`、E2E 矩阵与差异检查均通过，重任务继续限制 1 CPU／4 GiB 串行执行。

实际命令：

```sh
# 双数据库测试使用一次性 AUTOFORGE_TEST_POSTGRES_URL。
pnpm exec vitest run packages/domain/test/scheduler.test.ts packages/platform-config/test/platform-configuration.test.ts packages/platform-config/test/distributed-configuration.test.ts packages/contracts/test/memory-admission.test.ts packages/db/test/scheduling-refill.integration.test.ts packages/application/test/read-concurrency-diagnostics.test.ts apps/web/src/lib/platform-configuration.test.ts apps/web/src/lib/config.test.ts apps/web/src/components/ui-usage.test.ts apps/worker/src/config.test.ts --maxWorkers=1
pnpm --filter @autoforge/platform-config typecheck
pnpm --filter @autoforge/contracts typecheck
pnpm --filter @autoforge/db typecheck
pnpm --filter @autoforge/application typecheck
pnpm --filter @autoforge/worker typecheck
pnpm exec tsc --noEmit -p tsconfig.tests.json
pnpm exec tsc --noEmit -p apps/web/tsconfig.server.json
pnpm exec tsc --noEmit -p apps/web/tsconfig.worker.json
pnpm --filter @autoforge/web build
pnpm --filter @autoforge/worker build
# 每次分别在匹配的隔离 Web 配置下运行，环境变量仅供测试断言识别活动策略。
AUTOFORGE_E2E_MEMORY_ADMISSION_MODE=reserved pnpm exec playwright test tests/e2e/memory-admission.spec.ts --workers=1
AUTOFORGE_E2E_MEMORY_ADMISSION_MODE=threshold pnpm exec playwright test tests/e2e/memory-admission.spec.ts --grep 'dispatches to a Runner' --workers=1
AUTOFORGE_E2E_MEMORY_ADMISSION_MODE=disabled pnpm exec playwright test tests/e2e/memory-admission.spec.ts --grep 'dispatches to a Runner' --workers=1
pnpm licenses:check
pnpm test:e2e:matrix
git diff --check
```

证据位于 `/var/tmp/autoforge-memory-modes-20261026/`。所有重任务串行限制 1 CPU／4 GiB，临时 Web 和私有 PostgreSQL 在检查后停止。本次未运行 Full 整套中间件、SLES 12 实机、真实业务 Java 压测或完整离线镜像验收；无 cgroup v2 时缺少同等级的单用例内存硬保护，兼容／关闭策略降低准入保护，不能承诺无 OOM。平台“系统运行资源优先级”保护与执行器资源限制不受此调度选项关闭。

## 2026-10-26：v1.20.18 标准发布验证与安全修复

标准流程执行全部现有检查时，生产依赖审计发现 Zod 4.4.3 命中 GHSA-mrhx-c7xc-m3w5。四处生产依赖固定到官方修复版本 4.6.6，提交锁文件与许可证清单；沿用 MIT、纯 JavaScript 离线打包，无新增服务或原生二进制。新增小集合回归在旧版本对数组、Set、Map 均复现“超过上限后仍逐项校验”，升级后均在元素校验前拒绝。生产审计 High／Critical 为零，仍有七项 Moderate，未把审计门禁通过描述成不存在任何漏洞。

安全修复后本地 34 个文件 254 项契约／配置／领域测试通过，全仓类型、Web／worker 生产构建、受影响格式／Lint 与许可证检查通过。与此前 160 项存在交叉，不累加作为独立用例总数。

标准 Full 治理检查暴露历史分页／版本复制夹具仅支持 SQLite：提取已有历史夹具连接，统一参数占位符与批次序号，补齐 PostgreSQL，写入与所有调用均等待异步完成；新增回归在真实 SQLite／PostgreSQL 验证六条历史记录、独立序号及通过／失败汇总，包含原有回归共 72 项通过。减少动效检查改为读取当前 DDT 工作台及子树的动画，去除已退役容器选择器。它们属于验收工具修正，没有跳过原场景或修改产品页面。

Full 治理与断网 Lite 操作分区给项目 128 个名额，使新内存场景可实际领取默认策略的四个槽位；恢复分区保留单名额设置。聚合场景同时断言精确的节点内存预算及项目限制后的实际领取数，不以任务并发覆盖项目额度。所有远端失败记录保留，后续以修正提交重新运行标准检查，不改写发布标签。

首轮完整浏览器检查还复现既有 DDT 问题：最小桌面工具栏新增按钮造成换行，用例列表可视高度只有 106px；新建 SR 标签后，200ms 延迟刷新的 loading 变化会关闭刚打开的选择器。前者仅在窄桌面使用统一间距令操作保持紧凑，后者立即锁定刷新状态，并从已校验的创建响应补齐新标签选项。DDT 移除接口的匿名测试使用实际服务端 Origin，避免 Full 的 3199 端口被写死的 Lite 3100 Origin 提前判为 CSRF 拒绝；认证与同源检查均保持原规则。

修正后的本地七项生产 Lite Playwright 已通过，覆盖任务／单用例分页、新建／空版本复制、内存策略保存与分配，以及草稿保护／减少动效；E2E 类型、受影响 Lint／格式通过。

DDT 两项完整生产 Lite Playwright 最终通过，覆盖分栏浏览、动态字段与快捷导航，以及标签创建／分配、跨阶段共享和任务选择／反选。已实际查看 1024×768、1536×1024 的工作台和 1024×768、1536×960 的标签弹窗共四张新增截图，窄桌面工具栏保持单行，用例列表满足原先不少于 140px 的断言，弹窗无新增溢出。Web 生产构建、17 项 UI 约定、E2E 类型和受影响 Lint 均通过；本地证据位于 `/var/tmp/autoforge-release-1.20.18/`，所有重任务继续串行限制 1 CPU／4 GiB。

第二轮断网 Lite 操作分区中，内存策略与减少动效场景已经通过；单用例分页在目标导航尚未完成时仍显示第一页。分页测试现在明确等待目标 `cursorPage` URL 后再断言原有页数／数量，不重复点击、不添加重试或放宽业务断言。本地两个分页场景复验通过；该分区浏览器本身实测约 8.2 分钟，原八分钟作业预算不足以同时包含生产构建与部署检查，因此改为有界十二分钟，与较长验收分区一致，单项测试时限不变。

操作栏视觉场景另一次 CI 暴露轮次切换的测试竞态：初始与全部轮次均为五行，单凭数量断言可能拿到即将卸载的旧表格，滚动等待因节点替换失败。测试先确认轮次按钮 `aria-current` 已生效，再读取行，并在同一次浏览器同步求值中完成即时滚动，避免跨帧持有旧节点；不修改产品表格、不跳过断言、不增加场景重试。定向生产 Lite Playwright 通过，覆盖登录／匿名、深浅色、1024px／1536px 与两种轮次的 16 组布局，类型与 Lint 通过；格式整理后复查通过，实际查看 1024px 控制台和 1536px 公开深色截图，操作按钮保持单行。
