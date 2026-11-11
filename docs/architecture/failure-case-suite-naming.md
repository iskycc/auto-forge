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

## 执行快照兼容与失败原因（2026-10-28）

v1.20.24 在批次策略 JSON 中增加 `environmentAddresses`，供状态读取展示实际执行环境；任务配置 schema 仍是严格输入 schema。原复制流程把该批次 JSON 直接按任务输入校验，导致这类新批次在名称建议和创建阶段均被错误拒绝为“请求数据校验失败”，与用例的异常退出结果无关。

复制使用专用的存储快照 schema 接受这一字段，再映射到新任务的 Adapter 环境池；不放宽普通任务 HTTP 输入，不回写源任务。省略该字段的旧批次继续使用对应历史任务版本中的地址，空地址列表与缺少字段分别处理，避免清空旧批次的环境。

当前功能纳入总结范围内全部非 Pass 用例，包含未执行、失败、超时、取消和执行异常；任一次已通过的用例仍遵循现有总结规则。最终轮次的 `TestNG exited with code 143.` 等异常失败不会被排除。其他统计、失败分析和原有重跑筛选保持原规则。

输入校验失败时弹窗展示具体字段和约束；持久配置损坏或不兼容时，API 返回 `CASE_SUITE_EXECUTION_SNAPSHOT_INVALID`（422），标明原任务／执行批次快照、字段和原因，不回传配置值、密钥或堆栈。不可用用例保留完整性保护，并提示首个问题用例及执行记录标识，不静默创建缺少用例的任务。弹窗保留请求编号用于关联诊断，明细限量且在框内滚动。

验证记录：新增回归先在旧实现中复现了环境字段被拒绝的问题。修复后 91 项定向检查通过，包含真实 SQLite／PostgreSQL 的异常末轮、地址复制、旧批次兼容、797 个用例跨页复制、配置错误定位、任务删除历史及事务回滚；两个十万规模压测未在本机重跑。相关 Prettier／ESLint、测试／数据库／worker 类型检查和 Web／worker 生产构建通过。

生产 Lite 的 `terminal execution failures create` Playwright 场景通过，使用真实 HTTP Runner 测试端完成 `PROCESS_INTERRUPTED`（退出码 143）与超时结果；验证真实新批次的默认名称、完整创建、立即执行与失败后重试、权限，以及注入输入／快照错误后的详细反馈。已审查 1024×768、1536×960 深浅色弹窗截图，无溢出或变形。证据目录：`/var/tmp/autoforge-failure-copy-20261028/`。未运行真实业务 JVM、完整 Full 浏览器闭环或发布流程；本变更不需要迁移、配置项或 Runner 升级。

## AI 自动分析批次的配置复制（2026-11-11）

开启“执行后 AI 初析”的批次在 `policy_json` 中另存 `aiAnalysisExecutionId`，用于将自动分析绑定到本次执行；它不是任务配置。此前复制流程没有识别这一内部字段，导致这类批次的名称建议和创建均报“包含当前版本不支持的配置字段”，与失败用例的结果无关。

复制时专用批次快照 schema 校验该标记后将其排除，仅保留 `aiAnalysisAfterCompletion` 开关及原执行配置。新任务执行时由调度入口绑定自己的批次 ID，不复用原批次的自动分析身份；原任务、执行快照和分析记录保持不变。旧批次没有该标记也可正常复制。任务 HTTP 输入仍拒绝这一内部字段，真正不支持的字段仍会被拒绝，但错误明细现在逐项给出字段路径（最多 10 项），不返回字段值。

Lite／Full 共用这一转换，无需迁移、修改配置、清缓存或升级 Runner。

本次先用新增回归在旧实现中复现了 `aiAnalysisExecutionId` 被拒绝。修复后以下定向检查实际通过：

```sh
# 真实 PostgreSQL URL 从本地私密配置注入，不记录凭据。
pnpm exec vitest run \
  packages/db/test/failure-case-suite-source.test.ts \
  packages/db/test/failure-case-suite-copy.integration.test.ts \
  packages/contracts/test/management.test.ts \
  packages/application/test/create-failure-case-suite.test.ts \
  apps/web/src/lib/failure-case-suite-api.test.ts \
  apps/web/src/lib/failure-case-suite-error.test.ts \
  --testNamePattern '^(?!.*100,000).*' --maxWorkers=1 --no-file-parallelism

pnpm --filter @autoforge/contracts typecheck
pnpm --filter @autoforge/db typecheck
pnpm exec tsc --noEmit -p tsconfig.tests.json
pnpm --filter @autoforge/web build
pnpm --filter @autoforge/worker build

# 分别连接准备好的 Lite／Full 生产服务，使用隔离测试库与单个浏览器工作进程。
pnpm exec playwright test tests/e2e/case-suite-lifecycle.spec.ts \
  --grep 'terminal.*(failures|no failures)' --workers=1
pnpm exec playwright test --config playwright.full.config.ts \
  tests/e2e/case-suite-lifecycle.spec.ts \
  --grep 'terminal.*(failures|no failures)' --workers=1
```

Vitest 共 121 项通过，覆盖当前全部批次策略字段、AI 开关、旧快照、非 Pass 成员、源配置不变、权限、事务回滚及未知字段定位；三个十万规模相关检查本机未重跑。变更文件的 Prettier、ESLint 和 `git diff --check` 通过。

Lite／Full 各两个生产 Playwright 场景通过，使用 Runner HTTP 测试端生成失败、超时及未执行结果；验证建议名称、创建任务、创建并立即执行、执行失败后重试、权限和配置错误展示，并确认新执行使用自己的 `aiAnalysisExecutionId`。Full 使用双 Web、独立 Worker 及真实 PostgreSQL／NATS／Redis／MinIO。实际查看 1024×768、1536×960 深浅色截图，弹框层级、换行和按钮边界正常；截图分别位于 `/var/tmp/autoforge-failure-copy-ai-ui`、`/var/tmp/autoforge-failure-copy-ai-full-ui`。未运行真实业务 JVM、外部大模型、完整标准 CI 或发布流程。
