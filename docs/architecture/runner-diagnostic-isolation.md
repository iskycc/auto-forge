# 执行机诊断读取与执行控制隔离

任务执行期间打开调度日志或资源监控，只读取诊断信息，不应影响领取、续租、日志上传或完成上报。

## 阻塞路径与修复

此前 Lite 的调度日志查询在 Web 主线程同步执行。`LIMIT 500` 只限制返回行数，不能限制扫描行数；按批次和执行机筛选时，旧索引只能定位其中一个条件，可能扫描同一执行机在其他批次的历史事件。搜索不存在的文本尤其需要遍历全部匹配范围。资源监控虽只保留 360 份样本，也与 Web 请求共用数据库读取路径。主线程被阻塞时，续租请求无法及时处理，真实租约超期后会裁决为 `LEASE_EXPIRED`，显示 `Assignment lease expired before completion.`。

Lite/Full 的调度事件读取、资源样本读取统一通过组合根代理转交一个独立诊断进程。领域与应用规则不区分模式，HTTP 入口继续完成登录、项目范围与执行机读取权限校验。其他仓储方法仍保持原绑定与写入路径。

- 调度事件仍采用 `(recorded_at, id)` 游标与最多 500 条的页面；最新、前后翻页、中文与英文片段、通配符字面搜索及完整载荷保留。
- 资源监控仍为最近六小时、每分钟一份、最多 360 条；读取不写入资源采样或修改心跳。
- 诊断进程最多容纳两个在途/等待请求；满载返回 HTTP 503、`PLATFORM_BUSY`，使用现有浮窗错误提示与重试入口。
- 每个请求从提交起最多等待五秒，包括启动与排队；超时终止整个诊断进程，等待进程退出、释放读取连接后再拒绝请求，下一次读取重新创建进程。执行控制、调度和上传不使用此进程。
- SQLite 使用只读文件连接和 `query_only`，不创建数据库、不执行迁移；PostgreSQL 使用一个只读业务连接、四秒 statement timeout、25ms lock timeout，不执行迁移。主平台先完成正常迁移，再允许这些已鉴权诊断读取。
- 采用进程隔离是因为终止 Node Worker 不能可靠打断正在执行的 SQLite 原生同步调用；单纯给 Promise 加超时也不会停止 SQL。进程只执行允许的诊断读取，不承载写事务或对象存储操作；启动参数无数据库凭据，必要数据库配置通过本地 IPC 传递。
- 诊断进程纳入现有 CPU/内存资源预算，不独立扩展成无界进程池。没有新增生产依赖、服务、环境变量或平台配置。

`POST /api/v1/runner-agents/{runnerId}/leases/{leaseId}/renew` 接入自托管 HTTP 协议快路径，与领取、日志和完成共用已注册的应用服务。复用原身份认证、600 次/分钟的按执行机限流、16 KiB 请求体限制、协议 schema、版本条件及错误映射；无需等待 Next.js 首次加载该路由。租约时长、超期判定和 Runner 协议未修改。真实失联、凭据失效或版本冲突仍明确拒绝，不延长过期租约。

Lite 的执行工作线程也使用 25ms SQLite 锁等待，锁冲突交给既有有界异步重试，避免一次原生锁等待长达五秒并拖住排队续租。

## 迁移、部署与恢复

SQLite `0077_scheduling_events_batch_runner_index.sql` 和 PostgreSQL `0075_scheduling_events_batch_runner_index.sql` 添加 `(batch_id, runner_id, recorded_at, id)` 组合索引。旧事件及已有索引保留，不改变数据或恢复判定。新建库、从上一版本升级及失败事务回滚均有真实数据库检查。

升级前按现有流程备份数据库并排空任务。历史事件较多时，新建索引会增加启动迁移耗时，需为升级留出维护窗口。索引失败随迁移事务回滚；恢复上一版本备份时，使用匹配的旧镜像及数据库/对象备份集合。

后端构建与离线包新增内置 `apps/web/dist-server/server/runner-diagnostics-process.js`，打包时校验该文件存在；运行使用镜像现有 Node，无外部进程程序或公网下载。需更新并重启主平台；Agent 无需改变协议或重新安装。保留普通 `next` 路由下的本地仓储 fallback，但正式发布启动路径始终注册读取代理与协议快路径。

## 验证范围

回归检查覆盖 Lite/Full 读取隔离与满载、超时终止/重新读取、SQL 查询计划、资源样本、游标/搜索、只读连接与迁移回滚，以及续租鉴权、限流、请求体、协议错误和版本冲突。

`apps/web/server/runner-diagnostic-reads.integration.test.ts` 在真实 SQLite/PostgreSQL 上构造无法在预算内完成的 SQL 读取，同时连续发送 HTTP 请求并更新有效租约，验证慢查询不会阻塞续租，超时后恢复读取。

`tests/e2e/lite-high-concurrency.spec.ts` 使用 500 个真实协议槽位，持续续租至少跨越原始 45 秒期限，在执行中反复打开/刷新调度日志和资源监控，并完成全部日志及结果上报。它使用协议 Runner 夹具，不运行真实 Java 进程；真实 Agent 的失联/重启、Full 中间件整体部署及发布包离线运行仍由现有验收覆盖。

### 2026-10-09 本地验证记录

- 发布前最终 `pnpm test`：220 个 Vitest 文件、1,288 项检查，Go Agent 测试及 63 项发布/运维/质量脚本检查通过。
- 最终定向单元回归：续租路由与桥接器、诊断容量/超时恢复、仓储代理、资源预算和权限路径的六个文件共 51 项通过。
- 真实 SQLite/PostgreSQL 回归：以下七个文件共 67 项通过，没有跳过的数据库场景或未处理错误；包括慢 SQL 同时续租、超时后重新读取、原有管理及平台仓储、资源样本、调度日志和迁移。

```bash
AUTOFORGE_TEST_POSTGRES_URL=postgresql://postgres@127.0.0.1:55447/autoforge \
pnpm exec vitest run \
  apps/web/server/runner-diagnostic-reads.integration.test.ts \
  packages/db/test/diagnostic-read-database.integration.test.ts \
  packages/db/test/scheduling-events.integration.test.ts \
  packages/db/test/runner-resource-samples.integration.test.ts \
  packages/db/test/scheduling-event-read-plan.integration.test.ts \
  packages/db/test/sqlite-management.integration.test.ts \
  packages/db/test/postgres-platform.integration.test.ts
```

该地址属于一次性的本地信任认证测试库，验证结束即关闭，不是部署配置。新增诊断契约同时接入 `scripts/quality/test-full.sh` 的适配器及分布式契约分区。

- Lite 生产构建下 `pnpm exec playwright test tests/e2e/lite-high-concurrency.spec.ts` 一项通过：执行中至少保持 50 秒，500 个协议槽位全部执行成功，失败数为零。服务端 HTTP 日志中 2,000 次续租均为 200，P95 为 27ms、最慢 110ms；四次调度日志读取最慢 405ms、八次资源监控读取最慢 9ms；500 次完成上报均成功。以上为该本地环境的观测结果，不承诺其他硬件、数据库规模或真实用例负载具有相同时延。
- `pnpm exec playwright test tests/e2e/ui-layout.spec.ts tests/e2e/runner-telemetry.spec.ts --grep 'scheduling logs bound|closing a pending scheduling|Runner telemetry shows'` 三项通过：保留调度日志完整范围搜索、历史翻页、关闭取消、错误重试，以及资源样本、空历史及读取重试。
- 上述浏览器测试使用已启动的临时 Lite 生产服务和本地 Chromium。实际查看调度日志/资源监控的八张截图，覆盖 1024×768、1536×960 以及浅色/深色；弹窗、表格、图表、按钮和页面边界正常，没有新增换行错位、变形或溢出。
- `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm --filter @autoforge/web build`、`pnpm test:e2e:matrix`、`git diff --check` 通过；49 项发布脚本回归通过。最终构建包含并生成诊断进程入口。

当前未连接用户所在局域网，未读取其生产数据库；以上通过本地阻塞复现与同一控制协议验证修复路径。Full 整体部署、真实 Agent 和新离线包验收本次未在本地运行。
