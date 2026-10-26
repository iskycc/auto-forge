# 用例详情的执行历史

用例快速预览和完整详情共用执行历史组件与仓储查询。普通 TestNG 与 DDT 用例均按
“每个批次、每个用例的一次最后实际执行”展示，不要求任务批次正常结束，也不要求用例自身处于成功或失败状态。

## 最后实际执行的规则（2026-10-26）

- 只从具有开始时间、结束时间且已经终态的 attempt 中，按物理尝试序号倒序取一条。
  逻辑轮次和同轮基础设施重调度均保留真实编号，不优先选择曾经成功的轮次。
- 正常完成、异常终止、手动结束的批次均适用。实际执行后的成功、失败、超时、取消均可进入历史。
- 用例没有 attempt，或只有未启动的排队、分配、取消、领取超时记录时，不产生历史记录。
  后续未启动的取消或尚未结束的重跑不覆盖上一次已结束的实际执行。
- 历史中的用例状态、轮次、结果、Runner、耗时和日志入口来自同一个选中 attempt，
  避免批次取消后把之前已通过的用例也显示为取消。
- 例如同一任务的 2,000 个用例中，50 个执行了三轮，则各自记录第三轮；其他用例
  分别记录自身最后执行的第一或第二轮。任务当前轮次不替代用例自身轮次。

过滤在数据库分页之前执行。SQLite 与 PostgreSQL 共用参数化 SQL 和 DTO 映射，
一次只读取 `limit + 1` 条记录，沿用按用例、时间和尝试序号的既有索引与游标；
不加载整个任务、全部轮次或其他用例的历史。接口权限、Runner 名称权限和日志授权不变。
诊断重跑批次继续沿用既有隔离规则，不在本次修改中合并进原任务历史。

本变更只调整详情历史读取与说明，不删除或改写执行事实。
执行详情的“总结”轮次、任务通过率、失败分析、最新结果统计和调度继续使用原有口径。
无数据库迁移、配置、依赖或 Runner 协议变更，Lite 不增加外部服务依赖。
已有但被旧筛选规则隐藏的执行记录，在更新后直接可读，无需补写或重新执行。

## 本次验证（2026-10-26）

先添加真实数据库回归，旧查询的两个新场景均失败，确认可复现异常终止后记录丢失。
修复后 133 项检查通过，其中 SQLite/PostgreSQL 共享的调度、完成与历史契约 78 项、
任务统计契约 12 项，另有普通/DDT 应用、详情取数和 Ant Design 使用检查 43 项。
覆盖同一批次不同用例各自的第一/二/三轮、成功后失败、同轮基础设施重调度、
执行后取消、未领取取消、未结束重跑、缺少起止时间、诊断重跑隔离、游标分页和 Runner 名称权限。
手动结束场景实际调用双数据库 `terminateBatch`，确认后续未领取重跑被取消后，之前的实际失败记录仍然保留。

实际执行的检查包括：

```sh
# 临时 PostgreSQL 连接通过 AUTOFORGE_TEST_POSTGRES_URL 传入；测试串行执行。
pnpm exec vitest run \
  packages/db/test/scheduling-refill.integration.test.ts \
  packages/db/test/case-suite-activity.integration.test.ts \
  packages/application/test/manage-case-definitions.test.ts \
  packages/application/test/manage-ddt-cases.test.ts \
  apps/web/src/lib/load-case-detail.test.ts \
  apps/web/src/components/ui-usage.test.ts --maxWorkers=1

# 递归工作区检查由 pnpm typecheck 的第一阶段完成；根 E2E 类型检查单独重跑通过。
pnpm -r --if-present typecheck
pnpm exec tsc --noEmit -p tsconfig.tests.json
pnpm --filter @autoforge/web build
pnpm test:e2e:matrix

# 隔离数据目录、生产 Lite 服务、预装 Chromium，AUTOFORGE_E2E_EXTERNAL_SERVER=1。
pnpm exec playwright test \
  tests/e2e/case-suite-lifecycle.spec.ts tests/e2e/ddt-management.spec.ts \
  --grep='case detail and preview retain|DDT history retains' --workers=1
```

受影响 TypeScript 文件的 Prettier、ESLint 与 `git diff --check` 通过。
两个 Lite Playwright 场景通过：普通用例验证 51 条历史、两处加载更多、日志打开/关闭和空状态；
中文 CaseID 的 DDT 验证异常结束批次的七类最后执行结果，覆盖完整详情、快速预览与真实 HTTP API。
浏览器中的历史状态由共享 fixture 写入真实数据库，不作为真实 Runner 执行验收证据。

实际查看 1024×768、1536×960 的普通用例深浅色详情/预览、DDT 详情/预览以及空状态，
共 13 张截图。说明文字、轮次、结果、按钮和深色可读性正常，没有新增表格变形或页面横向溢出；
窄预览保持原有表格内部横向滚动。证据位于 `/var/tmp/autoforge-last-case-history-20261026/`。
验证命令使用单任务、单 CPU 配额与 4 GiB 内存上限，没有同时启动多个高 CPU 作业。

本次未运行 Full 整套部署、真实 Runner、离线包验收或 2,000 用例压测；
查询语义已通过真实双数据库验证，同批次多用例回归覆盖不同重跑轮次的选择，未改动调度或执行协议。
本次变更随 v1.20.19 交付；发布采用维护者指定的快速路径，不将未运行的标准验收记为通过。

## 历史验证（2026-10-07，旧筛选规则）

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
