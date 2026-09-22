# 组织管理与顶栏层级 UI 复查

本次调整合并项目/全局用户与角色入口，将项目、版本、阶段创建收进顶栏下拉，并保留项目资源与负责人设置。本报告记录提交前的 UI 遍历范围、发现的问题与验证边界。

## 遍历范围

使用 Lite 生产构建和独立测试数据，Playwright 检查 1024×768 与 1536×1024 桌面视口；授权弹窗另有 1536×960 覆盖。遍历 23 个主页面/子页签入口，并覆盖相关弹窗、长文本、空状态和权限差异。

| 页面组       | 具体入口与操作                                                                               |
| ------------ | -------------------------------------------------------------------------------------------- |
| 工作台与资产 | 工作概览、TestNG 用例、用例任务、文件来源、执行记录                                          |
| 执行与分析   | 执行节点、执行机组、质量洞察、用例分析、全局执行弹窗                                         |
| 项目层级     | 项目/版本/阶段下拉、搜索与创建、空层级、项目设置、25 个版本的资源配置、长项目名与 64 位 Slug |
| 组织管理     | 全平台用户、当前项目成员、角色权限、目录配置、登录会话、创建用户和授权弹窗                   |
| 平台管理     | 回调通知、安全审计、平台配置、服务账号、数据保留、系统诊断、存储空间、账号安全               |
| DDT 补充检查 | 左右分栏用例工作台、公开 API 子页签、高级检索与详情弹窗                                      |

## 发现与修复

| 问题                                   | 原因                                                        | 修复与验证                                                                             |
| -------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 顶栏下拉关闭时方向键没有作用           | 键盘逻辑只查找已挂载的选项                                  | 方向键打开并定位已选项；覆盖搜索后向上选择、Esc 关闭及焦点恢复                         |
| 重复选择当前版本时偶发焦点丢失         | 无变化仍提交切换请求，禁用按钮使焦点丢失                    | 选择当前项只关闭下拉；验证两种视口的焦点及零切换请求                                   |
| 长用户显示名撑高整行                   | 表格完整展开显示名                                          | 复用两行可展开文本组件，同时保留完整名称、鼠标提示与键盘展开按钮                       |
| 角色范围默认显示“请选择”，缺失系统选项 | 自定义 Select 只解析直接子选项，Fragment 包裹的两项未被识别 | 将选项改为直接子元素，验证系统、项目、全部范围互相切换和过滤结果                       |
| 角色绑定搜索提交后结果区折叠           | 服务端刷新后恢复了折叠区默认状态                            | 存在用户搜索条件时保持结果展开；使用显式搜索验证末页用户，测试不再假定管理员总在第一页 |

复查确认：无额外项目侧栏入口，旧成员 URL 正确重定向；新建操作遵守系统/项目权限；创建后切换失败不会重复创建。多版本资源页保持限定高度，搜索不改变当前配置目标，保存期间不能切走版本。长项目名和 Slug 没有挤出按钮或横向溢出。

## 实际截图

均由真实浏览器生成并查看，以下保留代表性截图；较长页面使用完整页面截图，标注宽度指浏览器视口宽度。

| 检查点                 | 1024 像素宽                                                                     | 1536 像素宽                                                                     |
| ---------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 用户长名称与授权入口   | [截图](./organization-ui-review-2026-09-23/user-role-entry-1024.png)            | [截图](./organization-ui-review-2026-09-23/user-role-entry-1536.png)            |
| 顶栏项目下拉与创建入口 | [截图](./organization-ui-review-2026-09-23/1024-topbar-project-actions.png)     | [截图](./organization-ui-review-2026-09-23/1536-topbar-project-actions.png)     |
| 角色绑定搜索结果       | [截图](./organization-ui-review-2026-09-23/role-bindings-filtered-1024.png)     | [截图](./organization-ui-review-2026-09-23/role-bindings-filtered-1536.png)     |
| 重复选择后保持键盘焦点 | [截图](./organization-ui-review-2026-09-23/1024-topbar-keyboard-selection.png)  | [截图](./organization-ui-review-2026-09-23/1536-topbar-keyboard-selection.png)  |
| 多版本资源配置         | [截图](./organization-ui-review-2026-09-23/1024-organization-many-versions.png) | [截图](./organization-ui-review-2026-09-23/1536-organization-many-versions.png) |

## 执行结果

- `pnpm exec playwright test tests/e2e/ui-layout.spec.ts tests/e2e/identity-rbac.spec.ts tests/e2e/management-operations.spec.ts`：首轮 35 项通过；补充三个边界场景，并对发现的问题先复现再修复。修复后按影响范围重跑，最后一轮 23 项全部通过。重跑期间发现的旧测试第一页假设已改为显式搜索，搜索结果折叠问题也已修复。
- `pnpm exec playwright test tests/e2e/ddt-management.spec.ts --grep 'DDT split workspace|DDT public API reads|DDT advanced search submits'`：3 项通过。连同管理与 UI 验证，本次共 41 个独立场景取得通过证据，未开启 Playwright 自动失败重试。
- `pnpm exec vitest run apps/web/src/components/ui-usage.test.ts apps/web/src/lib/auth.test.ts apps/web/src/lib/client-api.test.ts apps/web/src/lib/auth-entry-validation.test.ts`：24 项通过。
- `pnpm format:check`：全仓格式及许可证检查通过；最终修改文件再次检查通过。
- `pnpm exec eslint ... --max-warnings=0`：修改的前端与 E2E 文件通过。
- `pnpm --filter @autoforge/web typecheck`、`pnpm exec tsc --noEmit -p tsconfig.tests.json`、`pnpm --filter @autoforge/web build`：通过，最终修复后生产构建再次通过。
- `git diff --check`：通过。

## 验证边界

UI 遍历结合实际截图检查与 DOM 几何断言，不能代替所有生产数据规模和全部执行故障场景。本次未改变数据库或执行协议，沿用既有 Lite/Full 业务接口；双架构离线镜像、完整源码质量和已发布资产由 Release 工作流矩阵验证。

## CI 补充修复

v1.17.22 的 CI 暴露了本地首次检查未复现的重复选择焦点问题，以及迁移/快照集成测试触发默认 5 秒超时。已将该 Release 转回草稿，保留原标签，修复后使用 v1.17.23 发布。

- 顶栏补充修复后，三项相关 Playwright 回归通过；再次查看 1024×768、1536×1024 截图，焦点提示可见、布局无溢出。
- 迁移和快照测试各自创建隔离数据库并回放历史 schema，设置明确的 30 秒集成测试上限，不修改业务超时、不重试测试、不放宽断言。
- 真实 SQLite/PostgreSQL 上重新执行迁移与快照集成测试：24 项通过；修改文件 lint、测试类型检查及 Web 生产构建通过。
