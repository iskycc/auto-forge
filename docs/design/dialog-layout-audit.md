# 全平台弹窗布局复查（2026-09-29）

范围：通过页面入口实际打开业务弹窗、嵌套确认和图片预览，检查 1024 × 768 与 1536 × 960 桌面视口；重点复查深色、长名称、多字段、导入冲突和错误恢复。UI 使用同一套 Ant Design 组件，Lite/Full 无分支。

## 复查方式

- 使用本地 Lite 测试数据、现有 Playwright 业务流程和补充入口巡检，不使用生产数据。
- 为打开状态保存真实浏览器截图并人工查看，检查标题、关闭按钮、表单、操作区、换行和滚动边界。
- SSH 探测、升级和终端连接的布局状态使用协议响应夹具；不向真实执行机执行安装或升级。
- 截图与逐条状态记录位于本地 `.local/dialog-audit-2026-09-29/`，不提交截图、数据库或构建产物。

## 业务弹窗清单

下表按实现入口去重，共 54 个业务弹窗实现；含条件标题的组件已检查对应变体。所有入口均已实际打开，并在两个桌面视口查看截图。

| #   | 组件                                                                                                    | 标题 / 变体                                                                                                    | 状态                   |
| --- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 1   | [AccessSettings](../../apps/web/src/components/access-settings.tsx)                                     | "重置用户密码"                                                                                                 | 已打开，双视口复查通过 |
| 2   | [AccessSettings](../../apps/web/src/components/access-settings.tsx)                                     | "创建自定义角色"                                                                                               | 已打开，双视口复查通过 |
| 3   | [AttemptLogComparison](../../apps/web/src/components/attempt-log-comparison.tsx)                        | {`日志对比 · ${comparison.name}`}                                                                              | 已打开，双视口复查通过 |
| 4   | [BatchRunnerUpdate](../../apps/web/src/components/batch-runner-update.tsx)                              | {"批量更新执行机 Agent"}                                                                                       | 已打开，双视口复查通过 |
| 5   | [CaseImportDialog](../../apps/web/src/components/case-import-dialog.tsx)                                | {"导入用例"}                                                                                                   | 已打开，双视口复查通过 |
| 6   | [CaseSuiteEditor](../../apps/web/src/components/case-suite-editor.tsx)                                  | "复制用例任务"                                                                                                 | 已打开，双视口复查通过 |
| 7   | [CaseSuiteManager](../../apps/web/src/components/case-suite-manager.tsx)                                | "创建用例任务"                                                                                                 | 已打开，双视口复查通过 |
| 8   | [CaseSuiteScheduleDialog](../../apps/web/src/components/case-suite-schedule-dialog.tsx)                 | "执行历史与计划"                                                                                               | 已打开，双视口复查通过 |
| 9   | [ConfigurationSearchDialog](../../apps/web/src/components/configuration-search.tsx)                     | "配置搜索"                                                                                                     | 已打开，双视口复查通过 |
| 10  | [CreateProjectHierarchyDialog](../../apps/web/src/components/create-project-hierarchy-dialog.tsx)       | {`新建${label}`}                                                                                               | 已打开，双视口复查通过 |
| 11  | [CreateUserDialog](../../apps/web/src/components/create-user-dialog.tsx)                                | "创建本地用户"                                                                                                 | 已打开，双视口复查通过 |
| 12  | [DdtCaseDataDialog](../../apps/web/src/components/ddt-case-data-dialog.tsx)                             | "DDT 用例数据"                                                                                                 | 已打开，双视口复查通过 |
| 13  | [DdtCaseSelectionDialog](../../apps/web/src/components/ddt-case-selection-dialog.tsx)                   | "按清单选择 DDT 用例"                                                                                          | 已打开，双视口复查通过 |
| 14  | [ImportDialog](../../apps/web/src/components/ddt-management-workspace.tsx)                              | "导入 DDT 用例"                                                                                                | 已打开，双视口复查通过 |
| 15  | [ColumnConflictDialog](../../apps/web/src/components/ddt-management-workspace.tsx)                      | "解决重复列名"                                                                                                 | 已打开，双视口复查通过 |
| 16  | [TemplateDialog](../../apps/web/src/components/ddt-management-workspace.tsx)                            | "新建字段模板"                                                                                                 | 已打开，双视口复查通过 |
| 17  | [BulkDialog](../../apps/web/src/components/ddt-management-workspace.tsx)                                | {`批量修改 ${count} 条用例`}                                                                                   | 已打开，双视口复查通过 |
| 18  | [AddDdtToSuiteDialog](../../apps/web/src/components/ddt-management-workspace.tsx)                       | {`将 ${caseIds.length} 条 DDT 用例加入任务`}                                                                   | 已打开，双视口复查通过 |
| 19  | [DdtRequirementCategoriesDialog](../../apps/web/src/components/ddt-requirement-categories-dialog.tsx)   | {mapping ? `设置 SR ${mapping.srNum} 的分类` : "需求分类"}                                                     | 已打开，双视口复查通过 |
| 20  | [DdtExecutionClassesDialog](../../apps/web/src/components/ddt-sr-associations.tsx)                      | "测试类候选范围"                                                                                               | 已打开，双视口复查通过 |
| 21  | [ExecutionCaseFilter](../../apps/web/src/components/execution-case-filter.tsx)                          | "查找执行用例"                                                                                                 | 已打开，双视口复查通过 |
| 22  | [FailureAnalysisAssignmentDialog](../../apps/web/src/components/failure-analysis-assignment-dialog.tsx) | "分配用例分析"                                                                                                 | 已打开，双视口复查通过 |
| 23  | [FailureAnalysisBatches](../../apps/web/src/components/failure-analysis-batches.tsx)                    | {archiving ? "归档分析任务" : "关闭分析任务"}                                                                  | 已打开，双视口复查通过 |
| 24  | [FailureAnalysisConclusionPicker](../../apps/web/src/components/failure-analysis-conclusion-picker.tsx) | {"本任务近 5 次批跑结论"}                                                                                      | 已打开，双视口复查通过 |
| 25  | [FailureAnalysisStatistics](../../apps/web/src/components/failure-analysis-statistics.tsx)              | {selectedAnalyst ? `${selectedAnalyst.claimantDisplayName} 的分析内容` : "分析内容"}                           | 已打开，双视口复查通过 |
| 26  | [ReleaseClaimDialog](../../apps/web/src/components/failure-analysis-workspace.tsx)                      | {`取消认领 ${claim.caseName}`}                                                                                 | 已打开，双视口复查通过 |
| 27  | [CompleteAnalysisDialog](../../apps/web/src/components/failure-analysis-workspace.tsx)                  | { claims.length > 1 ? `批量分析 ${claims.length} 个用例` : `分析 ${claims[0]?.caseName}` }                     | 已打开，双视口复查通过 |
| 28  | [CompleteAnalysisDialog](../../apps/web/src/components/failure-analysis-workspace.tsx)                  | {"确认用例问题"}                                                                                               | 已打开，双视口复查通过 |
| 29  | [CompleteAnalysisDialog](../../apps/web/src/components/failure-analysis-workspace.tsx)                  | { inheritanceCandidate.claim.category === "code_issue_filed" ? "确认继承未闭环代码问题" : "确认继承分析结论" } | 已打开，双视口复查通过 |
| 30  | [GlobalRunDialog](../../apps/web/src/components/global-run-dialog.tsx)                                  | "开始执行"                                                                                                     | 已打开，双视口复查通过 |
| 31  | [InsightDetailDialog](../../apps/web/src/components/insight-detail-dialog.tsx)                          | {title}                                                                                                        | 已打开，双视口复查通过 |
| 32  | [LoginDialog](../../apps/web/src/components/login-dialog.tsx)                                           | "登录控制台"                                                                                                   | 已打开，双视口复查通过 |
| 33  | [OperationsSettings](../../apps/web/src/components/operations-settings.tsx)                             | "创建服务账号"                                                                                                 | 已打开，双视口复查通过 |
| 34  | [OperationsSettings](../../apps/web/src/components/operations-settings.tsx)                             | {`编辑服务账号：${account.name}`}                                                                              | 已打开，双视口复查通过 |
| 35  | [OperationsSettings](../../apps/web/src/components/operations-settings.tsx)                             | {`签发令牌：${account.name}`}                                                                                  | 已打开，双视口复查通过 |
| 36  | [ProjectActions](../../apps/web/src/components/project-actions.tsx)                                     | "转移项目负责人"                                                                                               | 已打开，双视口复查通过 |
| 37  | [ProjectStructureManager](../../apps/web/src/components/project-structure-manager.tsx)                  | "从其他版本继承用例"                                                                                           | 已打开，双视口复查通过 |
| 38  | [RerunFinalFailuresDialog](../../apps/web/src/components/rerun-final-failures-dialog.tsx)               | "重新执行最后一轮"                                                                                             | 已打开，双视口复查通过 |
| 39  | [RunBatchExportDialog](../../apps/web/src/components/run-batch-export-dialog.tsx)                       | "导出执行结果"                                                                                                 | 已打开，双视口复查通过 |
| 40  | [RunnerAgentInstaller](../../apps/web/src/components/runner-agent-installer.tsx)                        | "自动安装执行机 Agent"                                                                                         | 已打开，双视口复查通过 |
| 41  | [RunnerFaultDialog](../../apps/web/src/components/runner-fault-dialog.tsx)                              | {"执行机异常事件"}                                                                                             | 已打开，双视口复查通过 |
| 42  | [RunnerGroupManager](../../apps/web/src/components/runner-group-manager.tsx)                            | "新建执行机组"                                                                                                 | 已打开，双视口复查通过 |
| 43  | [RunnerGroupManager](../../apps/web/src/components/runner-group-manager.tsx)                            | {`编辑执行机组：${group.name}`}                                                                                | 已打开，双视口复查通过 |
| 44  | [RunnerTelemetryDialog](../../apps/web/src/components/runner-telemetry-dialog.tsx)                      | {`${runnerName} · 资源监控`}                                                                                   | 已打开，双视口复查通过 |
| 45  | [RunnerTerminal](../../apps/web/src/components/runner-terminal.tsx)                                     | {`${runnerName} 直连终端`}                                                                                     | 已打开，双视口复查通过 |
| 46  | [RunnerTimeoutDialog](../../apps/web/src/components/runner-timeout-dialog.tsx)                          | "执行机超时记录"                                                                                               | 已打开，双视口复查通过 |
| 47  | [RunnerUpdateDialog](../../apps/web/src/components/runner-update-dialog.tsx)                            | {`更新 ${runnerName} 的 Agent`}                                                                                | 已打开，双视口复查通过 |
| 48  | [StartFailureAnalysisDialog](../../apps/web/src/components/start-failure-analysis-dialog.tsx)           | "选择执行任务开始分析"                                                                                         | 已打开，双视口复查通过 |
| 49  | [TerminalLogViewer](../../apps/web/src/components/terminal-log-viewer.tsx)                              | {title}                                                                                                        | 已打开，双视口复查通过 |
| 50  | [UserRoleAssignmentDialog](../../apps/web/src/components/user-role-assignment-dialog.tsx)               | "分配用户角色"                                                                                                 | 已打开，双视口复查通过 |
| 51  | [VersionCaseInheritanceDialog](../../apps/web/src/components/version-case-inheritance-dialog.tsx)       | {`从其他版本继承 ${caseType} 用例`}                                                                            | 已打开，双视口复查通过 |
| 52  | [VersionInitializationDialog](../../apps/web/src/components/version-initialization-dialog.tsx)          | "版本初始化"                                                                                                   | 已打开，双视口复查通过 |
| 53  | [WebhookSettings](../../apps/web/src/components/webhook-settings.tsx)                                   | {editor?.id ? "编辑 Webhook" : "新建 Webhook"}                                                                 | 已打开，双视口复查通过 |
| 54  | [WebhookSettings](../../apps/web/src/components/webhook-settings.tsx)                                   | "删除 Webhook"                                                                                                 | 已打开，双视口复查通过 |

## 共享确认与输入弹窗

共享 `UiFeedbackProvider` 的 34 处确认调用入口也已核对，覆盖普通用例 / DDT / 来源 / 任务成员 / 执行计划 / 执行机 / 存储资源删除、任务终止、Agent 回滚、会话和角色撤销、负责人转移及版本恢复。以确认前取消方式检查危险操作的布局，已有业务 E2E 另外验证相应提交结果。

分析中的嵌套 `alertdialog`、历史结论选择、Ant Design 图片预览、草稿丢弃与并发冲突提示均已检查；长内容保持有界滚动，嵌套关闭后仍能返回原编辑内容。

## 修复与验证

### 已定位并修复

| 问题                                           | 原因                                                     | 修复                                                       |
| ---------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------- |
| DDT 导入长文件名挤压文件大小，冲突策略双层边框 | 文件行缺少宽度边界，旧选择器误作用于 Ant 内部标签        | 文件信息使用有界布局、语义状态及真实 Ant Radio.Group       |
| DDT 模板、批量修改按钮偏左且大块留白           | 两个按钮沿用四列网格；正文和公共弹窗重复设置内边距       | 操作移动到 ActionDialog 固定底栏；正文统一间距             |
| 加入任务、列冲突操作随正文滚走                 | 操作区放在滚动正文内部                                   | 统一底栏，保留草稿保护和冲突反馈顺序                       |
| Webhook 操作栏覆盖表单                         | 正文内 sticky 操作栏和容器滚动边界不一致                 | 公共底栏与正文分离，提交按钮通过 form ID 关联原表单        |
| 签发令牌的权限列表只占半列                     | 权限组和提交按钮直接排在双列表单里                       | 权限组跨满整行，签发及取消位于底栏                         |
| 单机 / 批量更新长名称撑出窗口                  | 自定义 grid 列默认最小宽度由内容决定，标题和正文缺少边界 | 复用 ActionDialog；正文 min-width:0；长名称和地址允许换行  |
| 调度日志标题挤走关闭按钮                       | 长标题撑大隐式网格列                                     | minmax(0,1fr) 列，标题截断并保留完整提示，关闭按钮不缩小   |
| 草稿确认的两个按钮贴在一起                     | 旧 CSS 针对的 button 类不再存在                          | 使用 Ant Flex 的统一间距                                   |
| 用例分析长标题挤压图标                         | 图标参与 flex 收缩                                       | 图标固定尺寸                                               |
| 全局搜索浮层直接裁掉连续长名称                 | 标题缺少长单词换行规则，撑大内部网格列                   | 标题允许任意位置换行并使用紧凑行距，保留完整文字及键盘导航 |

### 验证边界

- 使用真实 Lite 生产构建与本地夹具，修改只涉及 Lite/Full 共用的前端展示层，没有数据库迁移、API、Runner 协议或离线依赖变更。
- SSH 探测、更新失败与终端网关使用确定性协议响应，本轮不执行真实主机安装、回滚或升级。
- 截图巡检在原有 E2E 的点击之间加入截图，可能改变短暂加载状态的观察时机；加载与刷新时序另用未加入巡检步骤的原始测试验证。
- 未运行 Full 基础设施验收和真实 SSH 安装；此次未修改这些路径。

### 自动化验证

- `pnpm --filter @autoforge/web build`：生产构建及应用类型检查通过。
- `pnpm exec tsc --noEmit -p tsconfig.tests.json`：测试类型检查通过。
- `pnpm exec eslint <本次修改的 TS/TSX 文件>`：通过。
- `pnpm exec vitest run apps/web/src/components/ui-usage.test.ts`：17 项通过。
- `pnpm exec prettier --check <本次修改文件>`、`git diff --check`：通过。
- `pnpm exec playwright test ... --grep ...`（本地逐入口截图配置及原始测试）：受影响的 **22 个不同业务场景最终通过**，其中管理和布局 9 个、DDT / TestNG / 分析分配 / 项目角色 10 个、分析及日志对比 3 个。
- 对应测试文件：`ui-layout.spec.ts`、`management-operations.spec.ts`、`ddt-management.spec.ts`、`jar-import.spec.ts`、`identity-rbac.spec.ts`、`failure-analysis-assignment.spec.ts`、`failure-analysis.spec.ts`、`failure-analysis-log-comparison.spec.ts`。
- 修正一处原有测试竞态：分析页刷新测试先卸载上一页轮询，避免将工作概览的快照请求误当作分析页请求；原始测试复验通过。
- 额外 4 组低频入口巡检全部通过，包含共享确认框、项目 / 版本 / 阶段选择和通知中心浮层。全局搜索浮层在 1536px / 1920px 复查，1024px 下搜索栏按现有桌面布局隐藏。

## 最终结论

54 个业务弹窗实现、共享确认入口及上述浮层已逐项打开检查。完成 10 类布局修复后，1024 × 768 与 1536 × 960 下未发现剩余的标题 / 操作区溢出、控件重叠或错误分栏；搜索浮层另在 1920 × 960 检查长结果。针对性回归验证提交、取消、草稿保护、冲突恢复和错误重试，检查结论限定于上述视口、数据与状态。
