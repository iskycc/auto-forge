# 执行详情布局

后台 `/run-batches/:batchId`、公开 `/Execution?BatchId=…` 及旧兼容链接共用概览与轮次组件，Lite／Full 使用相同布局。匿名页继续只读，不展示调度日志、内部事件、产物、AI 分析及执行控制入口。

## 信息层级

- 页头集中显示任务名称、批次、任务版本和项目版本；后台保留拉起人，公开页把登录与主题切换放在只读说明同一行。
- 概览四列突出执行状态、总数、通过率和耗时／倒计时，下面集中展示起止时间、当前轮次、实际环境 IP 和适用的操作人。批次操作放在同一卡片底部，按钮有序换行。
- 轮次表保留总结、全部轮次、每轮及环境恢复的选择、高亮和 URL 记忆。未指定轮次及失效的轮次参数默认选择“总结”，不再选择最后执行轮次；明确指定且仍存在的轮次链接继续定位原范围。后台与匿名页共用规则。
- 两张圆环位于轮次表之前，直径 192px；左侧结果分布按所选具体轮次、总结或全部轮次显示，环境恢复选择展示其之前一轮。具体轮次直接使用该轮 `totalRuns`／`notExecuted`，不把其他轮通过的用例当作未执行；总结按批次用例去重，全部轮次按轮次累计。中心及页脚明确显示范围和总数。
- 右侧“总体通过进度”明确标记“批次范围”，展示截至所选轮次的累计通过数及批次总数；与左侧本轮口径分开说明。两张图使用 Ant Design Card、Statistic、Badge、Tooltip 和 Progress 统一层级、图例与进度环，复用主题 token 和本地资源，不新增图表依赖。
- 圆环与右侧图例作为一组在卡片中居中；图例采用柔和底色、圆角与细边框的小面板，宽度最多 176px，窄桌面按剩余空间收缩。状态使用 Ant Design 色标、名称与右对齐数量，面板内保留短分隔线与两侧内边距；短线最多 150px，最后一项不画底线，避免宽屏把图例和数字拉得过远。圆环维持 192px，范围统计、悬停详情和页脚分隔保持原行为。
- 轮次表之后只保留“查看用例明细”入口，默认没有用例 DOM，也不请求明细分页。

## 独立全屏明细

“查看用例明细”打开占满当前视口的 Ant Design Modal。此窗口单独禁用原生缩放与遮罩渐变，第一帧就保持最终屏幕尺寸和不透明表面；不修改全局主题或其他弹窗的动效。顶部标题和唯一“关闭明细”按钮固定，正文独立滚动；没有右上角关闭图标、底部取消按钮，Esc 与遮罩点击均不退出。子层日志、完整内容、导出及确认弹窗仍按原有方式关闭自身，不连带退出明细窗口。

窗口打开时取主页面当前轮次；窗口内可独立选择总结、全部轮次、具体轮次及已激活的环境恢复，并使用原有搜索、状态筛选、排序、分页和执行机视图。窗口内范围切换不改主页面的轮次、URL 或图表；关闭后恢复入口焦点和原页面滚动位置。主页面仍按原逻辑更新执行概览，明细关闭不停止后台任务。

明细组件仅打开后挂载，关闭时卸载，AbortController 取消在途分页读取，并停止随概要更新触发明细读取；已读取分页及 attempt 详情继续复用原有缓存。再次打开从主页面选定轮次进入。

## 整齐的用例列表

默认结果行高统一为 72px，筛选与翻页不再依据行内文本长度重算列宽，普通与 DDT、通过与失败使用相同列布局。名称、类路径、执行机和摘要截断预览，不因长堆栈增加行高。点击名称或结果可打开“用例执行信息”，完整保留当前页返回的名称、类路径、结果摘要及执行机；正文按需滚动并可选中复制。原“详情”按钮在独立弹窗读取结构化结果、产物与事件，不再向列表插入展开行。

失败用例的 AI 入口保留在名称旁，以有可访问名称的图标按钮展示；权限和提交流程不变。用例过滤、类路径排序、分页、取消、公开日志新标签页与导出沿用原有实现。超出最小桌面空间的表格保留局部横向滚动。

## 性能边界

没有新增数据接口、轮询、数据库聚合或完整日志读取；原有明细请求延迟至窗口打开后。预览弹窗复用有界用例分页的现有字段；结构化详情仅点击后读取，继续复用原有缓存和授权。时钟在独立组件内更新，不使圆环及结果表每秒重渲染。不改数据库统计或调度规则，图表直接展示已有范围概要；Runner 协议和离线资源依赖保持一致。

## 验证范围

`tests/e2e/execution-detail-layout.spec.ts` 使用真实 Lite 数据库和生产页面，覆盖后台／匿名、深浅色、1024×768、1536×960 和 1920×960。样本含通过与失败、长类路径／名称、多行堆栈及 12 个环境 IP；检查图表位于轮次表前、默认不读用例、窗口全屏边界、唯一关闭按钮、Esc／遮罩不关闭、完整内容子弹窗、筛选搜索、轮次范围独立、关闭后的焦点与滚动恢复及在途请求取消。截图保留在本地测试输出，不纳入源码。

本轮没有修改 Lite／Full 数据持久化、Runner 协议及调度规则；Full 共用相同组件。真实 JVM／容器执行及 Full 中间件矩阵未在本次 UI 变更中重跑，相应 E2E 使用显式明细入口，保留产物、执行结果和日志断言。

2026-11-05 的生产包验证中，全屏明细专项场景通过；另外八个相关浏览器场景最终均通过，覆盖终止收尾、类路径排序、执行机资源与超时记录、匿名详情及旧链接、长短失败摘要、混合普通／DDT 导出、结果／分析清单实际下载、操作按钮及结构化结果。首轮两处旧测试仍直接操作背景轮次或在刷新后查找明细，改为通过显式入口后定向复验通过，原有数据与下载断言保留。

实际查看了 1024×768、1536×960、1920×960 的概览及全屏窗口截图，包括后台／匿名、深浅色；检查了图表位置、全屏边界、固定关闭栏、等高结果行、长文本、子弹窗和滚动区域，没有页面级溢出或控件重叠。核心截图目录为 `/var/tmp/autoforge-fullscreen-details-ui-20261105`。专项、回归和复验记录分别为 `/var/tmp/autoforge-fullscreen-details-playwright.log`、`/var/tmp/autoforge-fullscreen-details-regression.log`、`/var/tmp/autoforge-fullscreen-details-retest.log`。

最终检查已通过：变更文件 ESLint、`pnpm format:check`（含 Go 格式和许可证清单）、`pnpm --filter @autoforge/web typecheck`、`pnpm exec tsc --noEmit -p tsconfig.tests.json`、四个相关 Vitest 文件共 47 项测试、`pnpm test:e2e:matrix` 和 `git diff --check`。四个 Vitest 文件为 `ui-usage.test.ts`、`run-batch-presentation.test.ts`、`round-case-rows.test.ts` 和 `execution-case-page-client.test.ts`。Web 生产构建通过；最终检查记录为 `/var/tmp/autoforge-fullscreen-details-quality.log`，生产构建记录为 `/var/tmp/autoforge-fullscreen-details-final-build.log`。

### 默认总结与打开稳定性修复

2026-11-05 在正常动效设置下复现全屏窗口入场缩放：1536px 视口的首帧宽度约为 307px，变换矩阵从 0.2 倍放大至原尺寸，同时透明度由 0 变为 1。这使整个屏幕经历缩放和透出背景；只检查最终截图或开启减少动态效果无法发现该问题。另一个缺陷是普通入口会自动选择最后执行轮次，已通过多轮批次夹具复现。

修复后的 `tests/e2e/execution-entry-stability.spec.ts` 在正常动效下，覆盖后台／匿名、深浅色、1024×768 和 1536×960 的八种组合；每种组合均拦截首次分页读取，检查加载状态，再释放真实响应并检查五条通过／失败数据。首次打开及缓存重开从窗口首次绘制起采样 700ms，逐帧验证全屏尺寸、无缩放且完全不透明；关闭后仍保留总结。另一个场景验证普通入口默认总结，明确指定的初始轮次链接仍然生效。

以上两个场景及原有全屏明细闭环共三项 Playwright 测试通过；原闭环继续验证唯一关闭入口、搜索筛选、子弹窗、焦点／滚动恢复及在途请求取消。实际审查了上述两种视口的后台／匿名、深浅色加载与结果截图，未发现新增重叠、溢出或结果行变形。截图目录为 `/var/tmp/autoforge-execution-entry-ui-20261105`，最终浏览器记录为 `/var/tmp/autoforge-execution-entry-playwright-retest.log`。生产构建记录为 `/var/tmp/autoforge-execution-entry-build.log`。

本次修复另通过变更文件 ESLint、Web 与测试类型检查、`pnpm format:check`（含许可证和 Go 格式）、`pnpm test:e2e:matrix`、`git diff --check`，以及后端打包、前端离线资源、部署包、发布工作流、清单和签名的 39 项检查。相关 Vitest 共五个文件 60 项，在上述四个回归文件之外新增 `execution-round-selection.test.ts`，覆盖缺失／失效参数、空统计和明确指定范围。最终检查记录为 `/var/tmp/autoforge-execution-entry-quality.log`；未重跑 Full 中间件、真实 JVM 长时执行与整套断网验收。

### 2026-11-12 轮次分布与 Ant Design 图表

旧页面在结果分布中使用 `batch.totalRuns - summary.executed` 作为未执行数，导致初始 100 个用例通过 90 个后，仅重跑 10 个时，多出 90 个“未执行”。新增组件回归在旧实现中复现该错误。现在直接使用 `summary.totalRuns` 与 `summary.notExecuted`，中心显示本轮用例总数，页脚区分已开始和未执行；等待中的空轮次保持零，不拿全局数补足。选中轮次暂无统计时显示明确空状态，不回退为最终结果。

结果分布的 SVG 保留精确分段，配合真实 Ant Design Card、Statistic、Badge 和 Tooltip；累计通过使用 Progress 圆环。两图保持 192px 大圆环、对齐的主体和页脚，并分别标注“本轮范围／去重总结／全部轮次”和“批次范围”。不新增生产依赖，不增加查询、轮询或大集合遍历，Lite／Full 与匿名页共用实现。

v1.22.12 的任务卡片操作栏采用左对齐与固定间距；后续按用户反馈改为均匀分布与居中对齐，当前规则见下节。维护图标组继续保留内部统一间距，不单独推到卡片右侧。

验证：七个文件共 66 项 Vitest 通过，包括图表渲染、空轮次、排队／进行中／取消、缺失统计、总体视图、用例分页及原领域轮次语义：

```sh
pnpm exec vitest run \
  apps/web/src/components/execution-round-charts.test.tsx \
  apps/web/src/components/ui-usage.test.ts \
  apps/web/src/lib/execution-batch-view.test.ts \
  apps/web/src/lib/run-batch-presentation.test.ts \
  apps/web/src/lib/round-case-rows.test.ts \
  apps/web/src/lib/execution-case-page-client.test.ts \
  packages/domain/test/run-batch-rounds.test.ts \
  --maxWorkers=1 --no-file-parallelism
```

生产 Lite 的原有全屏明细场景和新增范围／按钮场景分别通过；图表视觉对齐收尾后，范围／按钮场景在最终 Lite／Full 生产构建再次通过。Full 使用双 Web、Worker 和真实 PostgreSQL／NATS／Redis／MinIO。新增共享数据库夹具建立初始 100 例、90 例首次通过、10 例进入重跑的执行历史；后台和匿名页均确认重跑为 4 通过／6 失败／0 未执行，总结仍为 100 例、全部轮次累计 110 例。两种权限导致的多／少按钮卡片同时验证固定间距。

```sh
pnpm exec playwright test tests/e2e/execution-detail-layout.spec.ts --workers=1
pnpm exec playwright test --config playwright.full.config.ts \
  tests/e2e/execution-detail-layout.spec.ts \
  --grep 'retry charts use only eligible round members' --workers=1
```

实际查看 1024×768、1536×960 的后台／匿名、深浅色图表和任务按钮截图；原全屏场景还覆盖 1920×960。图例、长标题、按钮换行、数字和页脚对齐正常，没有新增横向溢出或布局变形。截图位于 `/var/tmp/autoforge-round-charts-ui` 和 `/var/tmp/autoforge-round-charts-full-ui`。范围内格式、ESLint、Web／测试类型及 Web／Worker 生产构建通过；不修改数据库统计、调度、权限、Runner 协议或既有历史数据。本次 UI 修复未新增迁移，也未重跑十万级压力、真实业务 JVM 或完整离线发布包验收。

### 任务卡片按钮居中均分

任务卡片操作栏统一采用 `space-evenly` 均分每行剩余空间，控件垂直居中，按钮之间保留最小间距。正常任务、锁定任务、权限不同或 Adapter 导致按钮数量变化时均使用同一规则，换行后每行的左右余量仍然对称；维护图标作为一组保持内部间距，不使用自动外边距改变整行分布。普通用例管理的选择工具栏保留原有排布。

仅调整共享任务卡片布局，不改变执行、锁定、置顶、导出、公开接入、归档或删除行为，Lite／Full 使用相同组件，不新增配置、依赖、迁移或协议。

2026-11-12 验证：更新现有 Playwright 场景，先在旧构建复现左对齐不满足新要求，再于生产 Lite／Full 构建各通过一次。正常和他人锁定的任务卡片同时展示，覆盖多／少按钮、单行及换行；逐行实测左右留白对称、间距均分与垂直居中。深浅色截图覆盖 1024×768、1536×960、1920×960，并已实际查看，无新增重叠、溢出或变形。截图分别位于 `/var/tmp/autoforge-centered-task-actions-ui/` 与 `/var/tmp/autoforge-centered-task-actions-full-ui/`。

```sh
pnpm exec playwright test tests/e2e/execution-detail-layout.spec.ts \
  --grep 'retry charts use only eligible round members' --workers=1
pnpm exec playwright test --config playwright.full.config.ts \
  tests/e2e/execution-detail-layout.spec.ts \
  --grep 'retry charts use only eligible round members' --workers=1
```

相关 Prettier、ESLint、`pnpm exec tsc --noEmit -p tsconfig.tests.json`、17 项 `ui-usage.test.ts` 约束及 `pnpm --filter @autoforge/web build` 均通过。测试服务和容器已关闭；本轮是展示样式调整，未重跑数据库、调度、真实 Runner 或完整离线发布验收。

### 2026-11-13 紧凑图例

右侧图例采用柔和底色、圆角与细边框的紧凑面板，每行用短分隔线区分状态，数量右对齐，最后一行不附加底线。面板最多 176px，横向留白将内部短线限制在 150px 以内，按窄桌面实际剩余空间收缩；圆环与图例一起居中，两张卡片继续保持相同主体高度、圆环尺寸与页脚对齐。状态名保留 Ant Design 色标与数量，悬停详情、轮次统计和全屏明细交互不变。颜色、边框和背景使用共享语义 token，浅色与深色一致。

Playwright 布局断言验证图例限宽、内部短线保留、最后一项无底线与数字无溢出；旧构建已复现缺少分隔的情况，最终 Lite 两项、Full 一项全部通过，均无跳过或重跑。Lite 完整场景覆盖全屏窗口的唯一关闭入口、搜索、筛选、详情和导出；Full 使用真实 PostgreSQL／NATS／Redis／MinIO、双 Web 和 Worker 验证后台／匿名详情及总结／具体轮次／全部轮次。实际查看 1024×768、1536×960、2560×960 深浅色截图，面板、短线及数量对齐正常，未发现新增重叠或溢出；截图分别在 `/var/tmp/autoforge-chart-legend-panels-lite-ui/` 与 `/var/tmp/autoforge-chart-legend-panels-full-ui/`。

上述七个文件的 66 项 Vitest、变更范围 Prettier／ESLint、`pnpm --filter @autoforge/web typecheck`、`pnpm exec tsc --noEmit -p tsconfig.tests.json` 和 `pnpm --filter @autoforge/web build` 均通过，记录在 `/var/tmp/autoforge-chart-legend-panels-quality.log`。本次仅修改共享图表样式，不新增迁移、接口、依赖或轮询；未重跑调度、真实业务 JVM、压力或完整离线发布验收。测试服务和容器已关闭。
