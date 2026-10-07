# 用例详情的执行历史

用例快速预览和完整详情共用执行历史组件与仓储查询。普通 TestNG 与 DDT 用例均使用同一历史规则，
每个任务仍只展示一个总结结果：优先选择最新的成功轮次，没有成功则选择最后一次尝试。

记录进入列表必须同时满足：用例自身状态已经成功或失败，终态结果不是取消，
选中的总结尝试处于成功、失败或超时状态，并且具有开始和结束时间。
因此取消、排队、分配、执行中、没有尝试、领取前超时和缺少执行起止时间的记录不会显示。
历史记录缺少完整起止时间时也不会作为已完成记录展示，不推测或补写时间。
任务批次仍在执行不影响其中已经结束的用例进入历史。

先选择总结尝试，再校验其是否执行结束；不会为了显示记录而用更早的失败替代最后一次取消或未完成的尝试。
过滤在数据库分页之前执行，因此不会因当前页包含取消记录而出现空页、错误的加载数量或遗漏更早的有效记录。
SQLite 与 PostgreSQL 共用参数化 SQL 和 DTO 映射，一次只读取 `limit + 1` 条总结记录，沿用原有游标与索引。
接口权限、Runner 名称权限、日志入口及中间轮次归并规则保持原有行为。

本变更只调整用例详情的执行历史读取和说明文字，不删除或改写执行事实。
任务批次和异常诊断保留原始记录，已有公开日志继续可用；分析结论、批次状态、任务调度和最新结果统计不受此过滤影响。
无数据库迁移、配置、依赖或 Runner 协议变更，Lite 不增加外部服务依赖。

## 验证（2026-10-07）

先增加回归检查，确认原实现会返回取消、未执行和进行中的记录，并错误地占据分页窗口。
修复后以下检查通过：

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm --filter @autoforge/web build
pnpm test:e2e:matrix
pnpm exec tsc --noEmit -p tsconfig.tests.json

pnpm exec vitest run \
  packages/application/test/manage-case-definitions.test.ts \
  apps/web/src/lib/load-case-detail.test.ts \
  apps/web/src/components/ui-usage.test.ts \
  apps/web/src/components/ui/table.test.tsx --maxWorkers=2

# 使用临时 PostgreSQL，预先设置 AUTOFORGE_TEST_POSTGRES_URL。
pnpm exec vitest run packages/db/test/scheduling-refill.integration.test.ts --maxWorkers=1

# 使用隔离 Lite 数据目录、已构建的生产服务及预装 Chromium；两个命令分别执行。
export AUTOFORGE_E2E_EXTERNAL_SERVER=1
export AUTOFORGE_E2E_DATA_DIR=/tmp/autoforge-completed-history-e2e-data
export AUTOFORGE_UI_SCREENSHOT_DIR=/tmp/autoforge-completed-history-screens
export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome
pnpm exec playwright test tests/e2e/case-suite-lifecycle.spec.ts --grep 'case detail and preview'
pnpm exec playwright test tests/e2e/ui-layout.spec.ts --grep 'case details keep long metadata'
```

77 项单元/集成检查通过：33 项应用、普通/DDT 详情取数和 Ant Design 表格检查，
44 项真实 SQLite/PostgreSQL 共享回归。覆盖有效结果、取消与非终态、无尝试、缺失起止时间、
结果与状态不一致、总结轮次、诊断重跑隔离、分页、空状态、Runner 名称权限和既有调度/完成行为。
浏览器历史 fixture 同时支持 SQLite 与 PostgreSQL，两条路径均由真实数据库检查验证。

2 项 Lite Playwright 场景通过。过滤场景使用实际导入的用例和历史状态 fixture，
真实页面和 HTTP 接口验证 51 条已完成结果、7 类被过滤状态、两处加载更多、取消后空状态和日志打开/关闭。
原有长元数据、长任务名、长 Runner 名称、版本快照、编辑与分享场景也通过回归。
这些浏览器状态 fixture 不作为真实 Runner 执行验收证据。

已实际查看 1024×768、1536×960 深浅色完整详情和快速预览表格，以及空状态和原有长内容截图。
表格列宽、文字截断/换行、按钮、分页、深色可读性与滚动边界正常，没有新增变形或页面横向溢出；
窄预览区继续使用表格内部横向滚动。截图保存在 `/tmp/autoforge-completed-history-screens`。

本地未运行 Full 整体部署、真实 Runner、离线发布物或高规模压测。
本次验证已经覆盖真实 PostgreSQL 查询语义；完整高资源验收按仓库规定由既有 GitHub Actions 执行。
