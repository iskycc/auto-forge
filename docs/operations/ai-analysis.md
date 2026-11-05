# AI 初步分析：使用、部署与验证

状态：v1.21.19 首版实现与定向验证完成；发布状态以 GitHub Release 为准。更新时间：2026-11-05。

完整需求见[实现指导](../architecture/ai-failure-analysis.md)，提示词目标规范见[提示词附录](../architecture/ai-failure-analysis-prompts.md)。本页说明当前代码接入方式，不把后续规划能力描述为已经完成。

## 配置和入口

“平台设置 → 模型配置”配置 OpenAI 兼容 Chat Completions API 根地址、API Key、模型 ID、上下文和输出 token 预算、全端点共享并发／RPM／TPM、响应期限、最大重试及每例证据空间预算。例：`http://model.internal:8000/v1`，不要再附加 `/chat/completions`。API Key 加密保存，留空保留原值；无鉴权内网端点可以不设置。

“检查连接”只发送合成指令，核对接口和工具调用，不发送真实执行日志。配置保存后对新请求生效，无需重启。已有在途请求可能仍用其已取得的配置；关闭功能后不领取新工作，已有请求有限排空。平台不下载模型、不默认访问公网。

模型启用开关使用统一 Ant Design 尺寸，标签与开关同行。通过普通 HTTP／局域网 IP 访问时，分析入口使用浏览器 `getRandomValues` 生成幂等键，不依赖仅安全上下文提供的 `randomUUID`；提交响应丢失后，重试继续使用原键，避免重复创建分析作业。后台权限和模型连接方式保持不变。

管理员需为项目使用者授予 `analysis.ai.read` 和 `analysis.ai.create`，同时具有 `run.read、case.read、log.read`。原人工分析权限不会自动变成模型数据披露权限。系统管理员可管理配置；普通项目成员不能读取密钥。报告和证据按当前权限重新校验。

- 执行详情的“AI 初步分析”读取本批次最终失败／超时范围；整个批次需已结束。同批次曾通过的用例不属于最终失败范围。
- 失败／超时行的“AI 初步分析”绑定该行 attempt，可在批次仍执行时分析已结束尝试。它不会改写其他轮次或其他执行批次的结论。
- 弹窗展示枚举、采集、分析、组内汇总、限流与资源退避、部分完成、失败和取消。关闭弹窗后后台继续，重新打开可以查看结论和进度；取消仅终止初析。
- 任务详情可勾选“任务结束后自动进行 AI 初步分析”，缺省关闭。选择写入任务策略并复制到批次快照；终态后的补偿扫描幂等创建初析，不延迟完成上报。发起人的权限已撤销或账号无效时不能借用其他人的权限。

公开执行／日志访问能力不等于 AI 分析授权；首版不会把模型建议自动公开。

## Worker 与中间件

Lite 的 Web 生命周期管理独立 AI 线程，SQLite 短事务保存状态和租约，持久队列用于唤醒，本地 ObjectStore 保存证据块。不要求 PostgreSQL、NATS、Redis 或 MinIO。

Full 每个 Worker 启动一条独立 AI 线程；Web 只提交作业和读取有界进度。所有 Worker 按主库条件租约领取不同工作，整个模型端点共用额度。Worker 数量增加不会自动放大模型并发。现有 Full Worker 启动方式不变，无需增加另一套执行机 Agent。

| 组件            | AI 链路职责                                                | 故障行为                                                         |
| --------------- | ---------------------------------------------------------- | ---------------------------------------------------------------- |
| 主库 PostgreSQL | 作业、成员、分组、已发布结论、预算、租约和重试时刻         | 连接预算 1／AI 线程；短锁等待，繁忙时退避，不放宽执行查询期限    |
| NATS JetStream  | 主库 outbox 提交唤醒消息，普通消费车道唤醒 AI 线程         | 消息可重复；作业本身持久，扫描恢复丢失唤醒，不让调度车道执行推理 |
| Redis           | 多 Web 节点共享短时进度／报告页缓存，Worker 写入可重建进度 | 缓存失败回源主库；权威限流与租约始终在主库，不因缓存丢失而超发   |
| MinIO           | 脱敏输入、日志分块和证据清单                               | 对象写入失败只影响本次初析，有限重试；不会删除原日志或执行记录   |

AI 线程受父进程共享的资源压力信号约束；证据处理与模型调用之间再次检查，繁忙则持久保存等待时刻。解析、SQLite 查询与日志解压不在 Web 请求主线程运行。模型请求在数据库事务之外进行，单次有期限；模型断线不阻止原有执行、日志上传、人工分析和已有报告读取。

## 工具、数据与输出边界

采用标准 function calling 的 JSON Schema 工具和平台端执行循环，不向模型授权通用 HTTP、Shell、SQL、浏览器或平台 API Key。平台把当前工作项证据绑定到 `read_evidence`；模型仅能调用 `submit_ai_conclusion` 写入该工作项的 AI 草稿。工具不接受任意成员 ID、URL、数据库字段名或写入目标。

提交后再次核对账号、权限、成员、证据引用、租约、取消和状态。模型不能修改任务配置、用例、执行状态、人工认领／分类或其他用户信息。相同堆栈只说明表现相同，初析始终需要人工确认。

当前证据包括所选尝试的执行输入快照、结果／时间／节点信息，以及可读取的 stdout、stderr 和 Agent 日志。动态 JSON 中的敏感字段和文本凭据再次脱敏。每例证据空间预算默认 16 MiB，可配置为 1～64 MiB；执行输入正文读取保护为 8 MiB。超过预算、读取失败、缺失或离线归档均标为部分分析，不能声称完整读取。模型输出的自评置信度不是正确率。

证据清单还限制为每例最多 4,096 块，避免低上下文配置生成巨型清单；达到限制时保留已处理范围并提示增大上下文后重新分析。上下文至少 8,192 tokens，并须为输出、工具和提示词留出预算。Lite 的初析查询直接读取有索引的持久记录，不把每个报告分页无限加入进程缓存；Full 使用 Redis 原生 TTL 缓存。

日志按适配器水位分页，证据按上下文保守分片；每片发布有效初析后续处理下一片，已有结论可先查看。完整异常块从详细日志提取，统一换行／ANSI 展示字符后，以平台密钥 HMAC 签名；数字、断言值、类路径和行号保持区别。不使用只有 4,096 字符的结果摘要判断相同堆栈。

当前按一个用例中取得的完整堆栈集合分组，组内逐成员合并初析并保留成员明细；没有完整块的用例独立保留。逐个 occurrence 的多组成员映射、TestNG XML 产物解析、截图理解、历史检索、结构化事实／反证的完整目标 schema、自动格式修复以及证据自动到期清理仍需后续落实；本版不声称已经提供。

站内版本复制仍复制原有执行与业务数据范围，AI 衍生作业／证据暂不进入复制清单，目标可重新初析。自动触发另绑定实际创建的批次标识；复制历史执行不会隐式拉起模型工作，复制后的任务以后真正创建新执行时仍可按开关自动初析。

## 重试、导出与升级

临时网络错误、429 和 5xx 有限重试；平台统一控制，不叠加 SDK 自动重试。遵循合法 Retry-After，将等待时刻持久化并释放工作租约；没有提示时指数退避加抖动。模型端点共享冷却和额度，资源退让与等待额度不消耗用例分析失败次数。认证、计费、格式和权限错误直接说明原因，不无限重试。

正常执行结果与失败分析清单均支持“AI 初步分析”列。导出开始时冻结读取时刻，逐页批量匹配 attempt；截止时已有的有效部分结论也导出，尚未生成的行置空。没有结论时不增加列，不等待模型、不改变普通列、日志链接和 DDT 字段。导出所选尝试未分析时，不串用其他轮次结论。

新增 SQLite 迁移 `0094_ai_analysis.sql` 和 PostgreSQL 迁移 `0093_ai_analysis.sql`，仅增加 AI 表、索引及默认限流行；任务开关存储在既有版本化策略 JSON。升级前按现有流程备份主库与对象存储。回退时先关闭 AI、停止 AI Worker 并保留新表／对象，再部署旧版本；旧代码忽略新增表和缺省关闭的字段。不要直接删除尚有分析引用的证据对象，原始日志清理仍走原有流程。

## 验证记录

2026-11-04 使用 Node 24、串行单核构建与测试，避免多个编译进程争抢宿主机资源。

定向 Vitest **10 个文件、155 项通过**：

```bash
pnpm exec vitest run \
  packages/contracts/test/ai-analysis.test.ts \
  packages/application/test/ai-analysis.test.ts \
  packages/db/test/ai-analysis.integration.test.ts \
  apps/web/server/ai-model-gateway.test.ts \
  apps/web/src/lib/run-batch-export-xlsx.test.ts \
  packages/application/test/manage-case-suites.test.ts \
  packages/application/test/schedule-run-batches.test.ts \
  packages/domain/test/identity.test.ts \
  packages/domain/test/case-suite.test.ts \
  packages/application/src/project-version-copy-records.test.ts \
  --maxWorkers=1 --no-file-parallelism
```

数据库测试实际提供 `AUTOFORGE_TEST_POSTGRES_URL`；每个 PostgreSQL 用例独立建库，SQLite 使用临时库。先按旧迁移建库并写入执行记录，再应用 AI 迁移，验证新库／存量升级、最终失败口径、幂等、双领取、部分结论导出、过期租约、取消后禁止发布、配置版本与额度冷却。应用测试还验证权限隔离、数据库繁忙退让、资源压力变化和不可能满足的 TPM 预算。证据测试验证空间预算不足时停止所有后续日志分页，以及日志库繁忙时释放工作、退避重试，不发布缺失数据的初析。

真实 Full 中间件测试 **1 项通过**：

```bash
pnpm exec vitest run apps/web/server/ai-full-runtime.integration.test.ts \
  --maxWorkers=1 --no-file-parallelism
```

提供现有 Full 测试环境变量 `AUTOFORGE_TEST_POSTGRES_URL`、`AUTOFORGE_TEST_MINIO_ENDPOINT`、`AUTOFORGE_TEST_MINIO_ACCESS_KEY`、`AUTOFORGE_TEST_MINIO_SECRET_KEY`、`AUTOFORGE_TEST_REDIS_URL`、`AUTOFORGE_TEST_NATS_URL` 后启用。测试使用真实 PostgreSQL outbox／JetStream、Redis 和 MinIO，两个独立 AI Worker 处理四个同栈成员并逐一汇总，8 次模型调用的实测并发峰值为 2，原批次状态没有改变。该测试及双数据库契约已加入 `test-full.sh` 的适配器集合。

生产 Web 与 Full Worker 构建通过：`pnpm --filter @autoforge/web build`、`pnpm --filter @autoforge/worker build`。

质量检查通过：`pnpm format:check`（含 Go 格式与许可证）、变更 TypeScript／MJS 文件的 `pnpm exec eslint ... --max-warnings=0`、`pnpm --filter @autoforge/web typecheck`、`pnpm --filter @autoforge/worker typecheck`、`pnpm --filter @autoforge/application typecheck`、`pnpm exec tsc --noEmit -p tsconfig.tests.json`、`pnpm test:e2e:matrix` 和 `git diff --check`。最后的证据处理加固另重建了 Web 后台线程与 Full Worker，并重跑对应测试。

Lite 生产包上的 Playwright **1 个闭环场景通过**：

```bash
pnpm exec playwright test tests/e2e/ai-analysis.spec.ts --workers=1
```

覆盖模型检查、密钥不回显、429 重试、POST 已接受但浏览器断开后的幂等重试、批次／单次尝试初析、展开结论、导出及自动触发。XLSX 同时经过 ExcelJS 读取与现有 OpenXML 校验。测试已加入 `pnpm test:e2e`。

已实际查看 10 张截图：1024×768 和 1536×960 下的模型配置、用例行按钮、任务自动初析开关，以及深／浅色初析弹窗。表格操作列保持原宽度，1024px 继续使用原有表内横向滚动；1536px 下原日志、公开日志和详情按钮完整显示。弹窗分页固定在页脚，正文单独滚动，未发现新增溢出、重叠或开关换行。截图位于本机 `/var/tmp/autoforge-ai-ui-20261104/`，不作为构建产物提交。

本轮没有重跑整个仓库的全部 E2E、真实 Runner 执行与整套断网验收；未修改 Runner 协议或引入运行时下载依赖。**真实内网模型尚未接入验证**，根因准确性需要另用脱敏黄金集评估；合成模型测试仅证明编排、权限、重试、导出与页面行为，不能证明模型判断正确或所有负载下的性能。

### 2026-11-05：HTTP 兼容与启用开关

修复前，生产包的 Playwright 回归分别复现了 64×32 的偏大开关，以及浏览器没有 `randomUUID` 时分析弹窗中的 `crypto.randomUUID is not a function`。浏览器测试通过初始化脚本移除该方法，保留 `getRandomValues`，模拟普通 HTTP／局域网 IP 的接口可用性；服务端随机源不受影响。

修复后，`pnpm exec playwright test tests/e2e/ai-analysis.spec.ts --workers=1` 两项场景通过。使用真实 Lite 生产页面、持久队列及本地合成模型，验证开关鼠标／键盘操作与保存后重载、模型连接检查、密钥不回显、首次创建批次分析、响应丢失后以相同幂等键重试、429 退避、结论展开、单用例独立重新分析、AI 列实际导出和任务结束自动分析。一次中间复验遇到新测试的“关闭”选择器同时匹配图标和页脚按钮，限定为页脚按钮后完整重跑通过，产品无需因此改动。

开关恢复统一主题下的 44×22，标签点击区域不小于 32px，标签与开关同行。实际查看 1024×768、1536×960 下的深浅色、开关两种状态、批次及单用例分析截图，滑块在轨道内，对齐正常，没有新增溢出或重叠。截图位于 `/var/tmp/autoforge-ai-fixes-ui-20261105/`，完整复验记录为 `/var/tmp/autoforge-ai-fixes-playwright-final-20261105.log`。

最终通过五个相关 Vitest 文件共 39 项测试：浏览器幂等键、共享 UI 使用约束、AI 契约、AI 应用编排及模型网关。变更 TypeScript 文件的 ESLint、`pnpm format:check`（含 Go 格式与许可证）、`pnpm --filter @autoforge/web typecheck`、`pnpm exec tsc --noEmit -p tsconfig.tests.json`、`pnpm test:e2e:matrix` 与 `git diff --check` 均通过。Web 生产构建通过，质量记录为 `/var/tmp/autoforge-ai-fixes-quality-20261105.log`，构建记录为 `/var/tmp/autoforge-ai-fixes-final-build-20261105.log`。

本次仅修改共享浏览器提交和配置表单布局，Lite／Full 共用；未改调度、模型权限、API 契约及数据库 schema。Full 中间件矩阵、真实 Runner 与真实模型未重跑。
