# 日志页重跑的单次环境 IP

公开日志详情与日志浮窗共用“执行此用例”确认弹窗。首次打开时读取原始执行环境，默认只读；
点击“修改”后允许输入一个 IPv4 或 IPv6，点击“恢复原 IP”可撤销本次编辑并重新锁定。
“取消”关闭弹窗且不创建执行；再次打开重新读取原环境，不记忆先前输入。
确认后才创建独立手动诊断批次，提交失败保留输入并显示错误，提交期间禁用重复确认和关闭。

## 默认值与隔离

手动批次始终通过 parentBatchId、sourceExecutionRunId 回到原始批次和用例，不从上一个手动批次继承临时 IP。
优先读取原始用例最近一次 assignment 的实际 Adapter 地址；旧记录缺少 assignment 时，
使用原始运行快照和原始 attempt 序号推算，最后沿用原环境池首项。
修改仅影响新诊断批次的 Adapter 运行地址；原任务策略、原批次环境池和 assignment 均不写回。
即使手动修改的 IP 也是原环境池成员，下次打开仍重新解析原始环境，不将它作为轮换起点。
任务批跑和普通失败重试继续按原环境池轮换，Runner 仍基于同一用例族的节点历史选取。

原执行没有启用 Adapter 时，弹窗说明按原配置执行，IP 字段与修改按钮禁用；
API 也拒绝借环境 IP 参数开启 Adapter。历史启用 Adapter 但缺失地址时，操作人必须填写有效 IP。
旧快照中已有的主机名可保持原值执行，新编辑值只接受 IP。

## HTTP 与工作线程

- `GET /api/v1/run-attempts/{attemptId}/rerun` 返回 `{ adapterEnabled, environmentIp }`，响应禁止缓存。
- `POST` 使用相同地址，允许空请求体／`{}`，或 `{ "environmentIp": "10.0.0.99" }`；
  省略 IP 使用原环境，显式修改支持 IPv4／IPv6，去除两端空白，禁止附带任务／其他 Adapter 设置。
- 读取与执行均要求已登录且具有原始项目的 `log.read`、`run.retry` 权限；POST 继续校验同源。
  请求 JSON 最多 1 KiB，客户端和服务端共用契约校验。环境信息不进入匿名公开日志 DTO。
- Web 完成认证和项目授权后，将环境解析与重跑创建分别交给现有 scheduling worker；
  不在 Web 主线程读取大批次快照，不读取原批次统计、全部成员或无关用例的 assignment。
- 仅查询选中原始用例的 assignment，Lite／Full 共用参数化 SQL；Runner 的诊断家族索引查询保留。
  旧的“读取上一个手动批次环境再轮换”逻辑被原始环境读取替代，避免单次覆盖污染后续默认值。

本功能不新增数据库迁移、生产依赖、队列、缓存、配置或 Runner 协议。
单次地址沿现有新批次 Adapter 快照持久化，Lite 保存于 SQLite，Full 保存于 PostgreSQL；
仍通过同一 Runner Protocol 下发，日志、恢复和执行状态裁决沿用原流程。
原始任务数据和公开日志授权不受本次编辑影响。

## 验证与截图（2026-10-27 收尾）

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
当前改动尚未提交或发布。
