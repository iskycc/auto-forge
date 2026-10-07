# Excel 导出排版

## 问题与范围

旧共用正文格式设置了 `indent: 1`，因此执行结果、失败分析、任务成员和 DDT 导出的文字或数值与单元格边缘之间都有额外空白。各类工作簿并非所有列都被设成相同宽度，但执行结果的状态、时间、耗时使用同一个兜底宽度，DDT 的短字段统一至少 14 字符，常见数据看起来接近等宽。

本次取消共用缩进，并针对执行结果和 DDT 的不同内容计算列宽。分析清单已有紧凑列宽比例，任务成员已有路径/名称的独立宽度，继续沿用这些比例。Lite/Full 使用同一套工作簿生成代码；没有迁移、运行配置、生产依赖或网页表格布局变更。

## 列宽规则

执行结果列宽使用 Excel 字符宽度单位：

| 字段                 | 最小宽度 | 最大宽度 |
| -------------------- | -------- | -------- |
| 轮次（全部轮次导出） | 6        | 8        |
| 用例路径             | 28       | 52       |
| 名称                 | 18       | 36       |
| 执行结果             | 10       | 18       |
| 错误描述             | 24       | 52       |
| 开始/结束时间        | 26       | 26       |
| 执行耗时(s)          | 14       | 16       |
| 日志链接             | 64       | 120      |

宽度同时考虑表头和前 100 行值的 90 分位长度，中文等宽字符按两个西文字符估算，再留两个字符的容量。宽度计算只查看有界文本前缀的首行，不改变实际单元格内容。极端长堆栈和链接不会无限拉宽整张表；导出后的完整文本仍可在表格编辑器查看、复制或手动调整列宽。

DDT 的 CaseID、srNum、CaseName 最小宽度分别为 12、10、16，其余动态字段最小宽度为 8；所有列最大宽度为 42，并采用相同的表头/样本计算。别名合并、原有值类型、前导零、公式字符串、用户旅程工作表和隐藏的往返标识保持原契约。

任务成员继续逐行提交流式工作簿，路径/名称宽度保持 52/36；不为计算列宽缓存全部成员。分析清单继续使用单行紧凑行高，日志列与执行结果共用 64–120 的样本宽度规则，其他列保留原比例。字体、浅色表头、隔行底色、状态色、筛选、冻结窗格与超链接继续使用共享导出样式。

超链接正文统一关闭自动换行，显示完整 URL 文本并保留原超链接目标；不替换成短标签，也不改变行高。超过列宽上限的极长 URL 在单行内显示，完整值仍可查看、复制和打开。没有链接的单元格保持空白，普通末列正文沿用原来的换行规则。

## 时间展示

执行结果的开始/结束时间在工作簿展示层按平台配置的时区转换，默认北京时间（`Asia/Shanghai`）。当前轮次、最终结果和全部轮次共用 `YYYY-MM-DD HH:mm:ss.SSS` 格式；跨日、跨年按目标时区计算，保留毫秒精度，缺失时间仍为空白。展示转换不修改原始 UTC 时间，也不改变执行耗时；分析清单没有开始/结束时间列，字段和布局保持原样。

时区由 HTTP 入口从持久平台配置读取后显式传入工作簿生成器，不依赖容器、宿主机或浏览器的系统时区。每份执行结果工作簿只创建一个时间格式器，有界列宽样本和正文共用它；没有新增数据库迁移、运行配置或依赖。

## 验证记录

2026-10-06，修改实现前，实际 XLSX 读回测试复现了一级缩进、DDT 短列统一 14 字符及执行结果固定列宽的问题。修改后运行：

- `pnpm exec vitest run apps/web/src/lib/run-batch-export-xlsx.test.ts apps/web/src/lib/case-suite-export-xlsx.test.ts apps/web/src/lib/ddt-export-xlsx.test.ts apps/web/src/lib/run-batch-export.test.ts packages/application/test/export-run-batch-results.test.ts apps/web/src/lib/table-column-width.test.ts`：六个文件、36 项通过。覆盖实际文件读回、前导零和类型、超链接、完整长文本、单行紧凑分析、列宽上限及样本之后的行仍完整导出。
- `pnpm exec playwright test tests/e2e/ui-layout.spec.ts --grep 'execution export dialog'`：本地 Lite 生产构建下通过。真实下载执行结果和分析清单，并检查 OOXML 不含正文缩进、列宽有明确区分，以及筛选范围和错误后重试。
- `pnpm format:check`、`pnpm lint`、`pnpm typecheck`：通过。上述 Playwright 服务启动时实际执行了 `pnpm --filter @autoforge/web build`。

已查看 1024×768、1536×960 的执行结果/分析导出弹窗截图及 1536×960 深色截图，选择卡片、说明和操作区域没有溢出或变形。将两份真实下载的工作簿通过本地 LibreOffice 渲染并查看，额外缩进已消失，各列比例有区分，统一配色和行密度正常。该视觉检查使用 LibreOffice，未在 Microsoft Excel 桌面客户端验收。

本次无需修改数据库或 Runner；没有运行 Full 整体部署验收，导出规则由两种部署共享的工作簿实现与实际文件测试覆盖。

### 2026-10-07：日志列宽与链接换行

修改前新增的六个实际 XLSX 读回场景均复现日志列过窄或末列超链接自动换行。修复后运行：

- `pnpm exec vitest run apps/web/src/lib/run-batch-export-xlsx.test.ts apps/web/src/lib/ddt-export-xlsx.test.ts apps/web/src/lib/case-suite-export-xlsx.test.ts apps/web/src/lib/execution-exceptions-export-xlsx.test.ts apps/web/src/lib/table-column-width.test.ts apps/web/src/lib/run-batch-export.test.ts packages/application/test/export-run-batch-results.test.ts --maxWorkers=2`：七个文件、46 项通过。覆盖当前轮次、最终结果、全部轮次和分析清单的完整 URL、点击目标、单行格式、列宽上限、空链接与原行高；DDT 普通末列长文本仍允许换行。
- `pnpm exec playwright test tests/e2e/ui-layout.spec.ts --grep 'execution export dialog'`：本地 Lite 生产服务下通过，真实下载两种工作簿并核对日志列宽、筛选范围和错误后重试。
- `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm --filter @autoforge/web build`、`git diff --check`：通过。

实际查看执行结果与分析导出弹窗的 1024×768、1536×960 截图，以及 1536×960 深色截图；对齐、说明换行、按钮和滚动边界正常。两份真实下载的 XLSX 经本地 LibreOffice 渲染后，日志列明显加宽，示例完整 URL 单行显示，其他列比例、隔行底色与行密度保持原样。没有运行 Microsoft Excel 桌面客户端验收。

修改只涉及共享工作簿格式，无数据库、Runner 协议、迁移或依赖变更；本次未运行 Full 整体部署、Runner 或离线验收。

### 2026-10-07：执行时间时区

修复前新增的八个时间转换场景均因直接输出 UTC 字符串而失败，空时间保留场景通过。修复后运行：

- `TZ=UTC pnpm exec vitest run apps/web/src/lib/run-batch-export-xlsx.test.ts apps/web/src/lib/run-batch-export-api.test.ts apps/web/src/lib/platform-date-time.test.ts apps/web/src/lib/run-batch-export.test.ts apps/web/src/lib/ddt-export-xlsx.test.ts apps/web/src/lib/execution-exceptions-export-xlsx.test.ts apps/web/src/lib/table-column-width.test.ts packages/application/test/export-run-batch-results.test.ts --maxWorkers=2`：八个文件、58 项通过。包含三种导出范围、北京时间跨日/跨年、带显式偏移的输入、毫秒精度、缺失时间、配置时区的夏令时，以及 HTTP 下载实际 XLSX 读回；原执行耗时和 UTC 输入保持不变。
- `TZ=America/Los_Angeles pnpm exec vitest run apps/web/src/lib/run-batch-export-xlsx.test.ts apps/web/src/lib/run-batch-export-api.test.ts --maxWorkers=2`：21 项复验通过，排除宿主机时区对导出值的影响。
- `pnpm exec playwright test tests/e2e/ui-layout.spec.ts --grep 'execution export dialog'`：本地 Lite 生产服务以 `TZ=UTC` 运行，真实下载场景通过。原始 `2026-10-06T16:00:00.123Z` 导出为 `2026-10-07 00:00:00.123`，开始/结束时间、筛选、日志列宽及导出失败后重试均符合预期。
- `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm --filter @autoforge/web build`、`git diff --check`：通过。

已实际查看 1024×768、1536×960 的执行结果导出截图，并用 LibreOffice 渲染真实下载的工作簿；时间单行完整显示，毫秒未丢失，按钮、列宽、行高和整体排版正常。没有运行 Microsoft Excel 桌面客户端验收。改动位于两种部署共用的展示格式及 HTTP 配置传入路径，未运行 Full 整体部署、Runner 或离线验收。
