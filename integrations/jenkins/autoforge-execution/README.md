# AutoForge Execution Jenkins Plugin

`autoforgeRun` 启动一个已经在 AutoForge 中保存完整配置的用例任务，并持续轮询到批次进入
终态。Runner、项目版本、重跑、并发、Adapter 和环境恢复等配置均从任务快照读取，插件不
接受这些参数的临时覆盖。

## 最小 Pipeline 示例

```groovy
withCredentials([string(credentialsId: 'autoforge-api-key', variable: 'AUTOFORGE_API_KEY')]) {
  def result = autoforgeRun(
    baseUrl: 'https://autoforge.internal.example',
    apiKey: env.AUTOFORGE_API_KEY,
    suiteId: '018f-task-id'
  )
  // 插件已输出可点击的“完整结果”，无需再次 echo 原始链接。
  currentBuild.description = "AutoForge：通过 ${result.totalPassed}/${result.totalCases}，最终失败 ${result.finalFailed}"
}
```

## 参数说明

| 参数             | 必填 | 类型     | 默认值 | 说明                                                                                                                                                                                                    |
| ---------------- | ---- | -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`        | 是   | `String` | 无     | AutoForge 控制面的根地址，例如 `https://autoforge.internal.example`。只接受 `http://` 或 `https://`，不要追加 `/api/v1`；该地址必须能由 Jenkins Controller 访问。末尾 `/` 可省略。                      |
| `apiKey`         | 是   | `String` | 无     | AutoForge API Key，格式以 `af_api_` 开头，并且需要对任务所属项目拥有 `run.create` 权限。在平台“系统设置 → 服务账号”中签发后，应通过 Jenkins Credentials 的 Secret text 注入，禁止直接写入 Jenkinsfile。 |
| `suiteId`        | 是   | `String` | 无     | AutoForge 用例任务 ID，不是任务名称、项目 ID 或版本 ID。可在平台任务详情或相关 API 响应中获取；任务必须处于可执行状态并已绑定有效项目版本。                                                             |
| `timeoutSeconds` | 否   | `long`   | `0`    | Jenkins 等待批次进入终态的总时限。`0` 表示采用服务端建议值（当前最多 `604800` 秒，即 7 天）；显式值必须为 `1`–`604800`。超时只终止当前 Jenkins 等待步骤，不会取消已经在 AutoForge 中运行的批次。        |

仅在确实需要缩短 Jenkins 等待时间时设置选填参数：

```groovy
def result = autoforgeRun(
  baseUrl: params.AUTOFORGE_BASE_URL,
  apiKey: env.AUTOFORGE_API_KEY,
  suiteId: params.AUTOFORGE_SUITE_ID,
  timeoutSeconds: 7200 // 选填：最多等待 2 小时
)
```

## 返回值

步骤成功后返回一个 Map，可读取以下字段：

| 字段          | 类型     | 说明                                                                |
| ------------- | -------- | ------------------------------------------------------------------- |
| `batchId`     | `String` | 新建的 AutoForge 执行批次 ID。                                      |
| `status`      | `String` | 批次机器状态；插件只在状态为 `succeeded` 时成功返回。               |
| `statusLabel` | `String` | 面向用户的批次状态名称。                                            |
| `totalCases`  | `int`    | 批次总用例数。                                                      |
| `totalPassed` | `int`    | 汇总后通过的用例数。                                                |
| `finalFailed` | `int`    | 最后一轮仍失败的用例数。TestNG 断言失败不会把批次调度状态改成异常。 |
| `progressUrl` | `String` | 七天有效的匿名实时进度链接。                                        |
| `resultUrl`   | `String` | 永久匿名执行详情链接。                                              |

## 运行行为与网络要求

- 步骤按服务端返回的间隔轮询，进度或状态变化时输出一行；无变化时每隔至少一分钟在
  下次轮询时提示当前状态与已等待时间，避免长时间等待时刷出相同日志。
- 中文日志按开始、进度和结果分段，字段统一对齐；首次收到任务名称时显示名称，保留
  任务和批次编号供排查。终态汇总总数、通过、最终失败、通过率与 Jenkins 等待耗时。
- 启动时显示“实时进度”，终态后显示“完整结果”。在 Jenkins 经典控制台中，这些关键词
  使用原生 `ConsoleNote` 超链接，在新标签页打开并设置 `noopener noreferrer`；无需 ANSI
  颜色插件、HTML 格式化器或全局安全设置调整。链接不再作为长 URL 重复铺在日志正文中。
- 实时进度链接七天有效，完整结果永久有效，两者均为本批次的匿名只读链接。旧平台未
  返回永久链接时，显示“执行结果（7 天内有效）”，不将临时链接标成永久链接。
- 下载的纯文本日志、以及不支持 Jenkins 控制台注解的日志客户端只显示关键词。
  Pipeline 返回的 `progressUrl`、`resultUrl` 保持不变，自动化集成可继续读取这两个字段。
- 用例断言失败与执行流程异常分别呈现：批次状态为 `succeeded` 时仍正常返回，但明确提示
  尚有用例失败；批次异常或取消仍使步骤失败。等待超时/中断会说明平台批次未取消，
  并引导用户从日志中的实时进度继续查看。
- AutoForge 返回的进度 API 地址基于平台“外部访问地址”生成，该地址也必须能由 Jenkins
  Controller 访问，否则批次可以创建成功，但插件无法继续轮询。
- 客户端固定使用 HTTP/1.1，支持未配置 TLS 反向代理的 `http://` Lite 部署。

控制台示例（“实时进度”“完整结果”为可点击关键词）：

```text
[AutoForge] ── 开始执行 ────────────────────
[AutoForge] 任务编号：018f-task-id
[AutoForge] 执行批次：018f-batch-id
[AutoForge] 等待设置：每 30 秒检查进度，最多等待 2 小时
[AutoForge] 查看进度：实时进度（7 天内有效，在新标签页打开）
[AutoForge] 任务名称：订单回归测试
[AutoForge] 执行进度：执行中 | 第 1/2 轮 | 本轮完成 8/10（通过 7，失败 1）| 累计通过 7/10 | 已等待 30 秒
[AutoForge] 执行进度：执行完成 | 第 2/2 轮 | 本轮完成 2/2（通过 1，失败 1）| 累计通过 9/10 | 已等待 1 分 10 秒
[AutoForge] ── 执行完成 ────────────────────
[AutoForge] 用例汇总：总计 10 | 通过 9 | 最终失败 1 | 通过率 90.0%
[AutoForge] 等待耗时：1 分 10 秒
[AutoForge] 查看结果：完整结果（永久有效，在新标签页打开）
[AutoForge] 结果说明：执行流程已完成，仍有 1 项用例失败，请查看结果定位原因。
```

两个插件共用仓库内的 `autoforge-console` Java 库，库随各自 HPI 打包，插件仍可分别安装。
构建需从 `integrations/jenkins/pom.xml` 运行 Maven reactor；不新增单独的插件安装项。

当前插件目录的 [`Jenkinsfile`](./Jenkinsfile) 只填写三个必需参数，可直接复制后替换地址与任务 ID。仓库根目录的 [`examples/jenkins/Jenkinsfile`](../../../examples/jenkins/Jenkinsfile) 给出了与依赖发布步骤组合的完整 Declarative Pipeline。`pnpm test:jenkins-plugins` 会把该步骤加载进真实 Jenkins Pipeline Job 执行，并在 Maven `verify` 后检查 HPI manifest、依赖和内部 step class。
