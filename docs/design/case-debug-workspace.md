# 用例调试工作台

状态：已实现；2026-09-29 完成下述应用、双数据库和浏览器验证。

## 页面与交互

个人 DDT 数据增加“提交变更 / 我的申请”入口，可将选中的用例及字段差异提交到当前正式库，管理员通过 DDT 管理的“变更审核”入口审核合入或退回。流程与冲突、权限、迁移说明见[个人 DDT 变更审核](./ddt-change-review.md)。

主导航在“用例管理”后增加“用例调试”，沿用顶栏项目、版本、测试阶段。页面包含
“普通用例调试 / DDT 调试”两个子 Tab，访问过的面板保持挂载，隐藏时暂停轮询。
左侧配置输入、执行机/机组与 Adapter；右侧常驻日志和结果。在 1024px 及以上桌面
固定工作台到视口可用高度，配置、执行信息及日志分别滚动，滚轮到达边界也不会带动整页。
执行按钮固定在左栏底部，个人 DDT API 单独展示在左侧配置区。左右栏宽度及右侧
执行信息/日志的高度比例使用 Ant Design Splitter 调整，支持鼠标拖动、方向键，双击或
Home 恢复默认比例；切换子 Tab 保留布局，窗口缩放时按比例调整并保留两栏最小空间。
长类名、版本名、API 地址和错误说明可换行，日志填满剩余空间，不使用固定高度。
上传弹窗复用正式导入组件。

日志区分别显示批次生命周期和用例结果。“执行完成”只表示执行流程正常结束，用例是否通过
读取后台聚合的实际用例结果；TestNG 失败或跳过均为不通过。完成状态使用中性标签，只有实际
通过才显示绿色“执行通过”；超时、终止和结果尚未确认单独标识。查看历史尝试不会改写本次
调试的最终结果，轮询停止仍由批次生命周期决定。

- 输入从正式用例库按批读取，关键词仅在点击搜索或按 Enter 时提交。
- 普通调试默认直接执行测试 JAR。Adapter 模式沿用当前版本完整依赖包，页面明确提示更新执行代码时需同步更新依赖包。
- DDT 调试优先带入 SR 关联类，也允许临时选择其他类或为未关联用例指定类；不写回 SR 关联。
- 每次执行一个用例，重跑次数为零，沿用平台执行期限与 Runner 资源隔离。
- 结果区显示状态、耗时、结果码、上报的 TestNG 计数、分流日志与完整记录入口。
- 实时日志每次读取最多 200 块，浏览器窗口最多保留 200 块和 256 KiB 字符。暂停时保留当前内容，历史阅读逐块翻段，避免丢失窗口之前的内容。页面隐藏和切换到另一个 Tab 时暂停轮询，终态读取完毕后停止轮询。
- URL 保存最近一次批次及其范围，刷新恢复结果；切换项目、版本、阶段后不带入其他范围的结果。
- 调试配置填写后立即保存到当前浏览器，刷新或离开后返回会恢复；按用户、项目、版本、测试阶段及普通/DDT 类型分别记忆。保存测试类、DDT CaseId、执行机/机组选择、Adapter 开关、Suite Name、Test Name 和环境地址，允许保存尚未填写完整或主动清空的字段。修改后无需执行一次才能保存，不覆盖正式任务配置，也不会自动创建执行。
- 浏览器配置只保存所选用例的 ID/显示名称及上述配置，不保存个人 DDT 正文、上传文件、个人 API 访问标识、执行日志或结果。执行时仍由服务端检查当前权限、用例和执行资源；失效的资源提示重新选择，不自动换成其他执行机。配置不跨浏览器同步，清理浏览器站点数据后需要重新填写。
- 自动保存不请求数据库，Lite/Full 使用同一实现。服务端首屏不读取浏览器存储，恢复完成前禁用编辑，避免默认值覆盖已有配置；损坏配置、存储被禁用或配额不足时显示明确提示，仍可在当前页面填写和执行。

## 导入、持久化与权限

JAR 继续导入正式库。DDT 调试上传仅写入个人空间，复用后台预检、重复列名处理和覆盖/跳过/终止流程，支持取消与恢复。复制正式用例只补充不存在的个人副本，保留已有个人修改；JSON 编辑使用版本条件检查，不能改 CaseId。需要发布正式 DDT 时由用户在用例管理明确导入。

个人数据使用 `ddt_debug_cases`，按项目、版本、阶段、用户及规范化 CaseId 唯一约束；`ddt_debug_workspaces` 保存稳定的只读访问标识。个人导入使用独立 `ddt-debug-import` 消息类型，旧工作器无法把个人任务当作正式导入执行。导入任务保存可信的 `debug_owner_id`，正式导入列表与接口排除个人任务，个人任务只能由其所有者读取、确认或取消。每条导入写入与恢复回执保持同一短事务；SQLite 锁重试让出事件循环，PostgreSQL 仅串行化同一用户同一 CaseId 的写入。解析仍在后台线程运行。

页面常驻显示个人 URL：

```text
/api/v1/public/ddt/projects/{projectId}/versions/{versionId}/stages/{stageId}/users/{userId}/debug/{accessKey}/case
```

所有者来自登录会话，不能由请求指定。公开读取验证全部范围与只读访问标识，不回退到正式库或其他用户。持有完整链接者可以读取该个人范围的用例；UI 提示按数据权限分享。API 响应禁止缓存，个人数据不进入全局统计快照。

DDT 的 Adapter 执行仍仅接收 CaseId 和 `/case` API 入口，不生成 DDT JSON 文件。可信的个人访问范围持久于批次 Adapter 快照和 assignment，日志诊断重跑与失败重跑保留个人范围；DDT 用例管理立即执行和任务批跑保持正式 API。DDT 测试类通过 `MM2DataProvider.setDdtInsightUrl` 获得 Runner 可访问的地址。普通用例即使启用 Adapter 也不携带 DDT URL，不加载该提供器，不调用 `setDdtInsightUrl`。

执行需 run.create、case.read、run.read；个人 DDT 上传与编辑要求个人登录、run.create 和 case.read，不要求正式库写权限；JAR 上传仍需 case_source.manage。资源、日志、停止继续遵守 runner.read、log.read、run.cancel。入口校验同源、项目权限、大小和完整范围，不开放任意执行规格或环境变量。

## 升级与回退

SQLite `0073_ddt_debug.sql` / PostgreSQL `0071_ddt_debug.sql` 新增三张个人数据表以及导入任务的可空所有者字段；已有正式用例不迁移、不复制、不修改。迁移与既有流程一样在事务中执行，失败回滚，可修复后重试。升级时先排空工作器并更新所有平台节点及独立工作器，再开放个人调试导入；不要混用旧工作器消费新任务。降级前备份数据库、对象目录和应用镜像，需回退数据库时恢复同一时点备份；不要手工删除已应用的迁移记录。个人数据随数据库持久保存，原始上传文件沿用本地对象 / MinIO。

没有新增生产依赖、在线资源或部署环境变量。Lite 使用 SQLite、本地对象和嵌入工作器；Full 使用 PostgreSQL、MinIO 与同一后台工作实现。Runner 通过相同协议获取范围，不访问数据库。

## 验证边界

应用与双数据库测试覆盖用户/范围隔离、正式数据不变、覆盖/跳过/终止、重复消费、编辑版本冲突与执行规格。Playwright 使用实际 Lite 生产构建和协议模拟 Runner，覆盖个人上传、复制、编辑、API、两用户隔离与执行/日志流程。截图按 1024×768、1536×960 检查，文件仅保留在忽略的 `.local/`。

真实 JVM/Agent、Full 整体部署与完整离线发布验收另有专用流程，本轮局部验证不能替代这些完整验收。

### 本次实际验证（2026-09-29）

- 设置本地测试 PostgreSQL 地址后，`pnpm exec vitest run packages/db/test/case-debug.integration.test.ts`：SQLite / PostgreSQL 共 8 项通过，覆盖个人隔离、只读访问标识、正式库不变、冲突、分页、恢复回执、中断恢复、取消、写锁恢复、并发编辑以及调试执行快照。
- DDT 仓储及迁移回归：`sqlite-ddt.integration.test.ts`、`postgres-ddt.integration.test.ts`、`sqlite-migrations.integration.test.ts`、`postgres-migrations.integration.test.ts` 与调试集成测试首次合并运行 55 项通过；新增的恢复和并发场景随后单独复验通过。
- 应用/契约/UI 检查：`single-ddt-run.test.ts`、`rerun-run-batches.test.ts`、`execution.test.ts`、`import-ddt-limits.test.ts`、`ui-usage.test.ts`、`case-debug.test.ts` 及请求路径脱敏测试通过。重跑测试检查诊断重跑和失败重跑均保留个人 API 范围。
- `go -C apps/runner-agent test ./internal/control`：通过，覆盖个人 URL 拼接、代理前缀、路径编码和非法范围拒绝。
- `pnpm --filter @autoforge/web build`、`pnpm --filter @autoforge/worker build`：通过。Application、DB、Worker 类型检查，以及 Web 服务端、工作线程、测试 TypeScript 检查通过；Web 页面类型检查随生产构建通过。
- 变更 TypeScript 的 ESLint、`pnpm format:check`、`pnpm test:e2e:matrix`：通过。
- `pnpm exec playwright test tests/e2e/case-debug.spec.ts --workers=1`，连接实际 Lite 生产构建：完整流程通过，包含两个账号、公开 API、篡改用户 ID 拒绝、他人导入任务访问拒绝、个人 JSON 编辑、复制、覆盖/跳过、JAR 更新、DDT 调试/普通立即执行、日志和终止。访问日志实际确认个人只读标识显示为 `[REDACTED]`。
- 已实际查看 **1024×768、1536×960** 截图：顶部独立 API 区域、编辑与冲突弹窗、长错误结果、浅色/深色模式无横向溢出或操作按钮变形。截图保存在 `.local/personal-ddt-ui/`，不提交。

### 配置自动保存验证（2026-09-30）

- 先在旧生产构建复现离开页面后测试类选择丢失，再加入浏览器草稿保存；不修改执行 API、数据库、Runner 或 Adapter。Lite/Full 使用同一浏览器实现，无迁移或离线资源变化。
- `pnpm exec vitest run apps/web/src/lib/case-debug-draft.test.ts apps/web/src/components/ui-usage.test.ts`：23 项通过，覆盖按账号/项目/版本/阶段/类型隔离、空字段恢复、挂载不覆盖已有草稿、损坏和超大数据、浏览器拒绝存储及恢复保存、仅持久化白名单字段。
- `pnpm exec playwright test tests/e2e/case-debug.spec.ts --workers=1`：连接实际 Lite 生产构建，两项通过。覆盖未执行就离开再返回、刷新后保留普通/DDT 配置并完成执行与日志闭环、执行机组恢复、阶段往返、同一浏览器退出并切换两名用户、损坏数据恢复和存储配额不足。执行环节使用协议模拟 Runner，此项前端变更未重跑 Full 整体部署或真实 Runner 离线验收。
- `pnpm --filter @autoforge/web build`、`pnpm exec tsc --noEmit -p tsconfig.tests.json`、变更 TypeScript 的 ESLint/Prettier、`pnpm test:e2e:matrix`、`git diff --check` 均通过。
- 已实际查看 **1024×768、1536×960** 的普通/DDT 已保存配置、深色执行结果和存储失败提示截图，状态文字与控件无横向溢出或变形。截图位于忽略的 `.local/debug-autosave-ui/`，不提交。

### 独立滚动与可调整日志验证（2026-09-30）

- 先在旧生产构建增加页面高度断言，复现 1024px 视口整页超出 145px；新布局固定视口高度，配置、执行信息和日志使用独立滚动容器。
- 实际 Lite 生产构建运行 `pnpm exec playwright test tests/e2e/case-debug.spec.ts --workers=1`：两项通过。扩展既有执行闭环，注入 120 行日志，验证左右滚轮互不影响、页面不滚动、执行按钮保持可见、鼠标调整宽度/高度、键盘恢复默认比例，以及窗口缩放后的最小宽度约束。原有普通/DDT 执行、停止、导入、日志分段、账号隔离和草稿恢复继续通过。
- `pnpm exec vitest run apps/web/src/lib/case-debug-log-window.test.ts apps/web/src/lib/case-debug-draft.test.ts apps/web/src/components/ui-usage.test.ts`：25 项通过。生产构建、测试 TypeScript、变更组件 ESLint/Prettier、E2E 覆盖矩阵和 `git diff --check` 通过。
- 实际查看 **1024×768、1536×960** 浅色/深色截图，包含普通执行、DDT 长日志与失败结果、个人 API 和导入弹窗；未发现横向溢出、按钮变形或整页纵向滚动。截图保存在忽略的 `.local/debug-layout-ui/`，不提交。
- 本次只改变共享前端布局，未修改执行、日志 API 或持久化；未重复运行 Full 基础设施和真实 Runner 离线验收。浏览器执行沿用协议模拟 Runner。

### 调试结果显示验证（2026-09-30）

- 旧生产构建复现：正常结束的断言失败批次为 `succeeded`，但 `failedRuns=1`、`succeededRuns=0`；界面顶部错误显示“执行通过”，执行尝试却显示“执行失败”。修复后复用批次生命周期文案，另按后台聚合结果显示用例结论。
- `pnpm exec vitest run apps/web/src/lib/case-debug-result.test.ts apps/web/src/lib/run-batch-presentation.test.ts packages/application/test/normalize-testng-completion.test.ts packages/domain/test/execution.test.ts`：44 项通过，覆盖失败、通过、结果缺失、超时、终止、进行中状态及 TestNG 结果归一化。
- `pnpm exec playwright test tests/e2e/case-debug.spec.ts --workers=1`：连接实际 Lite 生产构建，两项通过。普通断言失败和 DDT 全部跳过都校验后台生命周期为完成、失败用例计数为 1，且界面显示中性的“执行完成”和红色的“执行失败”；再次执行通过仍正确显示通过。原有导入、停止、日志、独立滚动、调整布局、配置恢复及账号隔离流程继续通过。
- `pnpm --filter @autoforge/web build`、`pnpm exec tsc --noEmit -p tsconfig.tests.json`、变更 TypeScript 的 ESLint、变更文件 Prettier 和 `git diff --check` 均通过。
- 实际查看 **1024×768、1536×960** 普通失败与 DDT 跳过截图，以及 1024×768 深色截图，完成状态与结果清晰区分，无标签溢出或布局变形。截图保存在忽略的 `.local/debug-outcome-ui/`，不提交。
- 本次修复仅涉及 Lite/Full 共用的前端结果展示，没有修改数据库、执行状态机或 Runner 协议；E2E 使用协议模拟 Runner，未重跑 Full 整体部署和真实 JVM/Runner 验收。
