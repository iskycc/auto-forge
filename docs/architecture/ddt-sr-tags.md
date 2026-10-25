# DDT SR 标签

SR 标签是独立的业务分组，不参与 SR 测试类关联、需求分类或执行类预检。标签按项目和版本隔离；同一版本中，忽略首尾空白和大小写的同名 SR 在所有测试阶段共用标签。一个 SR 可以拥有多个标签。DDT 管理页的“SR 标签”入口可新建标签、搜索 SR、添加和移除关联；修改自动保存，移除关联不删除用例或执行记录。同版本中同名标签（忽略首尾空白和大小写）复用已有标签。

任务详情在 DDT 的 SR 分组旁显示标签。点击分组旁的标签，即可勾选本任务中所有带该标签的 SR 及其用例，无需先展开分组；支持鼠标和键盘，不触发分组展开。也可以在“按标签勾选 SR”区域选择多个标签：

- “勾选带标签的 SR”勾选本任务中至少命中一个所选标签的全部 SR 及其 DDT 用例。
- “勾选不带标签的 SR”勾选本任务中没有命中任何所选标签的全部 SR 及其 DDT 用例，也包括完全未打标签的 SR。

选择完成后显示已勾选的 SR 分组数及 DDT 用例数，分组复选框与用例复选框同步更新；任务中跨阶段的同名 SR 均参与匹配。选择只替换 DDT 用例的勾选，不改变普通用例的勾选，不立即添加、移除或执行用例。后续批量移除沿用原确认流程。取消或分页失败时不应用部分选择。任务版本发生变化时中止收集，要求刷新后重试。其他浏览器修改 SR 标签后需刷新页面以读取最新标签。

## 存储与性能

Lite/Full 共享应用服务和 SQL 语义，分别使用 SQLite/PostgreSQL 适配器。`ddt_sr_tags` 保存版本标签，`ddt_sr_tag_assignments` 保存 SR 与标签的关联；复合外键防止跨版本关联。新建和单个关联变更都是原子、可重复的短 SQL，不执行网络或子进程操作。不同标签的并发修改不会覆盖彼此。版本完整复制会复制标签并改写标签 ID，目标版本只有标签时也不视为空版本；普通 DDT 用例继承不改动目标版本标签。

SR 管理每页 20 个分组，标签选项按游标读取；任务标签元数据每次最多查询 40 个 SR。任务选择先从成员索引读取最多 201 条轻量候选，再匹配标签，每页至多推进 200 个成员；即使标签不存在于大量成员中，也不在单次请求中扫描整个任务。空匹配页仍提供后续游标。整个过程不读取用例 JSON、attempt 或日志，不依赖 Redis、队列或 Runner Agent。超过单次元数据读取的 3,200 个标签关联时明确报错，不静默省略。任务成员选择维持至少 100,000 条能力。

## 权限与 API

- `GET /api/v1/ddt/sr-tags?projectId=…&projectVersionId=…`：`case.read`；游标查询标签。`view=groups` 查询版本 SR，`view=lookup&srNum=…` 批量读取标签。
- `POST` 同一路径：`case.manage`、同源校验和操作审计。`operation=create` 携带 `name`；`operation=assign` 携带 `tagId`、`srNum`、`assigned`。
- `GET /api/v1/case-suites/{suiteId}/sr-tags`：按任务 `case_suite.read` 权限，从任务推导项目版本；标签/lookup 查询同上。`view=members&tagId=…&match=include|exclude&revision=…` 分页读取本任务的匹配用例 ID。缺失或其他版本的标签明确拒绝，防止反选误覆盖所有成员。

时间仍保存为 UTC，不涉及对象、执行任务、调度协议或离线依赖变化。

## 升级与恢复

SQLite `0082_ddt_sr_tags.sql`、PostgreSQL `0080_ddt_sr_tags.sql` 仅新增表和索引，不回填或改写现有用例、分类和执行类关联。由现有事务迁移器执行；失败回滚后可修复原因并重启重试。升级前按运维流程备份数据库。回滚到旧版本优先恢复升级前备份，不手工修改迁移历史或在运行中的数据库删除表。完整版本副本应使用支持 SR 标签的版本读取与恢复。

## 两列表格导入和分类导出

“SR 标签”弹窗提供“导入分类”“导出分类”“下载模板”。首行为表头，第一列为 `SR`，第二列为 `标签`；标签表头也接受 `Tag`、`Tags`、`标签名称`，SR 表头也接受 `srNum`，忽略大小写、BOM 和首尾空白。所有非空工作表均按同一规则校验；不按用例表格的 CaseID 去重，也不把表头当作关联。

同一个 SR 可以多行对应不同标签；同一标签也可用于不同 SR。只有相同 SR 与相同标签的组合重复才报错，忽略大小写和首尾空白，并指出本行与首次出现的工作表、行号。单元格只填写一个完整标签名，不按逗号拆分。空白行跳过，半空行、非空第三列、公式或控制字符报错；缺少或颠倒表头明确拒绝。Excel 格式化的数字和 CSV 数字文本保留前导零。

导入先预览，最多展示 50 条样例和 100 项问题；发现任何问题均禁止写入。未知 SR 必须先在当前项目版本导入相应 DDT 用例。确认时重新读取同一文件并校验，再以每批 100 行的短事务追加关联；自动创建缺失标签、复用同名标签和已有组合，保留其他关联。失败时报告已完成行数和新增关联数，可重新导入恢复；每一批验证与写入是原子的，不把十万行放入一个长事务。预览不写数据库，正式导入前后记录操作审计。文件上限 16 MiB、100,000 行，解析在既有后台解析工作线程执行；Lite/Full 使用同一解析与应用逻辑。

“导出分类”按游标读取当前版本的全部已保存关联，不受搜索条件影响，只输出 `SR`、`标签` 两列；一个关联一行，因此 SR 可以重复。未打标签的 SR 不生成空标签行。用例已移除但保留的 SR 关联仍导出，其 SR 没有活动用例时使用规范化标识。模板只包含表头，填写后可导入；分类导出文件在单次导入限制内也能直接再次导入，已有组合不会重复创建。导出使用统一 Excel 样式、各列独立有界宽度、文本单元格、冻结表头和筛选；分页流式写入临时文件，完成工作簿后再下载，防止异常时提供半个文件。

接口为 `POST /api/v1/ddt/sr-tags/import?action=preview|import` 和 `GET /api/v1/ddt/sr-tags/export?template=0|1`，均携带项目和版本。前者要求 `case.manage`，使用 multipart 的 `file`；后者要求 `case.read`。导出文件名使用版本名称、SR 标签清单用途和平台时区时间，无新依赖、配置或迁移。

## 本次验证（2026-10-24）

所有构建、测试和浏览器任务串行运行，并设置 1 CPU、4 GiB 资源上限。

- `AUTOFORGE_TEST_POSTGRES_URL=<临时数据库> pnpm exec vitest run packages/db/test/ddt-sr-tags.integration.test.ts packages/db/test/project-version-copy.integration.test.ts apps/web/src/lib/suite-sr-tag-selection.test.ts --maxWorkers=1`：33 项通过；两项原有十万成员完整复制规模测试未启用。SQLite/PostgreSQL 均实际执行，覆盖新建库、上一版本升级、版本隔离、跨阶段共享、多标签并发增删、幂等、游标空匹配页、仅选本任务成员、复制保留标签及目标占用保护。
- `pnpm exec vitest run apps/web/src/components/ui-usage.test.ts packages/application/src/project-version-copy-records.test.ts --maxWorkers=1`：共享组件及版本复制边界检查。
- `pnpm --workspace-concurrency=1 -r --if-present typecheck`、`pnpm exec tsc --noEmit -p tsconfig.tests.json`、变更文件 Prettier/ESLint、`pnpm --filter @autoforge/web build`：格式、类型、静态检查及生产构建。
- 生产构建上的 Playwright：`ddt-management.spec.ts --grep 'independent SR tags persist'` 和 `ddt-management.spec.ts tab-navigation.spec.ts --grep 'DDT SR category filters union labels|DDT subtabs keep opaque'`，全部 `--workers=1`，共 3 项通过。

新增功能的浏览器场景包含真实表格导入、页面创建/关联标签、跨阶段同名 SR 共用、混合任务勾选、匹配/反选、实际移除反选的 DDT 成员及刷新后标签保留。已实际查看 SR 标签弹窗和任务详情在 1024×768、1536×960 下的六张截图，以及 DDT 管理工具栏的最小桌面/大屏回归截图；任务详情覆盖浅色与深色。标签、按钮和计数对齐，无横向溢出或布局变形。

本次未运行整仓测试、Full 全栈浏览器矩阵和完整离线验收；未改变 Runner、队列、对象存储或离线依赖。Full 的对应数据库适配器与升级路径已通过真实 PostgreSQL 验证。

## 表格导入／导出补充验证（2026-10-24）

`AUTOFORGE_TEST_POSTGRES_URL=<临时数据库> pnpm exec vitest run packages/ddt-import/test packages/db/test/ddt-sr-tags.integration.test.ts packages/application/src/import-ddt-sr-tags.test.ts apps/web/src/lib/sr-tag-export.test.ts apps/web/src/components/ui-usage.test.ts --maxWorkers=1`：62 项通过，SQLite 和 PostgreSQL 均实际运行。包括原 DDT 解析及冲突列回归、首行识别、跨工作表重复组合、空行与缺失字段、额外列、公式、前导零、未知 SR、分批与中断进度、已有关联复用、完整分页导出。两种数据库均在插入标签后注入关联写入故障，确认整批回滚，不残留新标签。

Web 生产构建、Web/服务入口/工作线程及测试 TypeScript、变更文件 Prettier/ESLint 与差异检查通过。构建、检查和浏览器均串行运行，并限制为 1 CPU、4 GiB；本次没有新增生产依赖或数据库迁移。

生产 Lite 的 `playwright test tests/e2e/ddt-management.spec.ts --grep 'SR tag spreadsheets validate' --workers=1` 通过：从真实模板下载、错误表头、重复组合、未知 SR 校验，到新增 3 条关联、导出全部分类、再次导入新增 0 条/复用 3 条。另通过直接 HTTP 提交重复文件，确认后端返回 `SR_TAG_IMPORT_INVALID` 且没有写入；原标签跨阶段共享、任务匹配／反选和混合任务移除的 E2E 也已回归通过。

实际查看了 1024×768、1536×960 的八张最终截图，覆盖重复问题、合法预览、导入成功和深色预览。小屏表格滚动高度跟随视口，成功提示及底部分页可完整显示，嵌套弹窗、列宽、换行和按钮对齐正常。

实际下载的模板及分类工作簿经 ExcelJS 回读、ZIP CRC/XML 检查，并通过 LibreOffice Calc 重新保存和回读对比；模板 2 个非空表头单元格、分类文件 8 个非空单元格均完整一致，只有 SR、标签两列。未使用 Microsoft Excel 桌面客户端；未运行整仓测试、Full 全栈浏览器或完整离线部署验收。数据库适配器和已有 DDT 表格解析已完成对应定向回归。

## 任务详情直接勾选 SR 验证（2026-10-24）

任务详情的标签由只读显示增加直接勾选入口，与工具栏共用同一分页收集逻辑。选择进度仅在工具栏更新，不逐页重新渲染任务树；重复点击在请求期间拒绝，任务 revision 改变时中止收集。无接口、数据库、执行协议或权限范围变化，Lite/Full 共用前端行为。

先在旧生产构建补充 Playwright 回归，因缺少直接勾选标签按钮失败。实现后 UI 规范检查发现紧凑按钮只有 18px 高度，调整为共享主题规定的 32px，不放宽检查。最终 `pnpm exec playwright test tests/e2e/ddt-management.spec.ts --grep 'independent SR tags persist' --workers=1` 通过：同一标签关联两个不同 SR，另一个测试阶段复用同名 SR，点击后勾选三个折叠分组共四个 DDT 用例；验证工具栏匹配／反选、键盘 Enter、普通用例保持勾选，以及实际移除反选的两个用例后刷新。

已实际查看 1024×768、1536×960 深浅色下匹配和反选的八张结果截图，按钮点击区域、文字、计数、行对齐及边界正常，无新增布局变形。选择分页及 Ant Design 定向检查 20 项通过；变更文件 Prettier/ESLint、测试 TypeScript 和 Web 生产构建通过。全部重负载任务串行限制 1 CPU、4 GiB，日志、失败复现及截图位于 `/var/tmp/autoforge-suite-sr-selection-20261024/`。本轮只修改共享前端，未重跑双数据库集成、Full 全栈、真实 Runner 或完整离线部署验收。
