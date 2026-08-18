# problem.md — 本次六需求实现的自行决策记录

以下条目均为实现过程中遇到的不确定点与处理方式，按用户要求记录，供后续分析。

## 1. 需求3：默认工作目录的真实路径

用户描述中提到“默认的 /var/lib/autoforge 目录”，但代码中 Runner Agent 的默认数据目录实为
`/var/lib/autoforge-agent`（常量 `DEFAULT_RUNNER_DATA_DIRECTORY`，见
`packages/contracts/src/management.ts`）。本次按实际默认值实现自定义工作目录功能，
未改动默认路径本身。若业务上确实期望默认值为 `/var/lib/autoforge`，需要单独决策并
注意这会影响既有安装机的兼容性。

## 2. 需求3：修改工作目录不迁移已有数据

安装后修改 Runner 工作目录时，仅更新远端配置文件中的 `dataDirectory` 并重启服务；
原目录下的 Agent 身份（identity）、spool 未确认日志等不会自动迁移。修改后 Agent 会
以“空目录”启动，需要重新走注册流程（installer 的 update 流程已按此实现：未提供新
目录时 SSH 读回远端 config 沿用）。如需保留旧目录数据，需要额外的迁移能力。

## 3. 需求2：阻塞率口径

领域模型中 `RunAttempt`/`ExecutionRun` 没有独立的 “blocked” 状态。勾选用例统计中的
“阻塞率”定义为：**阻塞率 = 未执行用例数 / 勾选总数**（见
`apps/web/src/lib/case-selection-stats.ts`）。这与质量洞察轮次统计中 “阻塞数 = 未执行”
的既有口径保持一致。若业务上期望 blocked 指“被依赖阻塞”，需要先在领域模型中引入该
状态，当前无此概念。

## 4. 需求5：日志公开访问链接的有效期与权限

任务详情页新增的“公开日志”按钮调用 `POST /api/v1/run-attempts/[attemptId]/log-share`，
由服务端校验当前身份对该 attempt 所在项目的 `log.read` 权限后签发日志公开访问链接。
链接**永久有效**——用户口头纠正：这不是“分享链接”，而是日志的公开访问链接/公开
API，永久有效。实现上未改数据库 schema：`attempt_log_shares.expires_at` 为 NOT NULL
且仓储统一按 `expires_at > now` 判定有效性，因此新记录写入哨兵过期时间
`9999-12-31T23:59:59.999Z`（`PERMANENT_LOG_ACCESS_EXPIRY`，
`packages/application/src/attempt-log-shares.ts`）表达永久；旧版本按 30 天签发的记录
会自然过期，之后重新导出/点击会签发新的永久链接。权限不足或 attempt 不存在时返回
错误并在行内展示。

安全权衡（需要知悉）：永久链接没有吊销通道，一旦泄露只能靠删除对应 attempt/批次
（外键 ON DELETE CASCADE）来收敛暴露面。token 为 32 字节随机值、库中只存 SHA-256
哈希，不可枚举、不可还原；但泄露的代价是永久可访问。如后续需要吊销能力，建议新增
`revoked_at` 列或平台级开关，而不是继续依赖过期时间。审计 action 沿用
`attempt_log.share` 这一稳定机器码未改名，避免割裂审计历史；仅用户可见文案改为
“日志公开访问”。

## 5. 需求5：“相同数据只加载一次”的实现边界

行内详情（产物 + 状态事件）的缓存以 `Map<attemptId, entry>` 放在 `RunBatchRounds`
组件的 state 中：同一次页面会话内重复展开、翻页、切换轮次都不会重新请求；但整页
导航离开或浏览器刷新后缓存会重建（与“用例管理列表”的浏览器会话级缓存口径一致）。
刷新按钮（router.refresh()）只更新服务端数据，不清空详情缓存——若需要刷新后强制
重新拉取某个已展开 attempt 的详情，当前需要整页刷新。

## 6. 需求5：搜索/筛选为既有能力的增强

任务详情页的用例表格原本已有“状态筛选 + 名称搜索”，本次保留并在此基础上新增：
每页条数选择（20/50/100/200/500，默认 50）、名称/状态/Runner/耗时四列排序
（三态：升序→降序→默认）、刷新按钮、取消单用例自动展开。

## 7. 需求6：大屏布局取值

`.page-stack` 内容宽度由固定 `min(100%, 1540px)` 改为
`min(100%, clamp(1540px, 90vw, 2160px))`：1440px 以下视口保持原宽度（既有
max-width 断点行为不变），1440px~2400px 之间随窗口线性放宽，超大屏封顶 2160px。
用例详情页 `.case-detail-page` 同步改为 `clamp(1280px, 82vw, 1920px)`。
具体上下限为经验取值，如设计侧有不同偏好（例如封顶 1920px 或不限宽），只需调整
clamp 两个端点。未触碰移动端断点。

## 8. 验证范围说明（已执行与未执行的检查）

已在本机执行并通过：

- `pnpm format:check` / `pnpm lint`（含 gofmt、licenses 检查）
- `pnpm typecheck`（全部包，含 apps/web 的 route types）
- `pnpm test`（vitest 67 files / 357 tests、Go 单测、release/operations 脚本测试）
- SQLite/本地适配器集成测试（`vitest run integration.test`，PG/JetStream/MinIO 按环境 skip）
- `pnpm test:performance`（5 项，含 50,000 行导出链路）
- `pnpm --filter @autoforge/web build`（Next.js 生产编译）
- `pnpm test:e2e` 全量 8 spec / 15 tests 通过（jar-import 含日志公开访问断言）
- `scripts/agent/install.sh` 语法检查（bash -n）；installer 相关单测通过

未在本机执行的检查及原因：

- 根 `pnpm build` 的 `build:agent-resources` 步骤依赖 `mvn` 重建 CoTest Adapter JAR，
  本机未安装 Maven，仅 web/worker 构建在本机验证；adapter 构建由 CI release 流水线
  （ubuntu-24.04 自带 mvn）完成。
- PostgreSQL 集成测试（`test:full` / `packages/db/test/postgres-*.integration.test.ts`）、
  `test:deployment`、`test:offline` 仅限 GitHub Actions 环境执行，由 release-checks
  流水线覆盖。
- 需求3 真实 SSH 安装链路（`test:runner-install-e2e`）需要真实执行机环境。

## 9. 需求4：列宽记忆的作用域

列宽持久化在浏览器 localStorage，key 为
`autoforge.execution-records.column-widths.v1`，仅对当前浏览器与域生效（“浏览器自动
记忆”按 localStorage 实现）。更换浏览器或清除站点数据后回到默认列宽；每列有最小
宽度下限，不会被拖到不可读。
