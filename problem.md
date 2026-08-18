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

## 3. 需求2：阻塞（blocked）口径（已按用户后续指示重定义）

用户明确定义：**排除 adapter 执行结果为成功或失败的正常结束，其他任何非正常结束
都归为 blocked**——超时被强杀、未拉起 adapter、adapter 执行异常、取消等。实现采用
白名单判定（`packages/domain/src/attempt-result.ts` 的 `classifyAttemptResult`）：

- 成功码（adapter 正常结束并产出有效测试结果）：`TESTNG_SUCCEEDED`、
  `TESTNG_SUCCEEDED_WITH_SKIPS`、`TESTNG_ALL_SKIPPED`；
- 失败码（adapter 正常结束、TestNG 报告真实失败）：`TESTNG_ASSERTIONS_FAILED`、
  `TESTNG_CONFIGURATION_FAILED`；
- 其余一切情形（`timed_out`/`cancelled` outcome、`EXECUTION_TIMEOUT`、
  `ADAPTER_CASE_TIMEOUT`、`LOG_LIMIT_EXCEEDED`、`TESTNG_EXIT_NONZERO`、缺失或未知
  结果码等）一律 blocked。白名单保证未来新增异常码无需回头改分类逻辑。

接入点：用例列表勾选统计（总数/成功/失败/阻塞数与三率）、用例列表“最近执行结果”
筛选与展示（`timed_out`/`cancelled` 的最新 attempt 同样显示为“最近阻塞”）、质量
洞察的项目/版本用例执行统计、执行结果导出。从未执行的用例没有任何终止结果，统计中
单独计为“未执行”，不进入成功/失败/阻塞任何一类。

旧口径（阻塞率 = 未执行数 / 勾选总数）已被替换；质量洞察轮次表的旧“阻塞数”列见
第 11 节的说明。

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

0.6.0 变更（blocked 重定义 + 用例执行超时）在本机执行并通过：

- `pnpm format:check` / `pnpm lint`（含 gofmt、go vet、licenses 检查）
- `pnpm typecheck`（全部包，含 apps/web 的 route types）
- `pnpm test`（vitest 68 files / 370 tests、Go 单测、release/operations 脚本测试）
- SQLite/本地适配器集成测试（`vitest run integration.test`，PG/JetStream/MinIO 按环境 skip）
- adapter 看门狗冒烟（本机无 Maven，用 javac + 本地 fixture jar 手工重建）：
  sleep 30s 用例 + `--case-timeout-seconds 1` → 秒级退出码 3 与超时标记；正常用例
  + `--case-timeout-seconds 600` → 退出码 0。正式 jar 由 CI 的 Maven 构建重新打包。
- `pnpm test:e2e` 全量 8 spec / 15 tests（见下方说明）

0.5.0 阶段已通过且本次未回归的检查：`pnpm test:performance`（含 50,000 行导出链路）、
`pnpm --filter @autoforge/web build`、`scripts/agent/install.sh` 语法检查与 installer 单测。

未在本机执行的检查及原因：

- 根 `pnpm build` 的 `build:agent-resources` 步骤依赖 `mvn` 重建 CoTest Adapter JAR，
  本机未安装 Maven；本地冒烟用 javac 重建的等价 jar，正式构建由 CI release 流水线
  （ubuntu-24.04 自带 mvn）完成，其中包含 `AdapterArgumentsTest`/`AdapterMainTest`。
- PostgreSQL 集成测试（`test:full` / `packages/db/test/postgres-*.integration.test.ts`）、
  `test:deployment`、`test:offline` 仅限 GitHub Actions 环境执行，由 release-checks
  流水线覆盖。PostgreSQL 版 listLatestRunOutcomes 的相关子查询与 SQLite 版同构，
  但只能由 CI 实际执行验证。
- 需求3 真实 SSH 安装链路（`test:runner-install-e2e`）需要真实执行机环境。

e2e 稳定性说明（根因已修复）：全套件运行时 identity-rbac 的“创建本地用户后出现
toast”断言曾偶发失败。最终定位的根因不是负载超时，而是 React 水合失配：
`access-settings.tsx` 的用户/会话表格用裸 `toLocaleString()` 渲染时间，服务端 Node
locale（zh）与浏览器 locale（en-US，Playwright 设备配置）输出不一致，触发 React #418
hydration mismatch，React 重建整棵组件树；全套件负载下水合重建滞后于表单填写，已填
入的用户名输入框被重建清空，`required` 校验拦截提交，POST /api/v1/users 从未发出，
因此永远等不到 toast。单独运行该 spec 时水合先于填写完成，所以稳定通过。修复：上述
5 处时间渲染统一改用 locale 固定的 `formatLocalDateTime`（`Intl.DateTimeFormat("zh-CN")`，
与仓库其余时间展示一致），水合失配消除；断言超时放宽到 15s 的调整保留作为负载余量。
约定 e2e 运行期间不并行执行其他重负载命令。

## 9. 需求4：列宽记忆的作用域

列宽持久化在浏览器 localStorage，key 为
`autoforge.execution-records.column-widths.v1`，仅对当前浏览器与域生效（“浏览器自动
记忆”按 localStorage 实现）。更换浏览器或清除站点数据后回到默认列宽；每列有最小
宽度下限，不会被拖到不可读。

## 10. 发布期 CI 失败的两个根因与修复（提交 7688737 / 9ba38aa）

v0.5.0 首轮流水线的 4 个失败 job 与第二轮的 2 个失败 job，根因均在本仓库而非
runner 环境：

1. 需求5取消了批次详情页行内详情的自动展开，但 `real-agent`、`java-cases-pipeline`、
   `container-executor` 三个 e2e spec 仍在未点击行级“详情”按钮的情况下断言展开
   区域内的内容（“结构化测试结果”标题、TestNG 方法行、产物下载链接）。这些 spec
   不在本机 `test:e2e` 的 8 个冒烟列表内，仅由 CI 完整门运行，因此本机 15/15 通过
   未能暴露。已按 `jar-import.spec.ts` 的模式补齐展开点击（7688737、9ba38aa）。
2. `vitest.performance.config.ts` 的别名写死了本机绝对路径
   `/opt/auto-forge/...`，CI runner 工作目录不同，导致 `@/export-workbook` 解析为
   `ERR_MODULE_NOT_FOUND`，50,000 行导出性能测试在 CI 崩溃。已改为从
   `import.meta.dirname` 相对解析（9ba38aa），本机性能测试复跑 5/5 通过。

教训：新增仅 CI 可跑的 e2e spec 时，前端展示语义变更（如取消自动展开）必须全量
扫描所有 spec 中的相关断言；vitest 配置中禁止出现机器相关绝对路径。

## 11. blocked 重定义：轮次级“阻塞数”改为“未执行数”

批次详情/轮次表中原来的“阻塞数”列统计的是**该轮被持有但尚未执行**的 run
（`blockedRunsForRound`，调度语义：等待未来轮释放），与第 3 节“非正常结束 =
blocked”是两个完全不同的概念。为避免同一术语表达两种口径造成误读，轮次表列名改为
“未执行数”，领域函数与字段名保持不变（仅 UI 文案变化）。若业务上需要按新口径在
轮次维度统计 blocked，需要在轮次汇总中新增字段，本次未做。

## 12. 用例执行超时：adapter 看门狗 + 后台可配置

按用户要求，用例执行超时由 adapter 自己管理生命周期，后台可配置，默认 600s：

- 平台配置新增 `limits.caseExecutionTimeoutSeconds`（1~86400，默认 600），管理后台
  “平台设置”中名称为“用例执行超时（秒）”；经 executionSpec 的 adapter 对象
  （契约 `caseTimeoutSeconds`）下发，SQLite/PostgreSQL 两个 run-batch 仓储注入。
- Go Agent 在拼装 adapter 命令时，当该值 > 0 追加 `--case-timeout-seconds N`
  （新增参数，不影响既有参数顺序与功能）；adapter 侧 `AdapterArguments` 解析并
  校验（默认 600，上限 86400）。
- Java adapter 看门狗实现在 `AdapterMain.executeWithCaseTimeout`：TestNG 执行放入
  守护工作线程，主线程 `Future.get(timeout)` 等待；超时输出机器可读标记
  `TestCase Execution Timeout: ...` 并以退出码 3 结束（退出码约定：0 成功、1 失败
  或异常、2 参数错误、3 用例超时）。超时线程为 daemon，`System.exit` 后不阻止进程
  退出；被中断的 TestNG 线程不做额外清理（JVM 即将退出）。
- Go Agent 将退出码 3 映射为 `timed_out` + 结果码 `ADAPTER_CASE_TIMEOUT`；报告
  解析对该结果码设守卫，即使超时前残留 TestNG 报告也以超时为权威结论。新口径下该
  结果码归类为 blocked。
- 本机验证（无 Maven，使用 javac + 本地 fixture jar 手工重建 adapter jar 冒烟）：
  慢用例（sleep 30s）+ `--case-timeout-seconds 1` → 秒级返回退出码 3 与标记；
  正常用例 + `--case-timeout-seconds 600` → 退出码 0。CI 的 Maven 构建会重新打包
  正式 jar 并运行 `AdapterArgumentsTest`/`AdapterMainTest`。
- 兼容性：未传新参数时 adapter 行为与之前完全一致（默认 600s 看门狗）；旧 Agent
  不传该参数，新 adapter 仍按默认值执行。若既有执行依赖“用例本身运行超过 10 分钟”
  且不希望被中断，需要在平台设置中调大该值。

## 13. blocked 重定义对导出的影响

- 导出行全部来自已产生的 attempt；**从未执行的用例不再导出**（旧口径会把它们作为
  “阻塞（未执行）”行导出，时间与链接留空）。需要未执行清单时请使用轮次表的
  “未执行数”或用例列表的“未执行”筛选。
- 导出筛选项 `timed_out`/`cancelled` 保留为 blocked 的细分别名：超时筛选匹配
  outcome=timed_out 或超时类结果码（含 `ADAPTER_CASE_TIMEOUT`），取消筛选匹配
  outcome=cancelled 或取消类结果码；其余 blocked（adapter 崩溃、日志超限等）仅由
  “阻塞（异常结束）”筛选项命中。
- 默认勾选项由“失败 + 超时”改为“失败 + 阻塞”，使首次导出即覆盖全部非正常结束。

## 14. ARTIFACT_DISCOVERY_REJECTED 的根因与彻底修复（v0.6.1）

- artifact 发现在做什么：用例执行结束、日志收口之后，Agent 按执行规格中的产物规则
  （`artifactRules`）扫描 attempt 工作目录，把命中的文件收集为可下载产物并上传对象
  存储。默认套件策略规则为 `reports/testng/**`，即收集 TestNG 报告输出
  （testng-results.xml、index.html 等）。用例成败**不依赖**这一步——它由
  `reports/testng/testng-results.xml` 的解析与进程退出码决定；产物收集只是附加下载
  能力，自定义产物规则（如 java-cases fixture 的 `artifacts/*.txt`）也走同一机制。
- 根因：原实现是 all-or-nothing。任何被规则命中的文件若是符号链接/特殊文件、命中文件
  超过 256 个、单文件超过 256MiB 或总字节超限，都会拒绝整轮扫描，且 supervisor 会把
  attempt 的真实结果直接改写为 failed + `ARTIFACT_DISCOVERY_REJECTED`。本机已复现三类
  触发器（reports/testng 内的符号链接、FIFO、260 个文件均导致拒绝）。生产环境中只要
  用例或框架向报告目录写入任何此类文件，用例即使通过也被记为失败。0.4.17 只修复了
  “未命中规则的符号链接”，命中规则的拒绝逻辑仍在，这就是执行完仍报错的原因。
- 修复（两层）：
  1. 扫描器（`apps/runner-agent/internal/executor/artifacts.go`）改为尽力而为收集：
     命中规则但无法安全收集的文件（符号链接、特殊文件、超大小/数量/字节预算）一律跳过
     （符号链接从不跟随、从不读取，无越界读取风险），其余正常文件照常收集。硬性错误仅
     保留给规则配置错误（路径穿越等）、ctx 取消与“必需产物缺失”。
  2. supervisor（`apps/runner-agent/internal/control/supervisor.go`）：仅
     `REQUIRED_ARTIFACT_MISSING`（显式声明 required 的产物确实缺失）仍以失败覆盖 attempt
     结果；其他产物发现问题只写 Agent 诊断日志，不推翻 TestNG 报告与退出码决定的真实结果。
- “该逻辑是否有存在必要”的决策：保留产物收集能力（自定义产物规则是真实功能，CI 的
  java-cases-pipeline 依赖 `artifacts/*.txt` 下载断言），但把默认 TestNG 报告收集降级为
  尽力而为——收集失败只意味着少几个可下载文件，永远不再导致用例失败。结构化结果页已含
  testng-results.xml 的解析内容；若后续决定彻底移除默认报告收集，只需把
  `defaultCaseSuiteExecutionPolicy.artifactPatterns` 置空，无需其他改动。
- 测试：新增/改写扫描器测试（符号链接跳过且不越界读取、字节预算内跳过超限文件、异常
  文件混杂时收集健康文件、超 256 个文件时封顶不失败），Agent 全量 go test 通过；
  应用层 `ARTIFACT_DISCOVERY_REJECTED` 事件渲染测试保留（历史结果码仍需可渲染，新
  blocked 口径下归类为 blocked）。
