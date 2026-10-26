# 执行任务并发诊断

执行详情的活动批次操作区提供“并发诊断”，用于解释执行中用例未达到并发上限的当前条件。只有同时具有该项目 `run.read` 与 `runner.read` 的已登录用户可读取；匿名执行详情不展示入口，公开授权或旧分享令牌不能替代登录和权限。

点击后才读取，关闭即取消浏览器请求，没有后台轮询。弹窗展示：

- 执行中、已分配待领取、可立即调度排队、等待后续轮次的数量；待领取与执行中共同占用任务并发。
- 已持久化生效的动态并发上限，缺省回退批次基础并发；未配置上限的历史批次明确显示未配置。
- 项目在途执行数与项目额度，以及节点自身准入允许的新增槽位。实际补位继续受任务额度、项目额度和剩余用例数量约束。
- 各节点本任务／其他任务的权威在途占用、最近心跳忙碌值、最大并发、CPU／内存和指标时间；内存预算同时显示每例执行上限、系统保留、已计入的执行抵扣、剩余增长预留和内存可增槽位。
- 节点离线、禁用／排空、协议或执行能力不兼容、领取标签不满足、指标缺失／过期、CPU／内存／负载超限、内存预留不足等影响因素。

尚未到计划开始、正在终止、等待轮次环境恢复、轮次屏障、没有可立即调度用例或处于收尾时，分别给出说明。已有空闲准入预算而仍有排队用例时，明确显示“等待共同补位”，建议持续不变时结合调度日志定位；不凭一次采样断言调度器故障。节点指标是最近心跳，实时 claim 还会修正槽位滞后。刷新失败保留上次成功采样并明确标记，不把旧结果当作当前结论。

## 读取与一致性

新增私有只读端点 `GET /api/v1/run-batches/{batchId}/concurrency-diagnostics`，返回明确 DTO 和 `private, no-store`。入口先校验身份、批次项目范围与节点查看权限，再调用共享应用服务。服务的时钟、资源阈值、项目额度和仓储均由组合根注入；准入评估和内存可增槽位复用现有领域调度规则，不实现第二套算法，也不修改调度、领取、重试、租约或资源保护。

Lite/Full 均在已有可终止的只读诊断进程内读取快照。IPC 方法及参数加入既有白名单校验，沿用两个在途／排队请求上限和五秒期限；SQLite 只读连接、25ms 锁等待，PostgreSQL 单连接、四秒语句期限及 25ms 锁等待。失败返回可重试错误，不占用执行控制或日志上传通道。

仓储仅投影批次元数据、非终态执行计数、聚合在途占用及所选节点。Adapter 运行快照只在 SQL 内读取能力标志，不传输可能包含十万条映射的 JSON；不读取用例正文、执行规格、日志或 TestNG 报告。节点当前／上一版凭据摘要不参与读取，HTTP DTO 也不包含节点凭据、完整 capability／标签清单、其他任务身份或地址。终态用例遗留的活跃 attempt 和终态批次均不占用有效在途额度。

当前任务／机组选择上限为 64 个节点，诊断同样最多返回 64 个，表格每页五行；历史超限数据显式提示省略数量。一次采样不是跨多个查询的强一致调度事务，执行期间数值可能变化；诊断只用于解释当前采样条件，不作为执行状态或容量分配事实来源。

## 部署与验证

后续内存优化新增可选执行抵扣指标，诊断与调度共用增长预留公式。见 [Runner 内存准入](./runner-agent.md#内存准入与进程终止诊断2026-10-24)，包含双数据库迁移及 Agent 升级说明。以下为并发诊断初次落地的验证记录。

初次落地无新增迁移、配置、生产依赖或 Runner 协议变化；Lite 继续使用本地 SQLite，Full 使用 PostgreSQL，不依赖 Redis／NATS 保存诊断正确性。更新主平台及 Full 独立 worker 后生效，旧执行记录和离线资源保持原有读取方式。

验证覆盖领域准入规则、应用原因汇总、双数据库读取与项目隔离、私有端点权限以及读取进程白名单，最终八个文件 158 项通过；其中共享 SQLite/PostgreSQL 回归共 64 项，两种数据库均实际执行。数据库、应用、Web 服务／工作线程与测试类型、受影响文件格式／Lint、Web 和独立 worker 生产构建、18 行 E2E 矩阵及差异检查通过。

最终生产 Lite Playwright 两项通过：新诊断场景覆盖点击前不读取、真实接口计数、匿名拒绝、节点分页不请求后台、深浅色、503 错误／重试和焦点恢复；原即时补槽场景增加执行期间读取诊断，继续验证完成、重试、日志和取消流程。首次视觉检查发现极长节点名使行高过大，已限制两行并通过悬浮／聚焦查看全名。实际审查最终 11 张截图，包括 1024×768、1536×960 的深浅色概览／节点明细、两种尺寸的页面入口及窄桌面错误状态，未发现新增越界或控件变形。

实际命令：

```sh
# 数据库回归显式设置一次性 AUTOFORGE_TEST_POSTGRES_URL。
pnpm exec vitest run packages/db/test/scheduling-refill.integration.test.ts packages/db/test/project-adapter-runtime.test.ts packages/application/test/read-concurrency-diagnostics.test.ts packages/domain/test/scheduler.test.ts apps/web/src/lib/execution-view-reads.test.ts apps/web/src/lib/work-dispatch.test.ts apps/web/src/lib/concurrency-diagnostics-route.test.ts apps/web/src/components/ui-usage.test.ts --maxWorkers=1
pnpm --filter @autoforge/db typecheck
pnpm --filter @autoforge/application typecheck
pnpm exec tsc --noEmit -p tsconfig.tests.json
pnpm exec tsc --noEmit -p apps/web/tsconfig.server.json
pnpm exec tsc --noEmit -p apps/web/tsconfig.worker.json
pnpm --filter @autoforge/web build
pnpm --filter @autoforge/worker build
pnpm exec playwright test tests/e2e/scheduling-refill.spec.ts --workers=1
pnpm test:e2e:matrix
git diff --check
```

格式和 ESLint 检查限定在受影响文件，具体清单和日志保存在 `/var/tmp/autoforge-concurrency-diagnostics-20261025/`。重任务串行限制 1 CPU、4 GiB，临时 PostgreSQL 和 Web 服务结束后关闭。此次未运行 Full 整套中间件、真实 Java／Agent 或完整离线镜像验收；诊断为当前采样，不保证包含用户现场的全部历史阻塞原因。
