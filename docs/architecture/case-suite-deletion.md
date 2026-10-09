# 删除用例任务

具有所在项目 `case_suite.manage` 权限的用户可以从任务卡片或任务详情的“删除任务”按钮发起删除。确认框说明保留范围，并显示完整任务名。删除请求携带用户审阅时的 `expectedRevision`；任务被其他人修改时返回 `CASE_SUITE_REVISION_CONFLICT`，通过共享冲突弹窗重新加载后再确认。无权限的任务按不存在处理，不泄露其他项目的信息。

删除只移除当前 `CaseSuite`、普通/DDT 成员关系、个人置顶、任务保存的轮次恢复密钥、Webhook 绑定和定时执行计划及其领取租约。普通用例、DDT 用例与共享 Webhook 配置不受影响。该操作不可恢复。

既有 `RunBatch`、`ExecutionRun`、`RunAttempt`、状态事件、日志与公开访问链接、产物、分析任务和结论都保留。不可变任务版本快照也作为执行历史保留，因此仍可从历史批次的最终失败用例创建新任务。历史执行详情隐藏依赖原任务的“再次执行”，日志诊断重跑及基于历史快照的重跑继续使用既有协议与权限。

已经创建的批次独立使用执行快照，删除任务不会取消它们；排队、领取、租约续期、轮次恢复与完成上报沿用现有流程。标准任务执行在写入批次的同一事务内复核任务版本：SQLite 先获得写锁，PostgreSQL 持有任务共享行锁至批次提交。删除与新建执行因而有明确的事务顺序，已删除或已修改的预检快照不能继续创建标准批次。执行计划保存也在事务内检查任务，并在 PostgreSQL 中持有共享行锁，防止删除后重新写入孤立计划。

## 数据迁移与恢复

Lite 使用 `0076_preserve_case_suite_history.sql` 重建任务版本表，完整复制现有字段，仅移除 `suite_id` 对当前任务的级联删除外键；创建者用户的外键和 `(suite_id, version)` 唯一约束保留。Full 使用 `0074_preserve_case_suite_history.sql` 移除对应 PostgreSQL 外键。两者不改变执行表、对象键、运行配置、依赖或 Runner 协议。

升级前按现有运维流程停止写入并备份数据库及对象目录。Lite 重建版本表需要容纳其副本的磁盘空间，迁移期间会持有写锁；Full 变更约束需要短暂表锁。迁移失败会事务回滚，保留旧表、快照及原外键。重试前应解决磁盘或数据库错误。

旧应用可读取迁移后的表，但回退应用版本不会恢复用户已经删除的任务。若需要恢复删除前的数据，应停止写入并恢复对应数据库备份，同时保留配套对象备份；不要重新添加级联删除外键，删除后保留的历史快照可能已没有当前任务行。

## 验证范围

共享 SQLite/PostgreSQL 集成场景验证全新建库、上一版升级、失败 DDL 回滚、删除事务回滚、过期确认、混合普通/DDT 成员清理、定时计划清理、历史数据逐行不变、失败用例复制及事务内执行版本复核。浏览器场景通过真实 Lite 服务验证列表与详情删除、取消与失败重试、并发修改提示、公开日志、执行/分析 Excel 导出、分析清单保留，以及删除后在途日志与完成上报。浏览器使用模拟 Runner 协议客户端，不替代真实 Agent 或 Full 全栈验收；UI 截图覆盖 1024×768、1536×960 的浅色与深色桌面布局。

实际运行的范围如下，数据库命令使用隔离的临时 PostgreSQL，并设置 `AUTOFORGE_TEST_POSTGRES_URL`：

```bash
pnpm exec vitest run \
  apps/web/src/lib/case-suite-delete-api.test.ts \
  packages/application/test/manage-case-suites.test.ts \
  packages/application/test/schedule-run-batches.test.ts \
  packages/application/test/create-failure-case-suite.test.ts \
  apps/web/src/components/ui-usage.test.ts \
  apps/web/src/lib/case-suite-schedule-api.test.ts

pnpm exec vitest run \
  packages/db/test/failure-case-suite-copy.integration.test.ts \
  packages/db/test/case-suite-activity.integration.test.ts \
  packages/db/test/case-suite-pins.integration.test.ts \
  packages/db/test/sqlite-case-suites.integration.test.ts \
  packages/db/test/sqlite-platform-operations.integration.test.ts

pnpm exec vitest run \
  packages/db/test/sqlite-failure-analysis.integration.test.ts \
  packages/db/test/postgres-failure-analysis.integration.test.ts \
  packages/db/test/failure-analysis-history-scope.integration.test.ts \
  packages/db/test/failure-analysis-executions.integration.test.ts

pnpm exec vitest run packages/db/test/failure-case-suite-copy.integration.test.ts \
  -t 'upgrades the previous|deletes configuration|retains analysis|stale deletion|revalidates task'

pnpm exec vitest run packages/db/test/case-debug.integration.test.ts \
  -t 'isolates DDT API|persists formal TestNG'

pnpm exec vitest run \
  apps/web/src/lib/work-dispatch.test.ts \
  apps/web/src/lib/execution-initiator-api.test.ts \
  packages/application/test/schedule-run-batches.test.ts

# 使用隔离的 Lite 数据目录、生产构建服务和预装 Chromium。
pnpm exec playwright test tests/e2e/case-suite-lifecycle.spec.ts \
  --grep 'task deletion preserves|newly created tasks|personal task pins'

pnpm format:check
pnpm lint
pnpm typecheck
pnpm --filter @autoforge/web build
pnpm test:e2e:matrix
git diff --check
```

单元/API 检查 97 项通过；初次任务仓储回归 61 项、分析回归 32 项通过，最终删除契约 10 项在 SQLite/PostgreSQL 下通过，普通/DDT 任务与调试的拉起人回归 4 项通过。仓储回归包含两个数据库各 100,000 条失败用例的任务复制，未改变原有分页能力。重复运行的场景不累计为新增覆盖。

历史详情的真实截图发现拉起人在线程代理中丢失，新增本地/LDAP 操作者的 Lite 批次与 Lite/Full DDT 调度回归，修复前四项均能复现。代理现将操作者和执行输入分别传递，工作线程校验来源与用户名后交给共享应用服务；浏览器检查真实新建批次的操作者快照，并在删除后再次检查详情用户名。

线程传递、身份 API 与调度回归共 70 项通过。Lite Playwright 的删除闭环、新建任务立即删除和原有置顶三项通过；补齐线程传递后，最终生产构建再次通过两项删除场景。已实际查看列表、确认框、历史执行详情和任务详情在 1024×768、1536×960 的深浅色截图，以及删除失败与版本冲突截图。长任务名换行、卡片操作排列、弹窗层级、详情按钮和表格边界正常，无新增变形或页面溢出；截图位于 `/tmp/autoforge-suite-delete-ui`。

格式、Lint、类型检查、Web 生产构建、E2E 矩阵和差异空白检查通过。未运行 Full 整体部署、真实 Agent、真实 LDAP 登录或完整离线发布验收；本次 Full 验证范围是真实 PostgreSQL 适配器与共享线程代理规则。
