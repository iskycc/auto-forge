# AutoForge Execution Jenkins Plugin

`autoforgeRun` 启动一个已经在 AutoForge 中保存完整配置的用例任务，并持续轮询到批次进入
终态。Runner、项目版本、重跑、并发、Adapter 和环境恢复等配置均从任务快照读取，插件不
接受这些参数的临时覆盖。

最低支持 Jenkins `2.479.3` 和 Pipeline: Step API `700.v6e45cb_a_5a_a_21`，安装与兼容性验证见[插件说明](../README.md)。

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
| `apiKey`         | 是   | `String` | 无     | AutoForge API Key，格式以 `af_api_` 开头；服务账号和令牌 scopes 均需对任务所属项目拥有 `run.create`、`run.cancel`、`run.read` 权限，分别用于启动、停止与确认收尾。在平台“系统设置 → 服务账号”中签发后，通过 Jenkins Credentials 的 Secret text 注入，禁止直接写入 Jenkinsfile。 |
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
| `progressUrl` | `String` | 与 `resultUrl` 相同的匿名执行详情链接。                                        |
| `resultUrl`   | `String` | 永久匿名执行详情链接。                                              |

## 运行行为与网络要求

- 步骤按服务端返回的间隔轮询，进度或状态变化时输出一行；无变化时每隔至少一分钟在
  下次轮询时提示当前状态与已等待时间，避免长时间等待时刷出相同日志。
- 中文日志按开始、进度和结果分段，字段统一对齐；首次收到任务名称时显示名称，保留
  任务和批次编号供排查。终态汇总总数、通过、最终失败、通过率与 Jenkins 等待耗时。
- 启动与等待超时时显示“执行详情”，终态后显示“完整结果”，均指向同一地址。
  在 Jenkins 经典控制台中，这些关键词使用原生 `ConsoleNote` 超链接，在新标签页打开并设置 `noopener noreferrer`；无需 ANSI
  颜色插件、HTML 格式化器或全局安全设置调整。链接不再作为长 URL 重复铺在日志正文中。
- 运行中即可查看概览、轮次、用例及公开日志，详情链接永久有效；机器轮询仍使用独立的
  七天有效进度 API。旧平台未返回 `resultUrl` 时，两处均回退到临时 `progressUrl`，
  并明确显示“7 天内有效”。
- 下载的纯文本日志、以及不支持 Jenkins 控制台注解的日志客户端只显示关键词。
  Pipeline 保留 `progressUrl`、`resultUrl` 字段，两者统一返回上述详情地址；新版插件连接
  返回不同链接的旧平台时，也优先使用 `resultUrl`。
- 用例断言失败与执行流程异常分别呈现：批次状态为 `succeeded` 时仍正常返回，但明确提示
  尚有用例失败；批次异常或取消仍使步骤失败。插件自身的 `timeoutSeconds` 到期只停止等待，
  不会自动取消平台批次，并提示从执行详情继续查看。
- Jenkins 向正在执行的 `autoforgeRun` 步骤发送停止信号时（例如手动停止或外层 Pipeline
  `timeout`），插件使用 API Key 请求终止对应批次。平台停止派发、重跑和轮次恢复，已领取
  用例按平台现有平滑终止语义完成并上传结果；插件等待权威进度进入终态，再打印最终汇总、
  已取消/未执行数量及原来的完整结果链接，最后传播 Jenkins 的原始中断，构建通常为 `ABORTED`。
  Pipeline 的 `finally` / `post` 随后执行；中断路径不会正常返回步骤的 Map。
- 终止请求的 HTTP 成功或 `terminating: false` 不单独作为完成依据；插件仍读取终态报告。
  多次普通停止信号复用同一收尾流程。如果停止时创建请求尚在进行，会先等待其回执取得批次 ID，
  避免直接中断 HTTP 而遗失需要终止的批次。
- 收尾使用独立时限，取创建回执的 `completionTimeoutSeconds`（当前平台为 7 天），不受
  插件原来的等待剩余时间影响。进度使用控制面地址和 API Key，避免临时进度令牌在收尾期间到期；
  单次 HTTP 请求最多 30 秒，正常收尾每 5 秒检查。网络异常、HTTP 408/409/429/5xx 在总时限内
  以 10～30 秒退避重试；权限错误等不重试。未确认终态时明确输出“终止未确认”和报告入口，
  不将“请求已送达”报告为“完全结束”。旧令牌若只有 `run.create` 权限，需要补齐 `run.cancel` 和 `run.read`。
- Jenkins 的强制 `term` / `kill`、Controller 被强杀或崩溃可能绕过步骤清理，无法保证等待和
  打印报告；当前同步工作线程也不支持 Controller 重启后续等，详见 [Jenkins 停止方式](https://www.jenkins.io/doc/book/using/aborting-a-build/)。
  创建请求已提交但回执因网络故障丢失时，插件无法确定批次 ID，不重复创建，并提示到平台执行历史核查。
- AutoForge 返回的进度 API 地址基于平台“外部访问地址”生成，该地址也必须能由 Jenkins
  Controller 访问，否则批次可以创建成功，但插件无法继续轮询。
- 客户端固定使用 HTTP/1.1，支持未配置 TLS 反向代理的 `http://` Lite 部署。

控制台示例（“执行详情”“完整结果”为可点击关键词）：

```text
[AutoForge] ── 开始执行 ────────────────────
[AutoForge] 任务编号：018f-task-id
[AutoForge] 执行批次：018f-batch-id
[AutoForge] 等待设置：每 30 秒检查进度，最多等待 2 小时
[AutoForge] 查看进度：执行详情（永久有效，在新标签页打开）
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
