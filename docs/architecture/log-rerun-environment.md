# 日志页重跑的环境 IP

公开日志详情页点击“执行此用例”直接创建独立手动诊断批次。旁边的“设置重跑环境 IP”独立打开设置弹窗，默认只读，点击“修改”后填写 IPv4／IPv6，点击“恢复原 IP”撤销草稿；“保存设置”只保存当前页面的选择，不创建执行。
按钮下方显示“下一次手动执行 IP”，区分当前执行环境与本页自定义地址。保存后反复执行、提交失败后重试、历史刷新均保留选择；刷新文档或打开另一页后重新读取该日志对应的执行地址。只保存在页面内存，不写入跨页面共享的 localStorage／Cookie。

控制台日志浮窗保留逐次确认弹窗，避免改变其他执行入口。未启用 Adapter 时直接沿用原配置，IP 设置不可用；原记录缺少环境地址时须先设置地址，执行按钮保持不可用。

## 默认值与隔离

默认环境绑定当前日志的 attempt，优先使用该次 assignment 实际下发的 Adapter 地址；缺少 assignment 时，按该批次环境池、当前用例的起点和该 attempt 序号推算，最后回退到批次环境池首项。较早轮次不会借用后续轮次的地址。查看某次手动重跑的日志时，继续重跑继承该次执行的地址，不回到任务默认 IP。

执行谱系仍通过 parentBatchId、sourceExecutionRunId 锚定原始批次和用例，手动 IP 选择只进入新诊断批次，不改写原任务、原批次、原 assignment 或其他页面的选择。普通任务批跑和失败重试继续按原有环境池轮换。

旧快照中的主机名可保留并按原值执行，新编辑值只接受 IP；API 不允许借 IP 参数开启原本未启用的 Adapter。

## HTTP 与工作线程

- `GET /api/v1/run-attempts/{attemptId}/rerun` 返回 `{ adapterEnabled, environmentIp }`，响应禁止缓存。
- `POST` 使用相同地址，允许空请求体／`{}`，或 `{ "environmentIp": "10.0.0.99" }`；
  省略 IP 使用当前日志对应的执行环境，显式修改支持 IPv4／IPv6，去除两端空白，禁止附带任务／其他 Adapter 设置。
- 读取与执行均要求已登录且具有原始项目的 `log.read`、`run.retry` 权限；POST 继续校验同源。
  请求 JSON 最多 1 KiB，客户端和服务端共用契约校验。环境信息不进入匿名公开日志 DTO。
- Web 完成认证和项目授权后，将环境解析与重跑创建分别交给现有 scheduling worker；
  不在 Web 主线程读取大批次快照，不读取原批次统计、全部成员或无关用例的 assignment。
- 环境展示通过 `readAttemptRerunEnvironment` 一条参数化查询定位 attempt、run、batch 和 assignment，仅投影有界环境池、所选用例起点与实际地址，不返回全批次地址映射、DDT 正文、TestNG 报告、恢复密钥或运行资产。SQLite／PostgreSQL 共享映射与轮换规则，Runner 的诊断家族索引查询保持原语义。

本功能不新增数据库迁移、生产依赖、队列、缓存、配置或 Runner 协议。
单次地址沿现有新批次 Adapter 快照持久化，Lite 保存于 SQLite，Full 保存于 PostgreSQL；
仍通过同一 Runner Protocol 下发，日志、恢复和执行状态裁决沿用原流程。
原始任务数据和公开日志授权不受本次编辑影响。

## 历史验证与截图（2026-10-27 收尾）

以下保留旧交互的验收记录；当前默认地址和页面设置行为以 2026-11-11 的验证记录为准。

先增加单次 IP 和工作线程传递回归，原实现有 5 项新增断言失败、39 项已有断言通过。
最终 220 项定向用例通过：124 项契约、应用、权限、worker 与 UI 约定检查，
94 项真实 SQLite/PostgreSQL 共享回归，以及 2 项真实冷/热工作线程集成检查；重复运行的同一用例不累加。
覆盖普通与 DDT、池外与池内 IP 覆盖、IPv4/IPv6、源快照不变、下次回到原环境、
无 Adapter、旧地址长度、非法输入、跨项目权限、只读 GET、索引查询和执行控制响应。
冷/热工作线程验证 HTTP 探测仍响应、既有 lease 可续租、新批次持久化临时 IP 且原配置仍返回源 IP。

实际执行的主要命令：

```sh
pnpm exec vitest run \
  apps/web/server/worker-pool.test.ts \
  packages/application/test/rerun-run-batches.test.ts \
  packages/contracts/test/scheduling.test.ts \
  apps/web/src/lib/work-dispatch.test.ts \
  apps/web/src/lib/authorization-paths.test.ts \
  apps/web/src/components/ui-usage.test.ts --maxWorkers=1

# AUTOFORGE_TEST_POSTGRES_URL 指向本次临时数据库，双数据库实际执行。
pnpm exec vitest run \
  packages/db/test/attempt-log-snapshot.integration.test.ts \
  packages/db/test/scheduling-refill.integration.test.ts --maxWorkers=1

pnpm typecheck
pnpm --filter @autoforge/web build
pnpm exec vitest run apps/web/server/case-log-rerun.integration.test.ts --maxWorkers=1
# 增补池内覆盖与旧地址边界后定向复验。
pnpm exec vitest run packages/application/test/rerun-run-batches.test.ts packages/contracts/test/scheduling.test.ts --maxWorkers=1
pnpm --filter @autoforge/application typecheck
pnpm exec tsc --noEmit -p tsconfig.tests.json
pnpm licenses:check
pnpm test:e2e:matrix

# 预装 Chromium、隔离生产 Lite 服务与数据目录；两个场景分别取得通过结果。
pnpm exec playwright test tests/e2e/single-case-run.spec.ts tests/e2e/ddt-management.spec.ts \
  --grep='log detail reruns a completed|public logs rerun failed Chinese' --workers=1
pnpm exec playwright test tests/e2e/single-case-run.spec.ts --grep='log detail reruns a completed' --workers=1
```

两项生产 Lite Playwright 场景通过。501 用例活动批次的普通用例验证读取失败后重试、
只读／修改／恢复、无效 IP、取消后重新打开、嵌套日志弹窗的取消与 Escape、实际领取的单次覆盖、
从新手动日志再次执行恢复原 IP，以及任务摘要中的原 IP 保持不变。
中文 DDT 验证原环境池为两个地址时，单次使用新 IP 后下次仍恢复原 IP，
并回归公开日志、历史、登录态恢复及版本 API；未登录和无执行权限入口保持原有约束。

验收中，旧冷/热线程夹具补齐了现有持久配置初始化。普通场景新增的任务核对先误用全量详情接口，
被 501 成员的既有 413 保护拒绝；改用摘要后复验通过，业务接口的容量保护保持有效。

实际查看 1024×768、1536×960 的默认浅／深色和编辑态共 6 张弹窗截图。
输入框、修改／恢复按钮、说明、页脚操作对齐正常，长内容有边界，无新增页面溢出或布局变形。
范围内 Prettier、ESLint、类型、生产构建、许可证、18 行 E2E 矩阵与 diff 检查通过。
证据位于 `/var/tmp/autoforge-log-rerun-ip-20261026/`，重任务串行限制 1 CPU／4 GiB，临时服务已关闭。

未启动真实业务 JVM，未运行 Full 整套中间件部署或离线发布物验收；
浏览器使用真实 HTTP/数据库和模拟 Runner 的协议领取验证下发参数，不作为被测环境网络连通性验收。

## 当前默认环境与页面设置验证（2026-11-11）

新增回归先在旧实现中复现了两类错误：查看手动重跑日志时回退到原批次 IP，查看早期 attempt 时读取后续轮次 IP；生产浏览器场景也复现了公开任务提交成功后自定义 IP 被清空。

修复后 139 项定向检查通过，包含真实 SQLite／PostgreSQL 的单条环境投影、assignment 缺失时按当前 attempt 序号回退、索引查询计划、无关大批次数据排除、任务公开执行及 UI 约束：

```sh
# 私密测试配置注入 AUTOFORGE_TEST_POSTGRES_URL，数据库使用隔离 schema。
pnpm exec vitest run \
  packages/application/test/rerun-run-batches.test.ts \
  packages/application/test/public-suite-execution.test.ts \
  packages/db/test/attempt-log-snapshot.integration.test.ts \
  packages/db/test/public-suite-execution.integration.test.ts \
  apps/web/src/lib/public-suite-execution-api.test.ts \
  apps/web/src/components/ui-usage.test.ts \
  --maxWorkers=1 --no-file-parallelism

# 分别连接准备好的 Lite／Full 生产服务。
pnpm exec playwright test tests/e2e/case-suite-lifecycle.spec.ts \
  tests/e2e/single-case-run.spec.ts tests/e2e/ddt-management.spec.ts \
  --grep 'public task links execute|log detail reruns a completed case|public logs rerun failed Chinese' \
  --workers=1
pnpm exec playwright test --config playwright.full.config.ts \
  tests/e2e/case-suite-lifecycle.spec.ts tests/e2e/single-case-run.spec.ts \
  tests/e2e/ddt-management.spec.ts \
  --grep 'public task links execute|log detail reruns a completed case|public logs rerun failed Chinese' \
  --workers=1
```

Lite 与 Full 各三个生产 Playwright 场景通过；Full 使用双 Web、Worker 和真实 PostgreSQL／NATS／Redis／MinIO。普通 501 用例批次和中文 DDT 均通过 Runner HTTP 测试端验证真实下发 IP：同页连续执行、提交失败后重试、进入手动重跑日志再执行、刷新原日志恢复该执行的默认 IP，以及任务持久配置不变。公开任务同时回归不重叠环境并行、恢复任务配置、倒计时、暂停／终止、幂等和登录。

实际查看 1024×768、1536×960 深浅色页面、下一次执行 IP 区及设置弹框截图，无按钮溢出、横向变形或异常换行。截图位于 `/var/tmp/autoforge-rerun-ip-ui` 和 `/var/tmp/autoforge-rerun-ip-full-ui`。相关应用、数据库、Web 与测试类型检查、变更文件格式／Lint 及 Web／Worker 生产构建通过。未运行完整标准 CI、十万规模压力场景、真实业务 JVM、外部 Jenkins 或发布流程。
