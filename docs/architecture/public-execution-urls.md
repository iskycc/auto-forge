# 执行公开地址

用例日志与执行详情使用固定业务路径，不再签发随机日志令牌或带签名串的执行详情路径：

| 页面 | 地址 | 定位语义 |
| --- | --- | --- |
| 用例执行日志 | `/CaseLog?ExecutionId=<attemptId>` | `ExecutionId` 是已有 `RunAttempt.id`，精确定位一次实际执行 |
| 日志中的其他轮次或诊断重跑 | `/CaseLog?ExecutionId=<anchorAttemptId>&AttemptId=<selectedAttemptId>` | 保留公开授权锚点，仅选择同一用例执行族中的结果 |
| 执行详情 | `/Execution?BatchId=<batchId>` | `BatchId` 是已有 `RunBatch.id`；轮次选择继续保存在 `round` 查询参数 |

用例定义 ID 不能区分同一用例在不同批次、轮次或诊断重跑中的日志，因此日志入口使用实际执行 ID。同一记录的地址固定，重复复制或导出不会创建新的随机串。

## 公开授权

业务 ID 只负责定位；资源必须已经显式公开才能匿名访问。日志公开按钮、执行详情公开按钮、结果/分析 Excel 导出、Jenkins 创建执行和分析重跑证明分别沿用原有登录、项目权限和审计规则，持久化对应公开授权。

- 公开日志授予该实际执行及同用例轮次/诊断重跑历史的只读访问。
- 公开执行详情授予该批次概览、分页用例、轮次、异常原因及其日志的只读访问。
- 单个日志或日志导出不会顺带公开整个批次，也不会公开其他批次。
- 匿名页面不能取消或重跑；日志中的执行操作仍要求已登录且具有相应项目权限。
- 匿名详情不序列化隐藏执行配置、任务密文或拉起人账号。详情刷新、筛选、分页和异常原因导出均校验同一批次的公开授权。
- 日志首屏仍有 512 KiB 上限；执行视图保留有界读取隔离，Excel 保留每页 200 条的流式导出。
- `/CaseLog` 的 GET/HEAD 请求与旧日志页、日志读取 API 共用原有并发预算；匹配只包含精确页面路径，不占用心跳、续租或日志上传的控制容量。

公开授权永久保留，不依赖缓存或部署主密钥。资源删除时外键级联清理相应授权。公开地址不是秘密凭据，已经公开的资源可由知道其业务 ID 的访问者只读访问。

## 升级与旧地址

SQLite 新增 `0079_public_execution_access.sql`，PostgreSQL 新增 `0077_public_execution_access.sql`，创建 `public_batch_access` 和 `public_attempt_access`。两种模式共用应用服务与访问契约；不需要外部服务、配置项或 Runner 协议升级。重复写入保留首次公开者和 UTC 创建时间。

升级不改写旧 `attempt_log_shares`，也不自动公开历史批次或实际执行。已有 `/share/attempt-log/<token>`、`/share/run/<token>` 及其日志子路径仍按原哈希、签名、有效期和同用例边界读取。旧页中的历史导航保留原授权；历史分析证明中保存的旧地址也继续有效。

现有生成 API 保留路径和 `shareUrl` / `resultUrl` 响应字段，以兼容浏览器和 Jenkins 客户端，但新返回值统一使用业务路径。旧令牌格式仅用于读取兼容及测试夹具，不再用于生产链接生成。用例资产详情的公开地址及旧版临时进度地址不属于本次执行页面路径调整。

部署前备份数据库并停止写入，随后按现有迁移流程升级。两个建表语句在迁移事务中执行，失败时整份迁移回滚，修复原因后可重新运行；旧数据和链接不受失败迁移影响。回退旧版本时保留新增表即可，旧服务不会读取它们。升级后新生成的业务地址需要本版本及其公开授权表才能访问。

## 验证记录（2026-10-10）

下列检查已经实际执行并通过。重型检查串行运行，Vitest 和 Playwright 使用一个工作进程；浏览器复用生产构建，结束后先关闭服务，再运行导出性能检查。

| 范围 | 结果 |
| --- | --- |
| 单元、应用和 HTTP 回归 | 223 个文件、1,313 项 TypeScript 测试通过，Go Agent 测试和 63 项脚本检查通过；GET/HEAD 回归同时验证新旧页共用读取预算、控制请求放行及释放幂等 |
| SQLite / PostgreSQL | 7 个文件、55 项测试通过，包含公开授权共享契约、重复/并发公开、外键与批量回滚、新建库、旧版升级、失败迁移回滚和有界日志投影 |
| Lite 浏览器闭环 | 9 项定向 Playwright 场景通过，包含新旧链接、轮次与诊断重跑、Jenkins、匿名访问边界、异常原因 Excel、分析复制与重跑证明、任务删除后历史日志、表格列宽 |
| 五万行导出 | 实际生成 50,000 行 Excel，行构建、公开授权和表格生成共 8.64 秒；读取生成文件验证表头、行数和日志链接列 |
| 质量与构建 | 格式、许可证、Lint、工作区及测试类型检查、Agent 资源与 Web/Worker 生产构建通过；按钮文案收紧后重新构建 Web 及其服务端读取进程；E2E 矩阵的 18 项覆盖行校验通过 |

执行命令包括：

```bash
pnpm format:check
pnpm lint
pnpm -r --workspace-concurrency=1 --if-present typecheck
pnpm exec tsc --noEmit -p tsconfig.tests.json
pnpm exec vitest run --maxWorkers=1 --no-file-parallelism --exclude '**/*.integration.test.ts'
go -C apps/runner-agent test ./...
node --test --test-concurrency=1 scripts/release/*.test.mjs scripts/operations/*.test.mjs scripts/quality/*.test.mjs
pnpm build
pnpm --filter @autoforge/web build
pnpm exec vitest run --config vitest.performance.config.ts tests/performance/export-load.test.ts --maxWorkers=1 --no-file-parallelism
pnpm test:e2e:matrix
```

双数据库检查将 `AUTOFORGE_TEST_POSTGRES_URL` 指向本地临时 PostgreSQL 测试库，并使用以下测试文件，PostgreSQL 场景未跳过：

```bash
pnpm exec vitest run \
  packages/db/test/sqlite-attempt-log-share.integration.test.ts \
  packages/db/test/postgres-attempt-log-share.integration.test.ts \
  packages/db/test/public-execution-access-migration.integration.test.ts \
  packages/db/test/attempt-log-snapshot.integration.test.ts \
  packages/application/test/public-execution-access.test.ts \
  packages/application/test/attempt-log-shares.test.ts \
  apps/web/src/lib/execution-public-access.test.ts
```

浏览器检查使用临时 Lite 数据目录、`AUTOFORGE_E2E_EXTERNAL_SERVER=1` 和 `AUTOFORGE_UI_SCREENSHOT_DIR`，按下列两组串行执行：

```bash
pnpm exec playwright test tests/e2e/all-rounds.spec.ts tests/e2e/jar-import.spec.ts --grep 'all-rounds virtual round|imports TestNG methods from a JAR into the case library' --workers=1
pnpm exec playwright test tests/e2e/failure-analysis.spec.ts tests/e2e/ui-layout.spec.ts tests/e2e/execution-recovery.spec.ts tests/e2e/case-suite-lifecycle.spec.ts --grep 'terminal task failures support durable single and batch analysis with evidence|long case names keep single, bulk and completed analysis dialogs within their width|execution case actions stay on one line in console and shared details|execution record actions stay on one line after sharing and resizing saved columns|anonymous execution details keep tables and actions within the page|execution exceptions reveal unstarted timeouts and distinguish normal test failures|task deletion preserves history, public logs, analysis and in-flight execution with reviewable confirmations' --workers=1
```

实际查看了 1024×768、1536×960 的公开日志、执行详情、执行列表和用例操作截图，覆盖浅色与深色。长日志保持在面板内，按钮单行且没有新增溢出；执行列表使用紧凑的“公开 / 复制地址”文案，1024px 下“执行异常”悬浮入口保持可访问。截图保存在本机临时目录 `/tmp/autoforge-public-links-ui`，不包含在发布物中。

本次未运行 Full 整体部署、真实 Java Agent 或重新制作离线发布包：变更没有修改执行协议或 Agent；Full 的数据库语义由真实 PostgreSQL 契约与迁移检查覆盖，完整发布和离线包验收仍需在发布时执行。
