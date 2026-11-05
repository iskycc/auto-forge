# 失败用例日志 ZIP 导出

执行详情打开“查看用例明细 → 导出结果”，在 Excel 导出弹框中的独立“失败日志”区域点击“导出失败日志 ZIP”。上方“当前轮次／全部轮次／最终结果”决定日志范围；日志始终采用失败分析清单的失败／异常结果口径，结果类型复选框只作用于 Excel，不会把成功用例加入日志 ZIP。

这个入口仅下载日志 ZIP，不生成或附带 Excel，不改变原有 Excel 行列、样式、日志链接或数据校验。分析列表原来的“导出分析结果”继续沿用原 Excel 下载。接口为 `GET /api/v1/run-batches/{batchId}/failure-logs/export?scope=round|all|final`，`scope=round` 时须传 `round`。

每条所选执行记录生成一个 UTF-8（带 BOM）`.log` 文件。普通用例以完整类路径命名，DDT 以执行记录的 CaseID 命名；文件名附轮次和顺序号，避免同一用例多轮、同名 CaseID 或文件名清理后覆盖。路径分隔符、Windows 禁用字符与保留名称经过安全处理，长文件名按 Unicode 字符边界缩短；压缩包内文件全部平铺，不能写出任意目录。

正文包含该尝试全部已保存的 stdout、stderr、agent 日志，按日志流分段、流内按序号读取。与平台日志展示共用有状态 ANSI 解析器，去除实际颜色、光标和 OSC 控制序列，跨分页的颜色序列也能正确处理；保留中文、emoji、堆栈、换行及原始文本，CRLF／CR 统一为 LF。不会将日志解释为 HTML，也不对正文套用 Excel 长度或换行上限。不同日志流不伪造全局交错时间顺序。

下载同时要求对应项目的 `run.read` 与 `log.read`。复用现有日志读取应用服务和存储路由：Lite 读取批次日志库，Full 按已记录的日志数据库／归档位置读取，不直接遍历主库或公开任何新日志授权。已归档且平台副本仍存在的日志按现有读取规则处理；副本已确认删除、日志读取失败或游标无法前进时，返回明确错误，不以部分压缩包伪装成功。

结果每页最多 200 条，日志每页最多 32 块，逐个用例、逐段读取与压缩。压缩输出直接写入私有、创建后即取消目录链接的临时文件；每 32 KiB 压缩片段及文件之间让出事件循环，写入遵守磁盘背压，不把约 2000 条用例的完整日志一起放入内存。使用锁定的 `fflate 0.8.3` 流式 ZIP、一级压缩；它已在仓库开发依赖与许可证清单中，本次作为 Web 明确生产依赖交付，无原生程序、在线脚本或运行时下载。

全部文件写完后才发送下载头，取消或错误关闭暂存文件并停止后续日志读取。浏览器离开页面时中止请求；生成期间禁止重复提交和修改范围。ZIP32 的 4 GiB 大小／65535 文件边界明确报错并提示缩小范围，不生成损坏文件。这个功能不是月度日志归档，不删除日志、执行记录或归档副本。

## 2026-11-05 验证

生产 Lite 页面上的三个 Playwright 场景通过：

```bash
pnpm exec playwright test tests/e2e/failure-log-export.spec.ts tests/e2e/ui-layout.spec.ts \
  --grep 'independent failure log ZIP|execution exports preserve DDT|execution export dialog keeps' \
  --workers=1
```

新增场景使用 2000 条失败记录（普通用例及中文 DDT CaseID 混合），每例约 400 行正文，首例 2000 行，并分别写入 stdout、stderr 和 agent 日志。真实下载后逐个核对文件名、正文首尾、完整堆栈行数、中文及 emoji、各日志流和颜色控制字符清理；同时验证日志库暂忙提示与再次下载。第二轮加大正文后的导出及逐文件校验共 22.13 秒，压缩包 782070 字节；导出期间 66 次已登录会话请求均成功，最长 369ms。该结果来自受限为两核的本地 Lite 生产服务与合成样本，不代表不同磁盘、网络或日志体积下的固定耗时。

另外两个现有场景保留了实际 Excel 读回、普通／DDT 混合字段、时区、表头配色、链接、分析结论、不同轮次范围和失败后重试断言，均通过。新增功能没有在原表格中增加日志列。已实际查看 1024×768、1536×960 的深浅色及错误状态截图：正文按需滚动、底部按钮保持可见，新增入口没有溢出或重叠。截图保留于 `/var/tmp/autoforge-failure-log-zip-ui-20261105/`，最终浏览器记录为 `/var/tmp/autoforge-failure-log-zip-playwright-final.log`。

Web 生产构建通过，记录为 `/var/tmp/autoforge-failure-log-zip-final-build.log`。`pnpm install --offline --frozen-lockfile --ignore-scripts` 通过，lockfile 仅增加已有精确版本的 Web 依赖映射，许可证清单检查没有新增未知包。本次没有改数据库适配器语义、迁移或 Runner 协议；Full 复用原有授权和日志路由。Full 中间件矩阵、真实长时批跑及整套断网验收未重跑。

最终质量检查通过：变更文件 ESLint、`pnpm format:check`（含 Go 格式与许可证）、`pnpm --filter @autoforge/web typecheck`、`pnpm exec tsc --noEmit -p tsconfig.tests.json`、11 个相关 Vitest 文件的 134 项测试、`pnpm test:e2e:matrix` 和 `git diff --check`。记录为 `/var/tmp/autoforge-failure-log-zip-quality.log`。已有 Excel API 测试的身份夹具补齐权限数组，继续使用真实权限函数，原断言不变。

收尾检查另外增加任务名含“失败用例分析清单”字样的命名回归，ZIP 名称使用独立命名函数，避免误改业务名称；定向复验文件命名与 ZIP API 后再次构建生产包，记录为 `/var/tmp/autoforge-failure-log-zip-release-build.log`。该调整不改变已验证的 UI、日志范围或 ZIP 内容。
