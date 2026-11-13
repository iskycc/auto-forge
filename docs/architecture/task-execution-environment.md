# 任务执行环境 IP

任务默认环境保存在版本化任务配置中。任务列表、任务详情和“开始执行”弹窗允许有项目 `run.create` 权限的用户设置下一次手动执行的环境 IP；任务锁定不限制这项操作。

## 下一次执行设置

- 任务卡片的“环境 IP”和详情的“修改下次执行 IP”打开同一个列表弹窗；全局“开始执行”弹窗展示当前任务的完整地址，也可直接修改。工作台弹窗和公开任务页的执行环境展示统一标为“本次执行环境 IP”，工作台修改按钮标为“修改本次执行环境 IP”，任务列表和详情等执行前设置位置继续标为“下次”，保持同一地址草稿和提交规则。
- 地址以用户与任务 ID 隔离，仅在当前浏览器页面的内存中保存；站内导航和打开／关闭执行弹窗保留设置，刷新页面恢复任务默认。任务切换不复用另一任务的设置，其他用户、浏览器和计划执行不受影响。
- 立即执行和倒计时执行都把自定义地址提交给预检和创建接口。成功创建批次后消费该设置，下次恢复任务默认；关闭弹窗、预检失败和提交失败保留设置，允许重试。“恢复任务默认”可主动清除。
- 接口为 `POST /api/v1/run-batches/preflight` 与 `POST /api/v1/run-batches` 的可选 `environmentAddresses` 数组。只允许 1–128 个互不重复的 IPv4／IPv6，未启用 Adapter 时拒绝覆盖；其他执行策略、参数或锁定身份仍不可通过此入口覆盖。
- 覆盖只写入新批次的 Adapter 快照；不修改任务默认地址、成员、版本或修订号，不影响已创建或正在执行的批次。确认请求时保留其地址版本，较早请求完成不会清除提交期间的新设置。

## 任务配置与多地址编辑

任务配置中的“环境 IP / 地址”展示地址标签，点击“修改环境 IP”后逐项编辑，随后仍需“保存任务配置”才能持久生效。只有锁定人且具有任务管理权限时可修改已锁定任务的默认地址。只读详情单独提供下一次执行设置，不能提交任务配置变更。

创建任务、任务配置、单用例快捷执行、用例调试和公开任务页统一采用 Ant Design 列表弹窗：一个输入框一个地址，支持添加、删除、序号、128 条上限和重复／空值提示。弹窗主体滚动，标题和操作栏保持可见，取消不应用草稿。既有任务、调试和单用例配置仍兼容历史主机名／URL 地址；新的任务临时覆盖和公开任务临时覆盖要求字面 IP。

公开任务页面按同一任务和分享人（同一公开链接）持久共享最新 IP，显示修改人和时间；刷新、重新打开或另一用户访问均继续使用，直到再次修改或恢复任务配置。该设置不修改任务默认配置。公开日志页的单用例重跑仍只接受一个 IP，保留其原有页面设置规则。

## Lite／Full 与恢复

两种模式共用 HTTP 契约、权限、应用服务和 UI。Lite 将批次快照写入 SQLite 后通过持久队列继续派发；Full 在 PostgreSQL 中保存快照并由 outbox／NATS 继续调度。后台临时页面设置不依赖 Redis 或队列；公开链接的共享设置由数据库持久化为业务事实；批次一旦创建，其 IP 即由数据库快照恢复，刷新、重启或倒计时等待不会丢失。对象存储及 Runner 协议无变化，无新增配置或依赖。共享设置新增 SQLite `0101_public_suite_environment.sql`、PostgreSQL `0100_public_suite_environment.sql`，在链接行保存一个带 schemaVersion 的最新修改记录和递增修订号；旧链接升级后从任务默认值开始。回滚应恢复升级前备份，不直接删除生产列。

## 验证记录（2026-11-12）

新增契约和 API 回归先在旧实现复现了临时 IP 被拒绝的问题。任务默认地址的取消回归也在修复前复现了外层“未保存”误提示：弹窗通过 Portal 显示，草稿输入事件仍会冒泡到任务表单。现在隔离草稿事件，只在确认后应用地址并标记任务待保存。

222 项定向回归通过，包含真实 SQLite／PostgreSQL、任务创建与公开执行、日志重跑、地址列表边界、临时设置的用户／任务隔离和迟到提交保护：

```sh
# PostgreSQL 测试地址从本机私密配置注入，双库夹具使用隔离 schema。
pnpm exec vitest run \
  packages/contracts/test/scheduling.test.ts \
  packages/contracts/src/public-suite-execution.test.ts \
  packages/application/test/schedule-run-batches.test.ts \
  packages/application/test/public-suite-execution.test.ts \
  packages/application/test/rerun-run-batches.test.ts \
  packages/db/test/attempt-log-snapshot.integration.test.ts \
  packages/db/test/public-suite-execution.integration.test.ts \
  apps/web/src/lib/public-suite-execution-api.test.ts \
  apps/web/src/lib/run-batch-creation-api.test.ts \
  apps/web/src/lib/suite-execution-environment.test.ts \
  apps/web/src/components/ui-usage.test.ts \
  --maxWorkers=1 --no-file-parallelism
```

生产 Lite 的用例调试、公开任务、锁定任务、列表／详情快捷执行和单用例执行五个场景分次通过；最终构建再次通过锁定任务完整场景。生产 Full 使用双 Web、Worker 和真实 PostgreSQL／NATS／Redis／MinIO，同次运行公开任务、锁定任务、列表／详情快捷执行和单用例执行四个场景全部通过。

```sh
# 对准备好的 Lite 生产服务运行，修复过程中分次取得各场景的通过记录。
pnpm exec playwright test tests/e2e/case-suite-lifecycle.spec.ts \
  tests/e2e/case-debug.spec.ts tests/e2e/single-case-run.spec.ts \
  --grep 'public task links execute|locked tasks allow one-execution|task list and detail execution shortcuts|global execution dialog schedules|debug workspace imports' \
  --workers=1

pnpm exec playwright test --config playwright.full.config.ts \
  tests/e2e/case-suite-lifecycle.spec.ts tests/e2e/single-case-run.spec.ts \
  --grep 'public task links execute|locked tasks allow one-execution|task list and detail execution shortcuts|global execution dialog schedules' \
  --workers=1
```

锁定场景验证维护人通过弹窗保存默认地址、编辑取消不误报修改、其他用户的配置写入仍被拒绝；列表设置与详情／全局执行框互通，关闭弹窗、预检失败和提交失败均保留临时地址，立即／倒计时成功后消费，后续执行恢复默认。通过 Runner HTTP 领取实际规格核对 IPv4／IPv6 下发，确认任务默认地址、锁定人及修订号不被临时执行改写；还覆盖后续关闭 Adapter 时忽略旧草稿、页面刷新复原及嵌套弹窗 Escape 只关闭当前层。

实际查看 Lite／Full 在 1024×768、1536×960 的浅深色截图，检查任务卡片、详情 IP 区、执行弹窗、默认 IP 编辑与嵌套编辑框；地址、序号、增删按钮和页脚对齐正常，无新增横向溢出或布局变形。截图目录为本机 `/var/tmp/autoforge-suite-ip-ui`、`/var/tmp/autoforge-suite-ip-final-ui` 和 `/var/tmp/autoforge-suite-ip-full-ui`。

相关格式、ESLint、Web／测试类型、19 行 E2E 覆盖矩阵和 Web／Worker 生产构建通过。Full 使用同版本 Web／Worker。未新增数据库迁移、生产依赖或配置；未运行完整标准 CI、真实业务 JVM、外部 Jenkins、十万规模压力和完整离线发布物验收，浏览器的实际下发验证使用测试 Runner。

## 执行入口文案验证（2026-11-12）

工作台“开始执行”弹窗及其 IP 编辑弹窗使用“本次执行环境 IP”，任务列表／详情的预先设置继续使用“下次”；公开任务页的执行环境标题也使用“本次”。地址草稿、锁定任务的执行权限、成功后消费和取消／失败保留的规则保持一致。

相关 Prettier、ESLint、Web／E2E 类型检查和 Web 生产构建通过，19 项定向测试通过。Lite／Full 各通过公开任务、锁定任务的执行环境、已删除 Agent 提醒三个 E2E 场景；Full 使用双 Web、一个 Worker 和真实 PostgreSQL／Redis／NATS／MinIO。实际查看 1024×768、1536×960 深浅色截图，入口文字、按钮和嵌套弹窗无溢出或错位。该阶段验证了入口文字和空提醒隐藏；下节补充共享修改记录的实现与验证。

```sh
pnpm exec vitest run apps/web/src/lib/suite-execution-environment.test.ts apps/web/src/components/ui-usage.test.ts --maxWorkers=1 --no-file-parallelism
pnpm --filter @autoforge/web typecheck
pnpm exec tsc --noEmit -p tsconfig.tests.json
pnpm --filter @autoforge/web build
pnpm exec playwright test tests/e2e/case-suite-lifecycle.spec.ts tests/e2e/runner-telemetry.spec.ts --grep 'public task links execute|locked tasks allow one-execution|deleted Agents remain rejected' --workers=1
pnpm exec playwright test --config playwright.full.config.ts tests/e2e/case-suite-lifecycle.spec.ts tests/e2e/runner-telemetry.spec.ts --grep 'public task links execute|locked tasks allow one-execution|deleted Agents remain rejected' --workers=1
```

## 公开链接共享 IP（2026-11-13）

- `GET /api/v1/public/case-suites/:suiteId?PublisherId=…` 返回任务默认 `environmentAddresses` 与共享 `environment`（修订号、最新地址、修改人及 UTC 时间）。匿名用户可读；同一链接的不同浏览器及 Full Web 实例读取同一持久化记录，沿用可见页面每 5 秒轮询。
- `PUT /api/v1/public/case-suites/:suiteId/environment?PublisherId=…` 接收 `{revision,addresses}`；`addresses:null` 恢复任务默认。需个人账号登录、同源和限流，不要求项目执行权限，不受任务锁定人限制；停用、归档、无效链接与未启用 Adapter 时拒绝。修改人来自登录会话，不能由请求伪造。每次成功只更新一个最新记录，并登记操作审计。
- 页面展示“本次执行将使用以上 IP”和最新修改人、时间。编辑保留打开时修订号；并发修改返回 `PUBLIC_SUITE_ENVIRONMENT_REVISION_CONFLICT`，保留草稿并通过统一冲突弹窗提示重新加载，禁止静默覆盖。
- 立即／倒计时执行提交所见修订号，应用服务读取共享地址，批次创建事务再次校验修订号。Full 锁住链接行到快照提交；Lite 依靠 SQLite 写事务序列化。变更前已接受的请求幂等重放仍返回原批次，修改不会影响已创建执行。
- 执行详情分别展示分享人、实际拉起人及环境 IP 修改人。任务默认地址、用例范围与修订号均不改变。后台任务／Jenkins 执行仍使用各自原有配置；历史 API 显式传一次性 `environmentAddresses` 的行为继续兼容。关闭 Adapter 后不套用历史共享 IP。

### 验证证据

2026-11-13 的 10 个定向测试文件共 184 项通过，实际运行 SQLite 与 PostgreSQL，覆盖共享修改、跨链接隔离、同时编辑、修改与创建竞争、过期快照拒绝、幂等重放、关闭 Adapter、停用／归档、身份归属、接口鉴权与新迁移失败回滚恢复。

实际执行以下质量命令：受影响 TypeScript 的 Prettier／ESLint、`pnpm typecheck`、`pnpm --filter @autoforge/web build`、`pnpm --filter @autoforge/worker build`。定向 Vitest 沿用单 Worker、禁止文件并发；PostgreSQL 连接由本机私密测试配置注入，不写入文档或仓库。

Lite／Full 各运行公开任务、锁定任务的临时环境、已删除 Agent 提醒三个 Playwright 场景，共六项通过。Full 使用两个 Web、一个 Worker 与真实 PostgreSQL、Redis、NATS、MinIO，匿名观察者访问第二个 Web，验证共享修改和执行状态同步。场景还核对甲修改、乙拉起的批次快照及 Runner HTTP 领取的地址，刷新后共享配置保留，取消编辑保留原值，过期编辑弹窗保留草稿。

```sh
pnpm exec playwright test tests/e2e/case-suite-lifecycle.spec.ts tests/e2e/runner-telemetry.spec.ts --grep 'public task links execute|locked tasks allow one-execution|deleted Agents remain rejected' --workers=1
pnpm exec playwright test --config playwright.full.config.ts tests/e2e/case-suite-lifecycle.spec.ts tests/e2e/runner-telemetry.spec.ts --grep 'public task links execute|locked tasks allow one-execution|deleted Agents remain rejected' --workers=1
```

实际查看 1024×768、1536×960 的深浅色共享配置、修改记录、冲突弹窗、后台执行操作人和工作台弹窗截图，按钮、长名称及多 IP 无横向溢出，执行节点空提醒不占空间。截图在本机 `/var/tmp/autoforge-public-ip-lite/`、`/var/tmp/autoforge-public-ip-full-ui/` 与对应 `*-browser/` 目录。验证使用隔离数据；未运行全量回归、真实 JVM／Jenkins／SSH 节点或发布流水线，本次未修改这些执行协议和资源。
