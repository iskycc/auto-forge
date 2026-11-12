# 任务执行环境 IP

任务默认环境保存在版本化任务配置中。任务列表、任务详情和“开始执行”弹窗允许有项目 `run.create` 权限的用户设置下一次手动执行的环境 IP；任务锁定不限制这项操作。

## 下一次执行设置

- 任务卡片的“环境 IP”和详情的“修改下次执行 IP”打开同一个列表弹窗；全局“开始执行”弹窗展示当前任务的完整地址，也可直接修改。
- 地址以用户与任务 ID 隔离，仅在当前浏览器页面的内存中保存；站内导航和打开／关闭执行弹窗保留设置，刷新页面恢复任务默认。任务切换不复用另一任务的设置，其他用户、浏览器和计划执行不受影响。
- 立即执行和倒计时执行都把自定义地址提交给预检和创建接口。成功创建批次后消费该设置，下次恢复任务默认；关闭弹窗、预检失败和提交失败保留设置，允许重试。“恢复任务默认”可主动清除。
- 接口为 `POST /api/v1/run-batches/preflight` 与 `POST /api/v1/run-batches` 的可选 `environmentAddresses` 数组。只允许 1–128 个互不重复的 IPv4／IPv6，未启用 Adapter 时拒绝覆盖；其他执行策略、参数或锁定身份仍不可通过此入口覆盖。
- 覆盖只写入新批次的 Adapter 快照；不修改任务默认地址、成员、版本或修订号，不影响已创建或正在执行的批次。确认请求时保留其地址版本，较早请求完成不会清除提交期间的新设置。

## 任务配置与多地址编辑

任务配置中的“环境 IP / 地址”展示地址标签，点击“修改环境 IP”后逐项编辑，随后仍需“保存任务配置”才能持久生效。只有锁定人且具有任务管理权限时可修改已锁定任务的默认地址。只读详情单独提供下一次执行设置，不能提交任务配置变更。

创建任务、任务配置、单用例快捷执行、用例调试和公开任务页统一采用 Ant Design 列表弹窗：一个输入框一个地址，支持添加、删除、序号、128 条上限和重复／空值提示。弹窗主体滚动，标题和操作栏保持可见，取消不应用草稿。既有任务、调试和单用例配置仍兼容历史主机名／URL 地址；新的任务临时覆盖和公开任务临时覆盖要求字面 IP。

公开任务页面继续保留当前页的地址选择用于后续执行，刷新或恢复任务配置时清除；公开日志页的单用例重跑仍只接受一个 IP。这些既有保留规则不随后台任务“仅下一次”设置改变。

## Lite／Full 与恢复

两种模式共用 HTTP 契约、权限、应用服务和 UI。Lite 将批次快照写入 SQLite 后通过持久队列继续派发；Full 在 PostgreSQL 中保存快照并由 outbox／NATS 继续调度。临时页面设置不依赖 Redis 或队列，不成为业务事实；批次一旦创建，其 IP 即由数据库快照恢复，刷新、重启或倒计时等待不会丢失。对象存储及 Runner 协议无变化，无新增迁移、配置或依赖。

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
