# 批次终止收尾与执行机输入隔离

## 终止收尾

终止停止新增调度和重跑，已经领取且仍有有效租约的用例自然完成。批次只有在这些用例完成或原有执行／上传／租约期限裁决后才进入 `cancelled`；终止不等同于强杀 JVM。

Full 完成热路径先提交用例结果和回执，再用独立短事务收尾批次。代码复查和真实 PostgreSQL 故障注入确认：若第二个事务失败，结果可以已全部保存而批次仍为 `running`。此前主要依赖执行机重放完成上报补偿；没有重放、又没有可调度工作时，终止批次缺少主动恢复入口。另一个竞争窗口是完成上报先读到“允许重跑”，随后终止请求提交，完成事务再保存等待重跑；这些等待不会被调度，却能阻挡批次进入终态。

现在在取得权威批次锁后，终止收尾再次关闭未被有效租约保护的等待工作，然后聚合状态。已有失败／超时尝试结果、执行历史和终止人保留，不释放下一轮，也不重复发起 Jenkins 恢复。Web 每五秒发起一次专用的终止恢复扫描，每次最多五个批次，不依赖执行机后续请求。扫描使用现有批次状态、assignment 与租约索引，**不执行无关的全局排队超时扫描**。Full 使用 `FOR UPDATE SKIP LOCKED`，Lite 在原控制工作线程执行短事务；同一个批次由锁和版本条件保证收尾幂等。

数据库短暂繁忙时保留状态并在下一轮重试；不能承诺任意负载下固定五秒完成。已经卡住的旧批次在升级后也可被扫描恢复，无需手改数据库。无数据库迁移或新配置，全部 Web／Worker 仍需同步更新。

执行详情使用蓝色处理态标签和等待图标展示“终止中”，不再把禁用的危险操作按钮当作状态；终止期间移除不可用的暂停／继续操作。终态后显示“任务已终止”，保留原结果和日志入口。

## 不同版本与执行槽位

同一 Runner 同时执行不同批次时：

- JDK、依赖和输入位于 `work/batches/<batchId>/`，不同版本的独立批次不会复用同一个解压目录；原始文件名和 InputID 相同不会成为跨批次缓存键。
- 跨批次持久缓存只保存压缩输入，以 SHA-256 与大小为键，复制到批次目录时重新校验，临时文件完成后原子发布。同内容可以复用，不同内容分别保存。
- 每个尝试通过 `MkdirTemp` 创建自己的工作目录、Java 进程、报告目录和日志流；Java 路径为本尝试引用的 JDK，classpath 或 Adapter JAR 目录也来自当前批次。Agent 不通过修改全局 `JAVA_HOME` 或系统 Java 来切换版本。
- 同批次的静态 JAR 通过硬链接、JDK 通过受控链接共享，批次引用计数保证最后一个本机尝试结束前不清理。不同批次的清理互不影响。

以上保证平台管理的输入与执行产物路径隔离，**不表示 process 执行器是完整沙箱**。测试主动写共享绝对路径、固定 `/tmp` 文件、抢同一端口，或同时修改同一被测环境／外部数据库，仍可能互相影响；测试也不应改写同批次共享的 JAR／JDK。平台不可能仅靠槽位把业务系统外部状态自动隔离。

## 验证

相关回归位于：

- `packages/db/test/scheduling-refill.integration.test.ts`：SQLite／PostgreSQL 的整轮／即时重跑残留收尾、有效租约保留、首轮全失败和重复恢复。
- `packages/db/test/postgres-concurrent-completions.integration.test.ts`：并发完成、终止与完成，以及用数据库触发器只打断批次收尾事务、保留结果事务后独立恢复。
- `packages/application/test/control-executions.test.ts`：无执行机请求也能调用有界专用扫描。
- `apps/runner-agent/internal/control/batch_isolation_test.go`：两个版本、不同 JDK／同名依赖包、四个并发槽位，逐字核对各自的 Java、依赖、测试 JAR 和输出，关闭一个批次后另一个版本仍可读取。
- `tests/e2e/batch-termination-settlement.spec.ts`：真实租约夹具下的终止、深浅色状态、自动收尾和最后失败记录保留；使用协议／数据库夹具，不代表真实 JVM 压测。

2026-11-04 的定向验证：

```bash
AUTOFORGE_TEST_POSTGRES_URL=<本机隔离验收库> pnpm exec vitest run \
  packages/db/test/scheduling-refill.integration.test.ts \
  packages/db/test/postgres-concurrent-completions.integration.test.ts \
  packages/application/test/control-executions.test.ts \
  apps/web/src/lib/run-batch-presentation.test.ts \
  --maxWorkers=1 --no-file-parallelism
```

四个文件 **148 项通过**，SQLite／PostgreSQL 均实际运行；旧实现的四项收尾回归先复现为 `running` 无法结束。PostgreSQL 故障注入保留 16 条首轮失败结果，打断批次收尾事务后，不依赖完成重放即可恢复为 `cancelled`，轮次不前进。专用周期恢复也验证不会裁决其他批次已经到期的排队记录。

```bash
GOMAXPROCS=1 go -C apps/runner-agent test -race -p 1 ./internal/control \
  -run 'TestConcurrentVersions|TestBatchRegistry|TestEnsureBatch|TestRuntimeInputCache|TestRuntimeCache|TestReportCompletion' -count=1
GOMAXPROCS=1 go -C apps/runner-agent vet ./internal/control
pnpm exec playwright test tests/e2e/batch-termination-settlement.spec.ts --workers=1
```

Go 竞态检查与 vet 通过，Lite 生产包上的 Playwright 闭环通过，确认最后失败结果保留、独立恢复收尾、统计准备完成及原日志操作可用。实际查看六张截图：1024×768／1536×960 的深浅色终止中状态与深色终止完成状态；处理态文字通过 4.5:1 对比度检查，未发现新增错位或溢出。截图位于本机 `/var/tmp/autoforge-termination-ui-20261104/`。

Web／Full Worker 生产构建、Web／application／worker 类型检查通过；`pnpm exec tsc --noEmit -p tsconfig.tests.json`、`pnpm format:check`（含 Go 格式和许可证）、相关 TypeScript 的 `pnpm exec eslint ... --max-warnings=0`、`pnpm test:e2e:matrix` 及 `git diff --check` 均通过。所有高 CPU 构建与检查串行限制为一核执行，验证服务已在检查后关闭。不把构造的 JDK 内容夹具等同于真实 JDK 8／21 长时批跑；本轮未重跑完整 Full 浏览器矩阵、真实 JVM 批跑及断网验收。
