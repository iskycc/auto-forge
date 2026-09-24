# v1.18.6 界面细节复查

本轮以 v1.18.6 为基线，复查实际带数据的页面及共享 Ant Design 组件。页面主体已使用 Ant Design；目前更明显的问题集中在组件组合、表单反馈位置和管理页面的信息密度。

## 检查范围

使用生产构建、独立的 Lite 测试数据目录和合成账号。夹具包含 65 条 DDT 用例、TestNG 来源、任务与执行结果、失败分析、离线执行机、多用户、服务账号、Webhook 和字段模板，并使用长名称、长描述验证边界。

首轮检查 35 个页面／子页，在 1024×768、1536×960 的浅色和深色主题下生成 140 张截图，逐页查看截图总览，并对疑似问题查看原始截图。另检查 12 个列表和弹窗状态，共 48 张截图。自动布局检查包括页面和卡片溢出、控件重叠、字号、点击区域与脚本错误；人工检查层级、对齐、间距、换行与操作位置。

| 页面组 | 本轮覆盖 |
| --- | --- |
| 概览与质量 | 工作概览、质量洞察的统计及图表 |
| 用例 | TestNG 树、详情；DDT 概览、用例、检索、导入、模板、回收站、开放 API、SR 关联 |
| 执行与分析 | 任务列表、最近执行、任务详情、执行记录、批次详情、分析任务、分析工作区及分析弹窗 |
| 资源 | 执行节点、执行机组、文件来源、存储清单 |
| 组织 | 项目版本设置、用户、项目成员、角色、LDAP、登录会话、账号安全 |
| 平台 | 配置、服务账号、权限分配、保留策略、诊断、Webhook、安全审计 |

首轮 188 个布局状态没有检出新的页面溢出或脚本错误；这不等于没有视觉问题。以下按钮间距和表单布局问题由截图检查确认，并补充能够在修改前失败的回归测试。

随后重复遍历 35 个页面，并增加 11 个长页面的底部检查，共 184 个状态。底部检查发现任务详情“完成通知”的长名称／URL 溢出，已单独加入缺陷回归，不能将首屏检查结果视为整页均无问题。

## 本轮已修复

| 问题 | 用户影响 | 调整 |
| --- | --- | --- |
| 共享弹窗底部按钮没有统一布局 | 创建用户、服务账号、任务和跨版本继承等弹窗的按钮贴在一起或靠左；其他弹窗却靠右 | 共享操作栏使用 Ant Design Flex，按主题间距分隔并靠右对齐，保留正文滚动和底部操作区 |
| 密码框缺少显隐入口 | 登录、创建用户、修改密码、SSH 安装等场景无法核对输入 | 共享密码输入切换为 Ant Design Input.Password，默认隐藏；支持点击和键盘显隐，保留原表单值、校验、自动填充和 ref，表单重置后重新隐藏 |
| 账号安全页提交按钮与字段错位 | 原两列网格把提交按钮放在确认密码旁，与标签错位；大屏下按钮被拉成整列 | 当前密码独立成行，新密码与确认密码同行，说明和主按钮位于独立底部操作区 |
| 账号安全页错误脱离操作区域 | 密码或会话操作失败后统一显示在整页最上方，用户难以对应操作 | 密码错误放在密码表单内，会话错误放在会话区域；使用 Ant Design Alert，强制改密及 LDAP 提示也统一为 Alert |
| 提交过程缺少明确反馈 | 修改密码期间只有禁用状态 | 使用 Ant Design Button 的 loading 状态，仅在密码请求期间显示，不与终止会话混淆 |
| 任务完成通知的选项撑宽页面 | 旧样式按 span 顺序定位文本，并影响 Ant Design 内部 label；1024px 实测卡片越界 118px，长 URL 的独立夹具越界 1953px，复选框还多了一层边框 | 选项改为有完整标签的 Ant Design Checkbox，明确文本可收缩区域；名称换行、URL 截断并保留完整提示；方法使用 Tag，空状态使用 Empty，保存使用 Button loading |

新增回归检查验证按钮间距和对齐、表单值保持、Enter／空格显隐、重置恢复隐藏、错误留在表单内，以及两次密码不一致时不发送修改请求。共享布局检查对带后缀输入框测量实际可点击的外层容器，与 Select／DatePicker 的检查方式一致，没有降低最小控件高度要求。

## 后续仍值得优化的细节

下面是本轮观察到的优化候选，尚未实施，不作为已经修复的功能描述。

| 优先级 | 位置与现象 | 建议采用的组件及验收重点 |
| --- | --- | --- |
| P2 | 用户表格将“更多操作”作为行内 Collapse，展开后会推高整行，用户多时扫描效率较低 | 保留“分配角色”常用入口，将禁用／解锁、撤销会话放入 Ant Design Dropdown；保留危险操作确认和权限判断，检查键盘菜单与焦点返回 |
| P2 | 角色页的卡片、权限明细、复制表单反复嵌套边框，四列卡片内的小字较密 | 用 Tag 表示范围／内置状态，权限明细采用较轻的 Collapse；复制操作独立 Modal，避免展开一张卡片拖高整排 |
| P2 | 服务账号与 Webhook 的长说明在列表占据较多高度 | 统一 Typography.Paragraph 的受控展开方式，默认展示摘要；保留查看全文与完整编辑，不能直接丢弃长文本 |
| P2 | 用户、服务账号、执行记录的搜索／筛选区采用不同的按钮宽度与换行规则 | 用共享的 Flex 操作组统一字段与查询按钮的对齐；在 1024px 验证查询、重置不被拆散，保留显式提交，避免改成即时数据库搜索 |
| P2 | DDT 检索、执行轮次、游标列表的翻页区信息排列不同 | 有可靠总数的列表统一 Pagination；游标接口保留上一页／下一页语义和已有页面缓存，不能为了页码新增实时全表计数或伪造总页数 |
| P3 | 顶栏部分图标仍用浏览器原生 title，帮助提示的外观与出现时机不统一 | 统一使用 Tooltip，保留 aria-label；检查键盘聚焦、弹窗打开后浮层关闭及暗色对比度 |

不建议为了增加 Ant Design 组件使用数量而替换业务虚拟列表、日志终端和有界目录加载，也不建议给每个信息块添加边框或动画。密度、稳定布局和大数据读取边界应继续优先。

## 验证记录

实际执行的检查：

- `pnpm --filter @autoforge/web build`：生产构建通过。
- `pnpm --filter @autoforge/web typecheck`、`pnpm exec tsc --noEmit -p tsconfig.tests.json`：通过。
- 变更 TypeScript 文件的 ESLint／Prettier、`git diff --check`、`pnpm test:e2e:matrix`：通过。
- `pnpm exec vitest run apps/web/src/components/ui/interaction-readiness.test.tsx apps/web/src/components/ui-usage.test.ts apps/web/src/lib/ant-design-theme.test.ts apps/web/src/components/ui/native-input-event.test.ts`：23 项通过。
- `pnpm exec playwright test tests/e2e/ui-layout.spec.ts --grep 'shared action dialog footers|password controls preserve'`：新增 2 项通过；修改前分别复现按钮无间距、密码显隐入口缺失。
- `pnpm exec playwright test tests/e2e/ui-layout.spec.ts --grep 'execution export dialog|remaining low-frequency|global dark appearance|LDAP actions span'`：4 项通过，覆盖导出选择、失败重试和下载、管理弹窗、登录／公开页主题、LDAP 启停布局。
- `identity-rbac.spec.ts` 中创建用户校验、强制修改密码与会话终止、管理员重置密码；`management-operations.spec.ts` 中服务账号生命周期、批量权限选择、草稿保护；`ddt-management.spec.ts` 中跨版本继承恢复；`jar-import.spec.ts` 中 TestNG 继承：合计 8 项通过。首次合并运行在这 8 项通过后收到 SIGTERM，剩余 4 项使用上一条独立命令完成，没有将未执行的检查算作通过。
- `pnpm exec playwright test tests/e2e/ui-layout.spec.ts tests/e2e/management-operations.spec.ts --grep 'task webhook choices|project webhooks support'`：Webhook 回调和绑定流程通过；新的长文本检查在修改前复现越界，修改后通过布局检查。首次键盘检查在刷新后、控件仍处于服务端禁用状态时发出了空格事件，补充等待控件可用后，使用 `--grep 'task webhook choices'` 单独复验通过，覆盖名称点击、保存、刷新保持选择、空格取消选择以及再次保存。

Playwright 使用 `AUTOFORGE_E2E_EXTERNAL_SERVER=1` 连接本轮生产构建，并设置独立的 `AUTOFORGE_E2E_DATA_DIR`。16 项端到端检查为定向回归，并非完整 E2E 套件。

已实际查看修复后的 1024×768、1536×960 浅色／深色截图：创建用户、服务账号、任务及继承弹窗的操作按钮间距一致，密码表单主操作位于字段下方，错误提示在表单内，登录框显隐图标与输入框对齐。导出弹窗同时复查了短桌面视口，保留可操作的底部区域。

任务完成通知另实际查看了两个视口的长名称、长 URL、停用端点及空状态截图，名称完整换行、URL 没有撑宽选项，复选框没有额外边框；大屏两列、小桌面一列，保存入口保持可见。
最终重新访问最初发现问题的任务详情，检查明暗主题、两个视口及页面底部共 8 个状态，未再出现页面／卡片溢出、控件重叠或脚本错误。

本轮不更改数据库、调度、Runner 协议、缓存刷新或权限规则，Lite／Full 共用这些前端组件。浏览器验收运行于 Lite；不等同于 Full 基础设施验收、真实 SSH 安装或在线 Runner 终端验收。截图与诊断文件保存在本地忽略目录 `.local/ui-refinement-1.18.6`，不提交图片、凭据、测试数据库或构建产物。
