# Ant Design 与原生组件排查（2026-09-26）

## 修复落实（2026-09-26）

本报告下方的两轮审查保留为修复前基线，原行号仅用于追溯。已将其中明确的迁移缺口及共享控件回退接入真实 Ant Design 组件：

| 范围                         | 当前实现与保留的行为                                                                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 错误、警告、操作成功、空结果 | 共享 Notice / EmptyState 使用 Alert / Empty；错误仍留在原弹窗或操作区域，空、等待、无权限分别显示。覆盖无 role 的来源操作与终端错误，以及安装、导入、恢复配置成功分支。                                             |
| 标签、头像、时间线           | 分析、DDT、SR、执行机、Webhook 等状态使用 Tag；顶栏与分析人员使用 Avatar；执行事件和公开日志历史使用 Timeline，保留顺序和链接。                                                                                     |
| 进度、加载                   | 补齐首页 4 处、DDT 导入任务、公开执行进度的 Progress；旋转等待使用 Spin 或 Button loading，保留已有数据后台同步。业务统计图仍使用原有绘图。                                                                         |
| 数字、时区、多选与校验       | 数字字段经 InputNumber，时区经 AutoComplete，允许合法的自定义 IANA 时区；Select 多选无可见原生回退。隐藏字段保留 FormData、约束和变更事件，字段错误用 Ant Typography 在表单内呈现，阻止浏览器气泡但不放行无效输入。 |
| 导航、分页、提示             | 用户范围使用 Tabs，执行机分页使用 Pagination，质量洞察仍按服务端游标翻页、使用 Ant 按钮；Button、LinkButton 与折叠路径提示使用 Tooltip。普通链接和页内锚点仍为语义导航。                                            |
| DDT 拖拽、侧栏               | 表格／ZIP 导入使用 Upload.Dragger，保留预检、列冲突、批量导入和取消；侧栏使用 Splitter，保留鼠标双向调整、键盘调整、恢复宽度、收起和独立滚动。                                                                      |
| 图片和异常入口               | 分析缩略图及大图使用 Image，预览保留缩放、还原、Escape、鉴权 URL 和粘贴草稿；三类无效分享链接及日志错误使用 Result。                                                                                                |

初始化引导使用 Steps，公开用例及方法启停状态使用 Tag。复测修正了 DDT 搜索框被旧选择器隐藏、多选默认数组在父组件重绘后覆盖用户选择、时区可访问名称混入选中值，以及图片工具提示抢占 Escape 关闭等兼容问题。数字字段和时区的标签指向可见输入，避免隐藏桥接字段形成重复操作目标。

截图检查还发现并修复了三个布局问题：倒计时执行时浏览器焦点会滚动固定弹窗外框，导致标题消失和底部空白；DDT 冲突提示迁移后内部图标与操作未正确对齐；首次初始化侧栏在浅色模式沿用白色文字。固定弹窗现在只滚动表单正文，初始化说明与步骤文字使用可读的主题色，管理员表单字段按顶部对齐。

### 验证记录

- `pnpm --filter @autoforge/web build`、`pnpm --filter @autoforge/web typecheck`、`pnpm exec tsc --noEmit -p tsconfig.tests.json`、相关源码 lint 和格式检查通过；共享 UI 边界、首屏就绪、表格与字段桥接测试共 25 项通过。
- 首轮 Playwright 主要路由遍历通过，覆盖 28 个页面／子页 × 1024×768、1536×1024 × 浅色／深色；已实际查看截图。带数据 DDT 导入、回收站、长 CaseID、双向拖动，以及密码和日期控件流程通过。
- 真实浏览器组件检查通过 FormData、整数／小数、多选、任意时区、必填拦截、错误定位、表单重置、图片缩放和 Escape。
- 20 个 Playwright 场景的最终结果通过，包含失败定位后的显式复测，未开启自动重试：DDT 导入／重复列／编辑恢复／侧栏／草稿保护，任务生命周期，分析粘贴图片／历史继承／导出，JAR 拖拽，平台配置冲突／时区／保存栏，公开统计刷新失败恢复，公开执行详情，首页、执行弹窗、Webhook、服务账号及通用输入控件。全屏图片预览按实际全屏边界、缩放比例、按钮可达和 Escape 检查；执行弹窗增加固定标题和操作栏不可被滚走的断言。
- 补充真实浏览器检查：三类无效分享入口在 1024px／1536px 均显示 Result；首次初始化及公开用例详情分别在 1024×960／1536×960、浅色／深色下截图复查，检查初始化文本对比度、错误反馈、只读状态和页面溢出。
- 离线资源门禁由 19 类扩展到 28 类组件样式，覆盖 InputNumber、AutoComplete、Splitter、Image、Upload、Tooltip、Avatar、Timeline 和 Steps。`node --test scripts/release/frontend-assets.test.mjs` 的 15 项测试通过；对生产构建复制出的全部 83 个静态文件逐一核对 SHA-256、必要样式及远程 CSS 引用，通过。此项不等同于已构建、安装或验收 Docker Release。
- 截图、浏览器记录和测试数据库保存在忽略的 `.local/ant-design-completion/`，不作为正式资源提交。此轮 UI 共用于 Lite/Full，不修改数据库、Runner/Adapter、缓存／快照契约或离线依赖；没有以 UI 验证代替 Full 基础设施、双架构 Docker 或离线安装验收。

### 补充全量回归验证

首轮的 20 个定向场景和页面截图不能替代完整功能回归。随后按标准 Playwright 清单继续运行全部场景，并对失败逐项定位、修改和显式复测；不启用自动失败重试，不删除业务断言。两次长运行收到 SIGTERM 后分组续跑，使用清单逐项汇总，不能将这批结果描述为一次连续运行全部通过。JAR 综合场景最终使用独立空库，避免多次运行产生同名来源夹具。

本轮回归发现并修复：

- DDT 测试类、分类及候选类的搜索框被旧 flex 样式压缩；字段布局应用于外层校验容器，输入仍保持完整宽度。
- 目录工具栏、权限多选、DDT API 选择及日志搜索的旧 flex-basis 作用到纵向字段内部，导致异常增高。日志日期字段另补约束，避免越过筛选区域；执行详情分页的选择器按内容宽度显示，文字保持横排。
- 安全审计搜索图标与文字重叠，改为仅对搜索输入设置对应留白。
- 多项目下拉未定位当前选项；改为在打开时只滚动菜单，并保留键盘焦点和页面位置。复测又发现动画结束后的延迟定位会移动点击目标，已改用菜单内布局坐标在打开时完成定位。
- 通知中心打开后，触发按钮的 Tooltip 遮挡关闭按钮；共享按钮在 aria-expanded 为 true 时隐藏提示，保留折叠时的鼠标与键盘提示。

测试同时适配真实 Ant Design 语义：Splitter 的 aria-valuenow 是百分比，拖动与键盘调整按实际宽度验收；通知与目录路径不再依赖原生 title 或全局同名文案，继续验证通知已读、存储树懒加载和深目录操作。

| 检查              | 实际结果与边界                                                                                                                                                                                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 标准浏览器回归    | `pnpm exec playwright test` 按清单分组执行并显式复测：20 个文件的 129 个场景最终全部通过，0 失败、0 未执行；`standard-e2e-results.json` 记录每项最终日志。覆盖导入、DDT、任务执行／恢复／日志、分析、权限、初始化、存储、审计和页面布局。最后 JAR 综合场景在独立空库运行 2.8 分钟通过。 |
| Web 测试          | `AUTOFORGE_TEST_REDIS_URL=… pnpm exec vitest run apps/web --maxWorkers=1`：114 个文件、464 项通过，无跳过；使用本地真实 Redis。最终 Tooltip 修正后追加 23 项共享 UI 回归通过。                                                                                                          |
| 应用与契约        | `pnpm exec vitest run packages/application packages/contracts --exclude '**/*.integration.test.ts' --maxWorkers=1`：49 个文件、401 项通过。                                                                                                                                             |
| 专项适配器        | Redis 日志转发、版本初始化应用与 SQLite/PostgreSQL 集成：3 个文件、16 项通过。与上两项存在覆盖重叠，不累加为去重总数。                                                                                                                                                                  |
| 类型、lint 与构建 | `pnpm typecheck` 全工作区通过；最终 Web 生产构建、测试 TypeScript 检查和变更源码 ESLint 通过。                                                                                                                                                                                          |
| 离线前端资源      | 15 项资源门禁测试通过；最终构建的 83 个静态文件逐一检查完整性与 SHA-256，28 类组件样式齐全，CSS 无远程引用。                                                                                                                                                                            |

带数据视觉审查覆盖 1024px 最小桌面和 1536px 大屏，安全审计另覆盖 1440px、1920px、2560px。实际查看了 DDT 关联／分类搜索、目录工具栏、日志筛选、安全审计和项目下拉截图，检查了文本、边界、操作位置和可见区域；项目下拉同时验证正常动效与减少动效；通知中心在两种宽度下单独验证悬浮提示、鼠标／键盘打开及关闭。首轮的 28 个路由 × 两个宽度 × 浅色／深色遍历仍保留。

证据保存在忽略的 `.local/ant-design-verification/`，包括逐场景结果、构建日志、截图和合成测试库；不提交截图、测试数据库或构建产物。本轮未执行完整 Full 故障注入、真实 Runner 跨架构安装、双架构 Docker Release 或断网离线安装验收，不能据此宣称所有部署组合或生产负载均已验证。

### 保留的原生结构

正文、布局、普通链接、表单／字段分组、隐藏桥接字段、Ant Table 自定义行、十万级目录懒加载与虚拟列表、图表／日志、复制下载兼容 DOM 和 Jenkins Jelly 按原审查边界保留。公开首页介绍卡片、介绍步骤及页内锚点是内容布局，不强行改成新交互；不存在将另一套基础控件体系作为可见回退的理由。

## 修复前结论与范围

当前界面尚未完全统一到 Ant Design。基础按钮、弹窗、表格、标签页和大部分表单控件已经接入，但部分页面仍用 HTML 与局部样式实现状态标签、提示、空状态和进度条。另有少量浏览器原生交互及共享组件的潜在回退分支。

本次对当前工作树的 `apps`、`packages`、`integrations`、`scripts` 中 777 个生产 TypeScript、JavaScript 与 UI 模板文件进行扫描，排除测试和夹具；使用 TypeScript AST 检查 JSX、导入和命令式 DOM 创建，并人工核查候选实现及调用入口。201 个文件包含 JSX，均在 `apps/web/src`，共 7,272 个 JSX 开始／自闭合节点。计数表示源码出现位置，不表示页面数或运行时实例数。

本轮只输出代码审查结果，没有改动 UI，也没有执行浏览器全页面验收。下面区分明确的组件迁移遗漏、可以统一的交互、应当保留的原生 DOM；不能把“没有直接导入 antd”或“存在 div”当成遗漏。

第二轮扩大到仓库文件清单、外置样式定义、动态组件、属性中的 JSX 和条件渲染，补查结果见下文“第二轮交叉复查”。**第一轮的 44 处只统计原生 `role="alert"`，不是全部提示；25 处只统计 Button，不含 LinkButton。** 已补充未带这些标记的遗漏。

## 明确需要补齐的展示组件

下表位置均相对仓库根目录；行号对应本次审查的工作树。P1 表示优先补齐常用流程，P2 表示后续统一，不代表已证实存在功能故障。

| 优先级 | 页面／场景           | 当前实现与位置                                                                                                                                                                                               | 建议                                                                                                                       |
| ------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| P1     | 平台配置：时区候选   | `apps/web/src/components/platform-settings.tsx:237` 的 Input 使用 `list`，`:246` 为原生 `datalist`                                                                                                           | 使用可搜索 Select 或 AutoComplete；保留自定义合法 IANA 时区及服务端校验                                                    |
| P1     | DDT 导入任务         | `ddt-management-workspace.tsx:1416` 的状态为 span，`:1429` 的进度为 div / i / 百分比宽度                                                                                                                     | 使用 Tag、Progress，保留后台导入、取消与冲突处理行为                                                                       |
| P1     | 工作概览             | `apps/web/src/app/page.tsx:459` 方法可执行率、`:519` 槽位占用、`:884` 执行批次进度、`:1084` 执行机组可用比例均手工绘制条形比例                                                                               | 将这 4 处简单进度／比例条接入共享 Progress；不改统计口径和数据刷新方式                                                     |
| P1     | 公开进度入口         | `public-run-progress.tsx:73` 状态、`:89` 进度条、`:64` 卡片仍手工构建                                                                                                                                        | 使用 Tag、Progress、Card；实际入口是 `/progress/[batchId]`，保留令牌校验与登录后的详情跳转，不与 `/share/run/[token]` 混淆 |
| P1     | 错误、警告、重试反馈 | 32 个文件共 44 处原生 `role="alert"` 提示，详见附录                                                                                                                                                          | 字段错误使用紧凑的表单错误呈现，区域提示复用 Notice / Alert，整页失败使用 Result；保留重试与焦点行为                       |
| P1     | 用例分析状态         | `failure-analysis-workspace.tsx:1036,1478,1488,2865`、`failure-analysis-conclusion-card.tsx:198`、`case-failure-analysis-history.tsx:211` 使用 span 与状态样式                                               | 统一 Tag，保留结论类别、认领人和文字状态，不依赖颜色表达                                                                   |
| P1     | 公开用例详情         | `apps/web/src/app/share/case/[token]/page.tsx:48` 起，信任标记、状态、属性区和方法卡片多数为自绘展示                                                                                                         | 状态和只读标记用 Tag，属性和方法信息按实际密度使用 Descriptions / Card；正文和语义布局不必全部替换                         |
| P2     | 分享失效和日志错误   | `apps/web/src/app/share/case/[token]/page.tsx:164`、`apps/web/src/app/share/run/[token]/page.tsx:84` 的失效链接；`shared-log-error.tsx:10` 的日志错误                                                        | 复用 Result，保留主题切换、错误说明和重试入口                                                                              |
| P2     | Webhook 投递状态     | `webhook-settings.tsx:749` 用 span 实现等待、发送、成功和失败状态                                                                                                                                            | 统一 Tag                                                                                                                   |
| P2     | 初始化页             | `apps/web/src/app/setup/page.tsx:37` 手工编号步骤；`:27,75,116` 及 `platform-initialization.tsx:116` 的状态／必需／可选标记                                                                                  | 使用 Steps、Tag；部署模式继续是只读部署信息，不改成随手切换的模式开关                                                      |
| P2     | 其他小标签           | `apps/web/src/app/runners/page.tsx:72,168`、`apps/web/src/app/objects/page.tsx:106`、`apps/web/src/app/cases/[caseId]/page.tsx:84`、`case-selection-table.tsx:960`、`ddt-management-workspace.tsx:1558,1566` | 统一 Tag / Badge，避免继续扩展 `storage-pill`、`ddt-group-tag` 等自绘视觉组件                                              |

没有写目录前缀的组件名均位于 `apps/web/src/components/`。上表中的公开日志错误也计入 44 处提示，不能累加为独立问题数量。

### 成功、说明及日志告警

除了带 `role="alert"` 的提示，以下位置也仍以普通 div / p 呈现。应按语义接入共享 Notice / Alert，避免每个页面各定义一套反馈样式。

| 场景                               | 组件位置                                                             |
| ---------------------------------- | -------------------------------------------------------------------- |
| 平台部署配置说明                   | `platform-settings.tsx:159,168`                                      |
| 初始化配置说明、写入成功后重启提示 | `platform-initialization.tsx:76,126`                                 |
| 登录通知                           | `auth-entry-form.tsx:92`                                             |
| Runner 安装、回退和升级成功        | `runner-agent-installer.tsx:641,651`；`runner-update-dialog.tsx:384` |
| JAR 来源、发现结果说明和导入成功   | `jar-importer.tsx:499,506,532,734`                                   |
| 日志截断、缺失序号和对比范围提示   | `attempt-log-viewer.tsx:350,355`；`attempt-log-comparison.tsx:252`   |
| 用例选择反馈、结果导出范围提示     | `case-selection-table.tsx:771`；`run-batch-export-dialog.tsx:163`    |
| 质量洞察样本范围比较               | `apps/web/src/app/insights/page.tsx:1070`                            |

扫描还找到 72 处原生 `role="status"` 容器。这不是 72 个遗漏：其中包含无障碍播报、统计说明以及已经包住 Ant Design Spin / Progress 的外层区域，应逐项识别，不能批量替换所有 `role="status"`。

### 空状态

以下自绘空状态可接入共享 EmptyState / Ant Design Empty，并提供紧凑尺寸，避免将一行无结果提示替换成占满屏幕的大插画。

| 页面／区域                     | 位置                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| 安全审计、执行记录             | `security-audit-table.tsx:30`；`apps/web/src/app/execution-records/page.tsx:234`                                         |
| 分析列表、分析统计             | `failure-analysis-workspace.tsx:731,918`；`failure-analysis-statistics.tsx:205`                                          |
| 用例详情未选择、DDT 未匹配     | `case-selection-table.tsx:892`；`ddt-case-browser.tsx:232`                                                               |
| 任务成员筛选无结果             | `case-suite-details.tsx:376,404,515`                                                                                     |
| 批次对比、用例分析历史         | `batch-comparison-details.tsx:243`；`case-failure-analysis-history.tsx:102`                                              |
| 服务账号、用户列表             | `operations-settings.tsx:463`；`access-settings.tsx:512`                                                                 |
| 版本／阶段列表                 | `project-structure-manager.tsx:399,540`                                                                                  |
| 存储文件、Runner 异常          | `storage-inventory.tsx:573`；`runner-fault-dialog.tsx:56`                                                                |
| 执行明细、产物、事件、节点列表 | `run-batch-rounds.tsx:1638,2163,2226,2278`                                                                               |
| 复选列表、搜索浮层、层级选择   | `checkbox-group.tsx:206`；`configuration-search.tsx:254`；`topbar-tools.tsx:207,328`；`project-hierarchy-picker.tsx:107` |

图表尚未有数据、后台统计准备中、加载失败和无权限是不同状态，不应统一改成“暂无数据”。已经作为 EmptyState 图标传入的原生 span 也不属于遗漏。

## 可以统一的交互和潜在回退

这些项目不应与“业务页面直接使用裸原生控件”混为一谈。

| 项目         | 当前情况                                                                                                       | 后续处理边界                                                                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 数字输入     | 9 个组件中 27 处 `<Input type="number">`；共享 `ui/input.tsx:31` 实际渲染 Ant Design Input，而不是 InputNumber | 属于已经使用 Ant Design、仍保留浏览器原生数字行为的情况。统一为 InputNumber 前须验证空值、整数、小数步长、上下限、FormData、ref 和表单重置                |
| 原生多选回退 | `ui/native-select-bridge.tsx:92` 起，`multiple=true` 会显示原生 select，并跳过 AntSelect                       | 当前未发现业务 `<Select multiple>` 调用，属于潜在缺口；可接入 AntSelect 多选模式，同时保留隐藏表单桥接                                                    |
| 鼠标提示     | 16 个文件共 25 处 Button 的 `title`；当前源码未使用 Ant Design Tooltip                                         | 优先统一图标操作的 Tooltip 和键盘提示。并非所有 title 都需删除，时间 UTC 原值、全文补充等需保留可访问方式                                                 |
| 加载图标     | 35 个文件共 61 处 LoaderCircle JSX 调用，多处配合 CSS 旋转                                                     | 图标并非原生表单控件，也不是另一套 UI 库。按钮等待状态优先使用 Button loading，独立等待用 Spin；动态状态图标不机械替换                                    |
| DDT 导入拖放 | `ddt-management-workspace.tsx:1878` 起使用 Ant Button、手工拖放事件及隐藏文件字段                              | 已使用 Ant Button，不是裸原生按钮。若进一步统一上传体验，可评估 Upload.Dragger，保留多表格／ZIP、重复列冲突、取消和实际上传协议；JAR 导入已有对应上传组件 |
| DDT 侧栏分隔 | `ddt-case-browser.tsx:256` 为自定义 separator，管理鼠标、键盘和侧栏宽度                                        | 可评估 Splitter；必须保留收起、宽度边界和列表布局，不能仅为替换组件破坏已修复的拖动功能                                                                   |

数字输入和 Button title 的完整位置列于附录。源码中也有动态组件或属性展开，静态数量不代表穷举了所有运行时提示和加载状态。

## 不应判为迁移失败的原生结构

- 布局和正文：`main`、`section`、`div`、标题、段落、链接、`time`、`code`、`pre` 可以保留；Ant Design 不要求把所有 HTML 换成组件。
- 表单：59 处原生 form 是浏览器提交和 FormData 容器，内部可以使用真实 Ant Design 控件。13 处 fieldset、8 处 legend 也可以承担分组、禁用及可访问语义，不能按数量认定未迁移。
- 隐藏字段与文件字段：扫描到的 10 处原生 input 包含隐藏状态字段、共享文件控件及日期桥接。文件选择必须使用浏览器文件能力；Ant DatePicker 的隐藏字段和普通 AntSelect 的隐藏 select 负责兼容表单提交。
- 表格桥接：唯一原生 table 在共享 Ant Design Table 的自定义渲染实现中；thead / tbody / tr / td 不是另一套独立业务表格。
- 大目录与虚拟列表：用例选择、任务成员、存储目录的自定义 tree 语义服务于懒加载、窗口化和业务勾选。不能为了使用 Tree 而一次加载所有节点或破坏十万级任务能力。
- 表格列宽拖动：`execution-records-table.tsx:291` 的 separator 是列宽扩展行为，不等同于另一套页面分栏控件。
- 图表与日志：业务 SVG、方法结果分布、失败原因排行、DDT 分组排行、存储分类容量图、日志虚拟列表、专用滚动区域和 xterm 不必强行换成 Ant Design 基础组件。简单进度条与业务统计图应分开判断。
- 命令式 DOM：`client-clipboard.ts` 的不可见 textarea 用于剪贴板兼容；下载时创建的 a 用于触发文件下载，不是展示层遗漏。
- 浏览器离页保护：beforeunload 的原生提示受浏览器控制；页面内部的确认操作已经有 Ant Design 确认组件，不应误将同名 `confirm` 回调认作 window.confirm。
- Jenkins 的两份 Jelly 描述模板属于 Jenkins 插件页面，不是 React 主平台；不能在模板中直接替换成 Ant Design React 组件。

本次扫描未发现业务 JSX 直接声明原生 button、textarea、details、summary、progress、meter、dialog，也未发现活动的 shadcn/ui、Radix、MUI、Chakra 或 Headless UI 导入。这个结论只说明基础控件边界较完整，不代表所有自绘展示已迁移。

## 自动检查为什么没有发现这些遗漏

`apps/web/src/components/ui-usage.test.ts` 当前 16 项测试全部通过，但检查边界不完整：

1. 原生控件正则未检查 datalist，并豁免整个共享 UI 目录，不能识别 Select 的可见原生多选回退。
2. 自绘控件检查聚焦 dialog、tab 和 table，无法发现使用 div / i / span 绘制的进度条。
3. 提示／标签／空状态检查只匹配少数旧类名与元素类型；例如 small、`setup-form-error`、`inline-feedback`、`analysis-status`、`ddt-status` 可以绕过。
4. 导入了 antd 不意味着所有分支都使用其组件；反过来，业务组件经过共享封装使用 Ant Design，也不必直接导入 antd。

后续修复应先为上述真实遗漏补回归，再缩小共享组件豁免范围并检查具体分支。不要用“禁止所有 div / span / role”代替语义判断，也不要仅靠 className 黑名单声称完成全面验收。

## 建议实施顺序与验证

1. 先处理时区、DDT／首页／公开页进度，以及常用表单、分析和导入错误反馈；复用已有 Notice、Progress、Badge、EmptyState。
2. 再处理分析和 Webhook 标签、公开分享错误页、初始化页及其他空状态。
3. 单独验证数字输入桥接、Tooltip、加载状态和可见多选回退；分隔和目录组件是否替换应由功能收益决定。
4. UI 修复后使用带数据的 Playwright 覆盖 1024px 和代表性大屏，实际查看浅色／深色、长文本、加载、错误、空状态和嵌套弹窗截图；重点检查列表不丢位置、错误留在当前弹窗、表单值不丢失。

本轮实际运行：`pnpm exec vitest run apps/web/src/components/ui-usage.test.ts`，16 项通过。源文件扫描只读运行，报告修改另经格式与差异检查。没有修改运行代码，因此本轮未重复构建、Lite / Full 集成或 Playwright；不能把本轮的静态审查称为运行时全量验收。

## 第二轮交叉复查

### 检查方法与覆盖边界

第二轮从仓库 1,690 个非忽略文件重新枚举，扫描 784 个非测试的脚本、源码、样式和界面模板文件，包含第一轮未纳入的根配置、部署脚本和 `theme.css`。JSX 文件仍为 201 个，节点仍为 7,272 个；原生节点 4,237 个、组件节点 3,035 个，未发现另一套遗漏在扫描目录之外的 React 界面。

这次额外核查了 387 处带状态／交互特征的原生节点、194 处包含错误／空结果／加载等文案的原生节点候选，并交叉检查了 JSX 祖先、实际导入、动态组件分支与调用入口。这些候选有重叠，也包含正常布局，不能作为问题总数。属性内部的 JSX 也纳入遍历，例如 `Alert.description` 中的文字不是独立的自绘 Alert。

共享组件逐项追踪到实际实现：Button → AntButton；Input → AntInput / Password 或 Checkbox / Radio；Textarea → Input.TextArea；普通 Select → AntSelect；日期 → DatePicker；Dialog → Modal；Disclosure → Collapse；Tabs → AntTabs；Card、Badge、Progress、Skeleton、EmptyState、Notice 分别使用对应 Ant 组件；右上角通知使用 notification。Select 的可见多选回退仍是第一轮记录的例外。不能因 `Card as="article"`、`Choice`、`InputControl` 或隐藏原生字段而误判。

检查了命令式 DOM、字符串 HTML 注入、浏览器对话框和其他模板后，未发现另一个生产原生表单／弹窗入口。下载锚点、剪贴板兼容字段、Jenkins Jelly 和图标 SVG 继续按用途保留。47 个包含 JSX 的路由视图／布局／加载文件及其业务组件均纳入扫描；不含 JSX 的重定向和转导出文件也在源码清单中。

建议组件在仓库已安装的 Ant Design **6.6.5** 本地导出中可用，不需要引入第二套组件库或在线资源。上述覆盖是源代码检查，不代表每个权限、空数据和失败分支已在浏览器实际触发。

### 第一轮遗漏的交互和展示

| 优先级 | 场景                   | 位置                                                                            | 结论与建议                                                                                                                                 |
| ------ | ---------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| P1     | 文件来源操作错误       | `source-actions.tsx:69`、`source-lifecycle.tsx:255`                             | 两处 small 直接显示错误，无 `role="alert"`，第一轮未列为提示缺口；接入紧凑 Notice / Alert，保留错误所在操作区域                            |
| P1     | 终端授权错误           | `runner-terminal.tsx:320`                                                       | span 直接显示错误，无 `role="alert"`；接入 Notice，保留终端连接和重试流程                                                                  |
| P1     | 用户管理范围切换       | `access-settings.tsx:435`                                                       | “全平台用户／当前项目成员”由 nav + Next Link 自绘选中样式，未经过 Ant Tabs / Segmented；可统一为共享导航组件，必须保留 URL、权限和前进后退 |
| P1     | SR 关联状态            | `ddt-sr-associations.tsx:294`                                                   | 普通 span 显示旧关联待确认、不可用、已关联／未关联；使用 Tag，保留这些不同业务状态                                                         |
| P1     | 执行机状态             | `apps/web/src/app/runners/page.tsx:297`、`apps/web/src/app/page.tsx:1121`       | span + i 自绘状态；统一 Tag / Badge，保留状态文字                                                                                          |
| P1     | 日志分享链接无效       | `shared-attempt-log-content.tsx:418`                                            | `InvalidAttemptLogShareView` 是原生 section + 图标 + 标题；此前只列了用例分享、批次分享和日志错误，漏了这个独立分支。使用 Result           |
| P2     | 执行尝试状态时间线     | `run-batch-rounds.tsx:2230`                                                     | ol / li + `timeline-marker`，未使用 Timeline；可统一组件，保留事件顺序、状态、原因码和时间                                                 |
| P2     | 公开日志执行历史时间线 | `shared-attempt-log-content.tsx:295` 及 `:490` 附近样式                         | ol / li 配合伪元素连线和圆点；可统一 Timeline，保留当前 attempt 高亮、日志链接和历史顺序；内部 Tag 已是 Ant，不能重复判为未迁移            |
| P2     | 顶栏头像、分析人员头像 | `app-shell.tsx:363`、`failure-analysis-statistics.tsx:231`                      | 两处 span 自绘圆形图标／姓名首字；使用 Avatar                                                                                              |
| P2     | 执行机分页             | `apps/web/src/app/runners/page.tsx:382`                                         | 自绘上一页／下一页 Link 和页数；已知总页数，可统一 Pagination，保持现有 URL 筛选                                                           |
| P2     | 质量洞察分页           | `apps/web/src/app/insights/page.tsx:1433`                                       | 自绘上一页／下一页 Link；此处是游标分页，应使用共享 Ant 翻页操作，不能为了页码而新增全量计数或改成 offset 查询                             |
| P2     | Webhook 方法、启用状态 | `webhook-settings.tsx:281,289`                                                  | 第一轮只列了投递状态，方法标签和启用／停用标记也仍是 span / i；统一 Tag / Badge                                                            |
| P2     | 终端连接状态           | `runner-terminal.tsx:275`                                                       | span / i 绘制连接状态；使用 Badge / Tag，保留连接阶段文字                                                                                  |
| P2     | 近五批成功标记         | `failure-analysis-workspace.tsx:1515`                                           | `RecentSuccessBadge` 名字含 Badge，但实际返回 span；使用共享 Badge，并保留同任务历史范围和悬停说明                                         |
| P2     | 工作概览补充状态       | `apps/web/src/app/page.tsx:330,912,1078`                                        | 质量等级、最近批次状态、执行机组在线点为自绘展示；统一 Tag / Badge。数值变化趋势与图例不是独立状态控件，不机械替换                         |
| P2     | 公开首页统计状态       | `public-control-preview.tsx:75`                                                 | `styles.snapshotStatus` + div / i，标记使用外置样式和 `data-tone`；接入 Badge / Alert，保留缓存过期、失败和同步中的不同说明                |
| P2     | JAR 扫描警告列表       | `jar-importer.tsx:515`、`apps/web/src/app/case-sources/[sourceId]/page.tsx:170` | div 列表 + AlertCircle 自绘警告；使用紧凑 Alert 及有界列表，不改扫描警告数量限制                                                           |
| P2     | 文件来源预览范围说明   | `apps/web/src/app/case-sources/[sourceId]/page.tsx:194`                         | 原生 `role="status"` 说明块，第一轮只列了导入弹窗中的同类提示；统一 Notice                                                                 |
| P2     | 恢复配置验证成功       | `case-suite-editor.tsx:1116`                                                    | `aria-live` 容器手工绘制成功结果；第一轮列了失败分支，成功分支也应统一 Notice                                                              |
| P2     | 结果解析上限说明       | `run-batch-rounds.tsx:2351`                                                     | 原生 p 提示明细达到解析上限；使用紧凑 Notice，保留“汇总仍完整”的区别                                                                       |
| P2     | DDT 列名处理方案摘要   | `ddt-management-workspace.tsx:2429`                                             | 自绘图标、保留／删除计数和 `aria-live` 说明；可统一 Alert，不能改变它在冲突列表下方的位置                                                  |

前三个未带 `role="alert"` 的错误提示与原有 44 处不重叠。因此当前已明确定位到 **至少 47 处原生错误、警告或确认提示**；这个数字仍不包含上表中的所有成功、说明、扫描警告列表和表格内业务错误摘要。

### 图片、导航及交互的补充边界

- 分析图片共有 5 处原生 img：`failure-analysis-remark.tsx:161,187`、`failure-analysis-workspace.tsx:2365,2620`、`case-failure-analysis-history.tsx:183`。目前使用 Ant 按钮／Dialog 承载，但预览、缩放和图片状态由业务代码手工维护；可单独评估 Ant Image / PreviewGroup。图片本身的 HTML 不是缺陷，需保留浏览器会话鉴权、粘贴草稿 object URL 清理、嵌套弹窗焦点和缩放功能，不能改成服务端代取鉴权图片。
- `apps/web/src/app/case-suites/[suiteId]/page.tsx:102`、`platform-settings.tsx:176` 的分区入口为普通锚点导航，可以评估 Anchor；它们不是原生 Tabs，也不应把页面内滚动改成销毁表单的切页。公开首页 `public-dashboard.tsx:74` 的锚点及 `:239` 的执行链路是介绍内容，可保留语义 HTML；如果统一视觉，可使用 Anchor / Steps，但不属于新增功能。
- `public-dashboard.tsx:306,331` 的 Metric / CapabilityCard 和公开概览指标仍是手工信息布局，可以进一步使用 Statistic / Card 统一视觉；不要把所有介绍文字、业务信息布局或普通导航 Link 都算作原生控件。
- 第一轮列出的 25 处 Button title 之外，还有 `app-shell.tsx:339,354` 和 `run-batch-permanent-share.tsx:91` 三处 LinkButton title，图标操作提示候选合计 **28 处**。此外，Disclosure 将 `headerTitle` 转为原生 title，当前用于 `storage-inventory-tree.tsx:184`、`case-selection-table.tsx:1299` 的完整路径；这类内容提示与操作 Tooltip 分开处理。
- 第一轮的 61 处 LoaderCircle 也不是全部加载图标。`refresh-audit-button.tsx:19`、`public-control-preview.tsx:66`、`ddt-management-workspace.tsx:735`、`case-suite-manager.tsx:170`、`run-batch-rounds.tsx:1627` 使用 RefreshCw 旋转，`public-run-progress.tsx:80` 使用动态 StatusIcon。应按照是否正在等待操作接入 loading / Spin，不能只搜索 LoaderCircle。
- `failure-analysis-workspace.tsx:1528` 名为 Pagination 的函数是业务游标翻页组合，内部已用 Ant Button，并非 Ant Pagination，但也不是原生按钮遗漏。共享 `cursor-pagination.tsx`、审计分页、批次对比分页同理；DDT 高级检索的 `ddt-search-pagination.tsx` 已直接使用 Ant Pagination。保持已知总数与游标“有下一页”的不同契约。
- `Input` 的 file / hidden 分支已逐处核查：业务 DDT 文件输入为隐藏字段，其他文件选择入口经 FileInput 或 Upload 包装；未发现另一处直接可见的浏览器默认文件输入。属性展开、动态 Checkbox / Radio、TextArea、日期桥接均未发现新的可见原生回退。
- 表单校验反馈也有浏览器原生交互：59 处 form 中，仅 `auth-entry-form.tsx:86`、`platform-initialization.tsx:138`、`create-user-dialog.tsx:147` 所在表单显式设置 noValidate。任务创建、编辑、复制等表单保留 required、min、max 等浏览器约束，提交时仍可能先出现浏览器默认校验气泡，而非 Ant 表单错误。后续统一时必须先提供等价的字段校验与错误定位，再考虑关闭原生提示；不能直接批量加 noValidate 导致无效输入被放行。登录、创建用户、初始化已关闭此类提示，不应误列为相同问题。

### 第一轮遗漏的空、等待和权限分支

以下均已核查具体分支；“空”“等待”“无权限”“条件不完整”须分别保留，不要统一显示成“暂无数据”。同一文件中的多个位置代表不同分支。

| 场景                                               | 补充位置                                                                                                                                                                                                     | 建议                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| 首页无执行机、无活动、无最近动态、无趋势／失败聚类 | `apps/web/src/app/page.tsx:534,624,690,902,942`                                                                                                                                                              | 紧凑 EmptyState；图表保留固定区域高度                                        |
| 质量洞察列表、图表及详情弹窗                       | `apps/web/src/app/insights/page.tsx:392,401,485,493,557,619,1168,1372`                                                                                                                                       | 区分无结果、样本不足、无用例；复用紧凑 EmptyState                            |
| 质量洞察缺少项目、未选比较批次                     | `apps/web/src/app/insights/page.tsx:669,721`                                                                                                                                                                 | 引导型空状态或 Notice，保留选择说明                                          |
| 执行机筛选、执行机组无成员                         | `apps/web/src/app/runners/page.tsx:265`；`runner-group-manager.tsx:343`                                                                                                                                      | 紧凑 EmptyState，不混同未注册执行机                                          |
| 项目设置、Webhook 无可访问项目                     | `apps/web/src/app/settings/projects/page.tsx:66`；`apps/web/src/app/settings/webhooks/page.tsx:36`                                                                                                           | 根据权限上下文使用 Notice / EmptyState                                       |
| 用例筛选、目录未就绪／无匹配                       | `execution-case-filter.tsx:174`；`case-selection-table.tsx:845`                                                                                                                                              | 无匹配用 EmptyState，未就绪用 LoadingState                                   |
| 用例源码缺失                                       | `lazy-case-source.tsx:79`                                                                                                                                                                                    | 紧凑 EmptyState，仍按展开加载                                                |
| DDT 修改历史、候选测试类                           | `ddt-case-browser.tsx:721`；`ddt-requirement-categories-dialog.tsx:558`；`ddt-sr-associations.tsx:695,813`                                                                                                   | EmptyState 保留候选范围为空、无匹配测试类及导入配置指引                      |
| DDT 列内容全空                                     | `ddt-management-workspace.tsx:2349`                                                                                                                                                                          | 小型字段说明即可，不强制放大为空页面                                         |
| 角色分配四类空状态                                 | `user-role-assignment-dialog.tsx:181,217,287,302`                                                                                                                                                            | 已分配为空、系统角色为空、项目角色为空、无可分配项目分别显示                 |
| 继承结论、同任务历史、历史执行                     | `failure-analysis-conclusion-card.tsx:150`；`failure-analysis-conclusion-picker.tsx:191`；`failure-analysis-workspace.tsx:2842`；`failure-analysis-execution-history.tsx:143`                                | 统一紧凑 EmptyState；不扩大跨任务继承范围                                    |
| 分析分配无人员、分析人员无内容                     | `failure-analysis-assignment-dialog.tsx:184`；`failure-analysis-statistics.tsx:310`                                                                                                                          | EmptyState 保留筛选／权限提示                                                |
| 最近执行为空、计划无权限或未关联范围               | `case-suite-recent-executions.tsx:140`；`case-suite-schedule-dialog.tsx:143`                                                                                                                                 | 空结果与权限／缺少配置提示分开处理                                           |
| 任务无重跑规则、无恢复步骤                         | `case-suite-editor.tsx:413,623`                                                                                                                                                                              | 紧凑说明或 EmptyState；保留“不配置时使用默认行为”的解释                      |
| 继承来源无阶段、无可继承用例                       | `version-case-inheritance-dialog.tsx:225,242`                                                                                                                                                                | 提示来源为空，不当成继承失败                                                 |
| 日志对比另一侧失败、当前流为空                     | `attempt-log-comparison.tsx:379,381`                                                                                                                                                                         | 失败用 Notice，空日志使用紧凑 EmptyState                                     |
| DDT 七日无执行、统计准备中                         | `ddt-execution-chart.tsx:112,131`；`ddt-management-workspace.tsx:863`                                                                                                                                        | 区分无记录、生成快照和无排行，避免静态空状态掩盖加载                         |
| 服务账号、日志、产物无权限                         | `operations-settings.tsx:424`；`attempt-log-viewer.tsx:379`；`run-batch-rounds.tsx:2157`                                                                                                                     | 使用紧凑权限提示，不能误报资源为空                                           |
| 纯文字等待                                         | `ddt-case-data-dialog.tsx:93`；`ddt-case-browser.tsx:225`；`case-suite-details.tsx:691,848`；`case-selection-table.tsx:1262`；`failure-analysis-execution-history.tsx:119`；`run-batch-rounds.tsx:2161,2222` | 可复用紧凑 LoadingState / Spin，保留无障碍播报，已有数据后台更新时不清空列表 |

### 第二轮对检查门禁的补充

后续检测除第一轮列出的盲区外，还应覆盖：无 role 的错误提示；不同图标实现的旋转加载；LinkButton 与转发 headerTitle 的提示；名字叫 Badge / Pagination 但由业务函数实现的情况；CSS 伪元素时间线；列表有数据、无数据、失败和权限分支。不能把这些名字加进一个更大的正则后就宣称没有遗漏，应保留逐类回归与真实页面检查。

本轮没有修改运行代码，继续仅更新审查报告。实际运行 `pnpm exec vitest run apps/web/src/components/ui-usage.test.ts apps/web/src/components/ui/interaction-readiness.test.tsx apps/web/src/components/ui/table.test.tsx`：3 个文件、22 项测试通过，覆盖现有边界、首屏交互就绪和共享表格渲染；报告通过 Prettier 检查和源码路径／行号校验。测试通过不代表上述待修复项已消失。浏览器所有状态的动态验收仍属于后续 UI 修复验证，不以本次静态扫描代替。

## 附录：第一轮分类的完整源码位置清单

以下以文件为单位合并相同种类的位置，路径相对 `apps/web/src/components/`。

### 原生错误、警告及放弃修改提示：44 处 / 32 个文件

| 文件                                                                                                                | 行号                      |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| [analytics-export-control.tsx](../../apps/web/src/components/analytics-export-control.tsx#L124)                     | 124, 135                  |
| [attempt-log-comparison.tsx](../../apps/web/src/components/attempt-log-comparison.tsx#L377)                         | 377                       |
| [cached-batch-comparison.tsx](../../apps/web/src/components/cached-batch-comparison.tsx#L68)                        | 68                        |
| [cached-case-directory.tsx](../../apps/web/src/components/cached-case-directory.tsx#L87)                            | 87                        |
| [cached-suite-directory.tsx](../../apps/web/src/components/cached-suite-directory.tsx#L51)                          | 51, 124                   |
| [case-definition-editor.tsx](../../apps/web/src/components/case-definition-editor.tsx#L102)                         | 102                       |
| [case-import-dialog.tsx](../../apps/web/src/components/case-import-dialog.tsx#L223)                                 | 223                       |
| [case-selection-table.tsx](../../apps/web/src/components/case-selection-table.tsx#L764)                             | 764, 900, 1264            |
| [case-suite-details.tsx](../../apps/web/src/components/case-suite-details.tsx#L268)                                 | 268, 693, 850             |
| [case-suite-editor.tsx](../../apps/web/src/components/case-suite-editor.tsx#L408)                                   | 408, 618, 994, 1080, 1099 |
| [case-suite-manager.tsx](../../apps/web/src/components/case-suite-manager.tsx#L388)                                 | 388, 402                  |
| [case-suite-recent-executions.tsx](../../apps/web/src/components/case-suite-recent-executions.tsx#L126)             | 126                       |
| [case-suite-schedule-dialog.tsx](../../apps/web/src/components/case-suite-schedule-dialog.tsx#L114)                 | 114                       |
| [case-suite-schedule-panel.tsx](../../apps/web/src/components/case-suite-schedule-panel.tsx#L147)                   | 147                       |
| [case-version-history.tsx](../../apps/web/src/components/case-version-history.tsx#L118)                             | 118                       |
| [ddt-case-inspector.tsx](../../apps/web/src/components/ddt-case-inspector.tsx#L67)                                  | 67                        |
| [ddt-management-workspace.tsx](../../apps/web/src/components/ddt-management-workspace.tsx#L2008)                    | 2008                      |
| [dialog-discard-prompt.tsx](../../apps/web/src/components/dialog-discard-prompt.tsx#L19)                            | 19                        |
| [failure-analysis-assignment-dialog.tsx](../../apps/web/src/components/failure-analysis-assignment-dialog.tsx#L144) | 144                       |
| [failure-analysis-conclusion-card.tsx](../../apps/web/src/components/failure-analysis-conclusion-card.tsx#L132)     | 132                       |
| [failure-analysis-conclusion-picker.tsx](../../apps/web/src/components/failure-analysis-conclusion-picker.tsx#L177) | 177                       |
| [failure-analysis-execution-history.tsx](../../apps/web/src/components/failure-analysis-execution-history.tsx#L122) | 122                       |
| [failure-analysis-export-button.tsx](../../apps/web/src/components/failure-analysis-export-button.tsx#L56)          | 56                        |
| [failure-analysis-workspace.tsx](../../apps/web/src/components/failure-analysis-workspace.tsx#L2831)                | 2831                      |
| [jar-importer.tsx](../../apps/web/src/components/jar-importer.tsx#L678)                                             | 678                       |
| [lazy-case-source.tsx](../../apps/web/src/components/lazy-case-source.tsx#L72)                                      | 72                        |
| [platform-initialization.tsx](../../apps/web/src/components/platform-initialization.tsx#L220)                       | 220                       |
| [run-batch-rounds.tsx](../../apps/web/src/components/run-batch-rounds.tsx#L1632)                                    | 1632                      |
| [runner-admin-actions.tsx](../../apps/web/src/components/runner-admin-actions.tsx#L145)                             | 145, 247                  |
| [shared-log-error.tsx](../../apps/web/src/components/shared-log-error.tsx#L10)                                      | 10                        |
| [start-failure-analysis-dialog.tsx](../../apps/web/src/components/start-failure-analysis-dialog.tsx#L100)           | 100                       |
| [topbar-tools.tsx](../../apps/web/src/components/topbar-tools.tsx#L398)                                             | 398                       |

### Ant Input 的 number 用法：27 处 / 9 个文件

| 文件                                                                                                 | 行号                                                                 |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [access-settings.tsx](../../apps/web/src/components/access-settings.tsx#L1128)                       | 1128                                                                 |
| [case-suite-editor.tsx](../../apps/web/src/components/case-suite-editor.tsx#L331)                    | 331, 342, 353, 475, 491, 507, 523, 539, 555, 643, 694, 772, 783, 794 |
| [global-run-dialog.tsx](../../apps/web/src/components/global-run-dialog.tsx#L870)                    | 870, 885                                                             |
| [operations-settings.tsx](../../apps/web/src/components/operations-settings.tsx#L793)                | 793                                                                  |
| [platform-settings.tsx](../../apps/web/src/components/platform-settings.tsx#L229)                    | 229, 280, 385, 543                                                   |
| [project-structure-manager.tsx](../../apps/web/src/components/project-structure-manager.tsx#L735)    | 735                                                                  |
| [rerun-final-failures-dialog.tsx](../../apps/web/src/components/rerun-final-failures-dialog.tsx#L91) | 91                                                                   |
| [runner-agent-installer.tsx](../../apps/web/src/components/runner-agent-installer.tsx#L400)          | 400, 532                                                             |
| [runner-update-dialog.tsx](../../apps/web/src/components/runner-update-dialog.tsx#L214)              | 214                                                                  |

### Button 的浏览器 title：25 处 / 16 个文件

| 文件                                                                                                                | 行号               |
| ------------------------------------------------------------------------------------------------------------------- | ------------------ |
| [analytics-export-control.tsx](../../apps/web/src/components/analytics-export-control.tsx#L101)                     | 101                |
| [batch-comparison-details.tsx](../../apps/web/src/components/batch-comparison-details.tsx#L195)                     | 195                |
| [case-selection-table.tsx](../../apps/web/src/components/case-selection-table.tsx#L1239)                            | 1239               |
| [color-mode-toggle.tsx](../../apps/web/src/components/color-mode-toggle.tsx#L12)                                    | 12                 |
| [ddt-case-browser.tsx](../../apps/web/src/components/ddt-case-browser.tsx#L116)                                     | 116, 210, 416, 426 |
| [failure-analysis-execution-history.tsx](../../apps/web/src/components/failure-analysis-execution-history.tsx#L207) | 207                |
| [failure-analysis-workspace.tsx](../../apps/web/src/components/failure-analysis-workspace.tsx#L857)                 | 857                |
| [logout-button.tsx](../../apps/web/src/components/logout-button.tsx#L23)                                            | 23                 |
| [project-structure-manager.tsx](../../apps/web/src/components/project-structure-manager.tsx#L362)                   | 362                |
| [public-control-preview.tsx](../../apps/web/src/components/public-control-preview.tsx#L56)                          | 56                 |
| [run-batch-permanent-share.tsx](../../apps/web/src/components/run-batch-permanent-share.tsx#L62)                    | 62, 81             |
| [run-batch-rounds.tsx](../../apps/web/src/components/run-batch-rounds.tsx#L1090)                                    | 1090, 1250, 1997   |
| [runner-terminal.tsx](../../apps/web/src/components/runner-terminal.tsx#L239)                                       | 239, 284           |
| [runner-update-dialog.tsx](../../apps/web/src/components/runner-update-dialog.tsx#L130)                             | 130                |
| [shared-attempt-log-content.tsx](../../apps/web/src/components/shared-attempt-log-content.tsx#L224)                 | 224, 256           |
| [topbar-tools.tsx](../../apps/web/src/components/topbar-tools.tsx#L285)                                             | 285, 374           |

### LoaderCircle JSX 调用候选：61 处 / 35 个文件

| 文件                                                                                                                | 行号                               |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| [analytics-export-control.tsx](../../apps/web/src/components/analytics-export-control.tsx#L99)                      | 99                                 |
| [case-definition-editor.tsx](../../apps/web/src/components/case-definition-editor.tsx#L112)                         | 112                                |
| [case-failure-analysis-history.tsx](../../apps/web/src/components/case-failure-analysis-history.tsx#L149)           | 149                                |
| [case-permanent-share.tsx](../../apps/web/src/components/case-permanent-share.tsx#L60)                              | 60                                 |
| [case-selection-table.tsx](../../apps/web/src/components/case-selection-table.tsx#L598)                             | 598, 669, 730, 753, 1006           |
| [case-suite-card.tsx](../../apps/web/src/components/case-suite-card.tsx#L170)                                       | 170                                |
| [case-suite-details.tsx](../../apps/web/src/components/case-suite-details.tsx#L349)                                 | 349, 365, 505                      |
| [case-suite-editor.tsx](../../apps/web/src/components/case-suite-editor.tsx#L736)                                   | 736, 1004, 1042                    |
| [case-suite-manager.tsx](../../apps/web/src/components/case-suite-manager.tsx#L224)                                 | 224                                |
| [case-suite-recent-executions.tsx](../../apps/web/src/components/case-suite-recent-executions.tsx#L122)             | 122                                |
| [case-suite-schedule-dialog.tsx](../../apps/web/src/components/case-suite-schedule-dialog.tsx#L110)                 | 110                                |
| [case-suite-schedule-panel.tsx](../../apps/web/src/components/case-suite-schedule-panel.tsx#L232)                   | 232                                |
| [case-version-history.tsx](../../apps/web/src/components/case-version-history.tsx#L295)                             | 295                                |
| [ddt-api-reference.tsx](../../apps/web/src/components/ddt-api-reference.tsx#L160)                                   | 160                                |
| [ddt-management-workspace.tsx](../../apps/web/src/components/ddt-management-workspace.tsx#L1048)                    | 1048, 1960, 2086, 2478, 2922       |
| [ddt-value-search.tsx](../../apps/web/src/components/ddt-value-search.tsx#L373)                                     | 373                                |
| [execution-records-table.tsx](../../apps/web/src/components/execution-records-table.tsx#L409)                       | 409                                |
| [failure-analysis-assignment-dialog.tsx](../../apps/web/src/components/failure-analysis-assignment-dialog.tsx#L141) | 141                                |
| [failure-analysis-conclusion-card.tsx](../../apps/web/src/components/failure-analysis-conclusion-card.tsx#L127)     | 127                                |
| [failure-analysis-conclusion-picker.tsx](../../apps/web/src/components/failure-analysis-conclusion-picker.tsx#L223) | 223                                |
| [failure-analysis-export-button.tsx](../../apps/web/src/components/failure-analysis-export-button.tsx#L49)          | 49                                 |
| [failure-analysis-statistics.tsx](../../apps/web/src/components/failure-analysis-statistics.tsx#L273)               | 273, 306                           |
| [failure-analysis-workspace.tsx](../../apps/web/src/components/failure-analysis-workspace.tsx#L1308)                | 1308, 1594, 2118, 2282, 2526, 2828 |
| [global-run-dialog.tsx](../../apps/web/src/components/global-run-dialog.tsx#L996)                                   | 996                                |
| [jar-importer.tsx](../../apps/web/src/components/jar-importer.tsx#L416)                                             | 416, 637                           |
| [run-batch-permanent-share.tsx](../../apps/web/src/components/run-batch-permanent-share.tsx#L73)                    | 73                                 |
| [runner-group-manager.tsx](../../apps/web/src/components/runner-group-manager.tsx#L193)                             | 193                                |
| [runner-terminal.tsx](../../apps/web/src/components/runner-terminal.tsx#L340)                                       | 340                                |
| [source-actions.tsx](../../apps/web/src/components/source-actions.tsx#L62)                                          | 62                                 |
| [source-lifecycle.tsx](../../apps/web/src/components/source-lifecycle.tsx#L147)                                     | 147, 166, 185, 200, 245            |
| [start-failure-analysis-button.tsx](../../apps/web/src/components/start-failure-analysis-button.tsx#L76)            | 76                                 |
| [start-failure-analysis-dialog.tsx](../../apps/web/src/components/start-failure-analysis-dialog.tsx#L97)            | 97                                 |
| [storage-inventory.tsx](../../apps/web/src/components/storage-inventory.tsx#L552)                                   | 552, 608                           |
| [version-case-inheritance-dialog.tsx](../../apps/web/src/components/version-case-inheritance-dialog.tsx#L166)       | 166                                |
| [webhook-settings.tsx](../../apps/web/src/components/webhook-settings.tsx#L319)                                     | 319, 663, 695                      |
