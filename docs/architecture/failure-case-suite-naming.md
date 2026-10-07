# 失败用例创建任务的默认名称

弹框默认使用执行快照中的任务名称，加上平台时区当天的 ` Rerun-YYYYMMDD`。
例如“回归任务 Rerun-20261007”。同一项目版本内已有同名任务时，追加序号 `01`、`02`；
按现有最大序号递增，超过 `99` 继续使用 `100`。已归档任务也参与判重，其他项目版本互不影响。
名称最多 120 个 UTF-16 单元；必要时仅截短原任务名，避免截断代理对，保留完整日期和序号。

`GET /api/v1/run-batches/{batchId}/failure-case-suite` 返回建议名称，需要该项目的执行读取和任务管理权限，
响应禁用缓存。`POST` 可省略 `name`，由服务端按创建时的日期分配默认名称；显式提交名称则沿用自定义名称行为。
弹框保留两个创建按钮，名称查询的迟到响应不会覆盖已输入内容；查询失败时可手动填写名称继续创建。

建议名称不预占任务。SQLite 在已有的立即写事务内重新计算；PostgreSQL 在复制事务内通过项目版本范围的
事务咨询锁串行分配。判重每页仅读取最多 500 条名称，领域规则只保留基础名称占用情况和最大序号，
不读取任务成员。最终名称写入任务及版本快照；立即执行失败后的重试沿用已创建任务和最终名称。
本变更无需数据库迁移、配置、依赖或 Runner 升级，不改变用例范围、配置复制和执行调度。

## 验证（2026-10-07）

以下检查实际通过：

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm --filter @autoforge/web build

pnpm exec vitest run \
  packages/domain/test/failure-case-suite-name.test.ts \
  packages/application/test/create-failure-case-suite.test.ts \
  packages/contracts/test/management.test.ts \
  apps/web/src/lib/failure-case-suite-api.test.ts \
  apps/web/src/components/ui-usage.test.ts --maxWorkers=2

pnpm exec vitest run \
  packages/application/test/manage-case-suites.test.ts \
  packages/db/test/sqlite-case-suites.integration.test.ts --maxWorkers=2

# 使用临时 PostgreSQL，预先设置 AUTOFORGE_TEST_POSTGRES_URL。
pnpm exec vitest run packages/db/test/failure-case-suite-copy.integration.test.ts \
  --testNamePattern '^(?!.*creates a task from 100,000 failures).*' --maxWorkers=2

# 使用隔离的 Lite 数据目录、已构建的生产服务和预装 Chromium。
AUTOFORGE_E2E_EXTERNAL_SERVER=1 \
AUTOFORGE_E2E_DATA_DIR=/tmp/autoforge-rerun-name-e2e-data \
AUTOFORGE_UI_SCREENSHOT_DIR=/tmp/autoforge-rerun-name-screens \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome \
pnpm exec playwright test tests/e2e/case-suite-lifecycle.spec.ts \
  --grep 'terminal execution failures'
```

共 96 项不同的单元/集成检查（59 项命名、契约、API 与组件规范，29 项既有任务规则与 SQLite 生命周期，
8 项真实 SQLite/PostgreSQL 失败任务复制）及 1 项 Lite Playwright 场景。
覆盖日期跨天、序号递增及超过 99、长名称、特殊字符、501 条名称跨页查询、归档及版本边界、
四个同时创建请求、执行后原任务改名、自定义名称、无权限、旧弹框建议失效、迟到响应、名称查询失败、
两个创建按钮和立即执行失败后的幂等重试。

已实际查看 1024×768、1536×960 深浅色弹框截图，以及 1536×960 立即执行失败状态截图。
弹框层级、对齐、间距、文字换行、按钮及滚动边界正常，无新增变形或页面溢出。
截图保存在 `/tmp/autoforge-rerun-name-screens`。

本地未运行十万成员复制压测、Full 完整部署、真实 Runner 或离线发布验收。
本次真实 PostgreSQL 测试覆盖命名的适配器语义；完整高资源验收按仓库规定由 GitHub Actions 执行。
