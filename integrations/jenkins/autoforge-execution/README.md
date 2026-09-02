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
  echo "AutoForge batch: ${result.batchId}"
  echo "Permanent result: ${result.resultUrl}"
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

- 步骤按服务端返回的轮询间隔输出单行轮次进度，并等待任务完整生命周期。
- 控制台启动时输出七天有效的匿名实时进度链接，任务终态后输出永久匿名结果链接；两者
  都是只读链接并且只绑定本批次。
- AutoForge 返回的进度 API 地址基于平台“外部访问地址”生成，该地址也必须能由 Jenkins
  Controller 访问，否则批次可以创建成功，但插件无法继续轮询。
- 客户端固定使用 HTTP/1.1，支持未配置 TLS 反向代理的 `http://` Lite 部署。

当前插件目录的 [`Jenkinsfile`](./Jenkinsfile) 只填写三个必需参数，可直接复制后替换地址与任务 ID。仓库根目录的 [`examples/jenkins/Jenkinsfile`](../../../examples/jenkins/Jenkinsfile) 给出了与依赖发布步骤组合的完整 Declarative Pipeline。`pnpm test:jenkins-plugins` 会把该步骤加载进真实 Jenkins Pipeline Job 执行，并在 Maven `verify` 后检查 HPI manifest、依赖和内部 step class。
