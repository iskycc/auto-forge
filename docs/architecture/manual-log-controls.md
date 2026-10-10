# 手动执行日志控制

## 用户行为

`/CaseLog` 及两个历史公开日志路径使用相同展示组件。普通单用例执行
（`standard` 且 `suiteId` 为 `single:` 前缀）和日志页诊断重跑（`case_log_rerun`）
属于手动执行；普通任务和最终失败批次重跑不属于该范围。

进行中的手动执行仅为已登录、有对应项目 `log.read` 权限的用户启用正文实时更新。
不要求 `run.retry`，日志只读用户也可观看。匿名访客、没有项目日志权限的用户、
任务执行和已结束执行沿用服务端静态快照。页面切换执行记录时按 attempt ID 重建
实时组件，防止把旧执行的内容追加到新执行。

“强行中断”另外要求项目 `run.cancel`，与 `run.retry` 分开判断。弹窗说明可能
遗留测试数据、资源或未恢复的环境；“继续执行”只关闭弹窗。
勾选“后续中断操作不再提醒”并成功提交后，在当前浏览器 localStorage 保存
`autoforge.manual-execution.stop-warning.v1=true`。清理网站存储后恢复提醒。
浏览器禁止存储时仍可中断，但会说明无法保存偏好；请求失败不写入偏好。

取消请求沿用现有 `cancelRun` 与 Runner Protocol。有效 lease 的 attempt 先持久化
取消请求，Agent 下一次续租收到 `instruction: cancel`，清理进程后上报结果。
按钮在请求提交后保持禁用并显示“中断中”，不能将 HTTP 200 当成进程已经停止。
重复请求与完成竞争由现有执行控制处理；查询时已经结束则返回 `cancelled: false`。

## 接口与边界

| 接口                                                                   | 校验与返回                                                                                           |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `GET /api/v1/run-attempts/{attemptId}/manual-state`                    | 登录、手动来源、项目 `log.read`；只返回 attempt ID 和状态                                            |
| `POST /api/v1/run-attempts/{attemptId}/cancel`                         | 同源、登录、手动来源、项目 `log.read` 和 `run.cancel`；请求正文上限 8 KiB，审计记录操作用户与执行 ID |
| `POST /api/v1/run-attempts/{attemptId}/log-stream-ticket?manualOnly=1` | 同源、登录、手动来源、项目 `log.read`、尚未结束；沿用短期签名票据与既有 WebSocket 网关               |

未携带 `manualOnly=1` 的票据接口保持原浮窗行为。以上校验使用应用层的最小
attempt 来源查询和批次元数据，不加载任务成员、完整批次或日志正文。
公开地址本身的持久化授权与历史链接兼容规则不变。

## 资源生命周期

- 每个可见手动日志详情使用一个 WebSocket。实时正文最多保留最近 512 KiB 或
  1,024 块，仅合并 stdout/stderr，按流与序号去重；正文最多每 100 ms 更新一次。
- 首次连接和重连时，通过现有日志 API 按游标串行补齐，每流最多 8 页、每页
  200 块；请求前同时固定两路水位，防止实时消息到达导致遗漏另一流。
  重连期间仍在补齐时，合并为下一次串行补齐请求，避免并行读取。
- 只轮询最小状态接口，单次结束后间隔 5 秒继续，无日志正文定时轮询。
  HTTP 请求和 WebSocket 建连各有 10 秒期限。重连按 1–30 秒退避，最多 8 次，
  失败后保留已加载正文并提供“重连”；状态查询连续失败 3 次或权限失效时停止连接。
- 页面隐藏、切换执行、执行结束和组件卸载会关闭连接、取消读取并清理定时器。
  返回页面重新连接并补齐持久日志；终态刷新为完整的服务端展示快照。
- 任务、匿名及终态日志保留服务端布局，避免将整个日志正文与历史列表作为新增
  实时客户端状态发送。原日志分页、滚动边界和截断提示保持一致。

## Lite/Full、升级与恢复

业务规则、HTTP 与界面共用实现，SQLite/PostgreSQL 使用原仓储。
Lite 使用已有本地日志和执行控制工作线程；Full 使用已有日志所属节点与实时网关
转发。取消与结果正确性仍依赖持久化执行状态、lease 和 Agent HTTPS 上报，
WebSocket 仅用于观看，断线不会改变执行权或执行结果。

本变更没有数据库迁移、持久化平台配置、环境变量、生产依赖或 Runner 协议变更，
不要求更新 Agent。离线资源仍由现有本地构建和离线镜像交付。

## 验证记录（2026-10-10）

以下检查实际通过；所有重检查顺序执行，Node 堆限制 1,536 MiB，Vitest 与
Playwright 使用单 worker，浏览器验收使用事先完成的生产构建。

| 命令 / 范围                                                                                                                                                                                                                                             | 结果                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `pnpm format:check`                                                                                                                                                                                                                                     | 格式、Go 格式和许可证清单通过                                                        |
| `pnpm lint`                                                                                                                                                                                                                                             | ESLint 与 Go vet 通过                                                                |
| `pnpm -r --workspace-concurrency=1 --if-present typecheck`                                                                                                                                                                                              | 全工作区类型检查通过                                                                 |
| `pnpm exec tsc --noEmit -p tsconfig.tests.json`                                                                                                                                                                                                         | 测试类型检查通过                                                                     |
| `pnpm exec vitest run --maxWorkers=1 --no-file-parallelism --exclude '**/*.integration.test.ts'`                                                                                                                                                        | 228 文件、1,344 项通过                                                               |
| 本变更领域、应用、HTTP、日志窗口、浏览器偏好、权限、截断及 UI 规范共 9 个定向测试文件                                                                                                                                                                   | 最终整理后再次运行，98 项通过                                                        |
| `pnpm exec vitest run packages/db/test/manual-execution-context.integration.test.ts packages/db/test/sqlite-attempt-log-share.integration.test.ts packages/db/test/postgres-attempt-log-share.integration.test.ts --maxWorkers=1 --no-file-parallelism` | 配置真实临时 PostgreSQL，SQLite/PostgreSQL 共 28 项通过，无 PostgreSQL 跳过项        |
| `pnpm --filter @autoforge/web build`                                                                                                                                                                                                                    | Next.js、服务端及全部工作线程/只读进程生产构建通过                                   |
| `pnpm exec playwright test tests/e2e/all-rounds.spec.ts tests/e2e/single-case-run.spec.ts --workers=1`                                                                                                                                                  | 使用 `AUTOFORGE_E2E_EXTERNAL_SERVER=1` 连接临时 Lite 生产构建，2 项通过，约 2.9 分钟 |

浏览器场景验证普通单用例与诊断重跑的正文无需重载即可收到实际上传日志；隐藏页面
关闭连接，恢复后补齐期间上传的内容；新路径和两个历史路径均可查看手动实时日志。
匿名浏览器没有实时连接及中断入口。取消弹窗不发送请求，勾选确认后持久化偏好，
重载后的第二次中断跳过提醒但仍要求点击按钮。实际续租接口返回 `instruction: cancel`，
协议夹具随后上报取消完成，页面才呈现“已取消”。原轮次、Jenkins 恢复、浮窗日志、
匿名执行详情及导出断言一并通过。

真实截图位于本次工作环境的 `/tmp/autoforge-manual-log-ui/`：
`manual-log-live-{light,dark}-{1024,1536}.png` 与
`manual-stop-warning-{light,dark}-{1024,1536}.png`。
已实际查看 1024×768 和 1536×960 的全部八张最终截图：侧栏操作保持单行，
当前历史记录标记清晰；弹窗居中，警告文本、复选框和页脚按钮对齐，无新增溢出或变形。
截图等待弹窗完成进场动画，并禁用截图期间的动画，避免把中间帧当作最终布局。

本次 Full 验证限于真实 PostgreSQL 的应用/仓储路径，未运行完整 NATS/Redis/MinIO
浏览器部署。浏览器 Runner 使用协议夹具，没有另起真实 Go Agent/Java 用例进程，
不将取消指令与完成上报验收表述为真实进程树停止验收。Runner 协议、进程清理实现、
基础设施适配器和离线打包未改变，因此未重复完整 Agent、离线与双架构发布验收。
