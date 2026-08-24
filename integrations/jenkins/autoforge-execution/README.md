# AutoForge Execution Jenkins Plugin

Pipeline 示例：

```groovy
withCredentials([string(credentialsId: 'autoforge-api-key', variable: 'AUTOFORGE_API_KEY')]) {
  def result = autoforgeRun(
    baseUrl: 'https://autoforge.internal.example',
    apiKey: env.AUTOFORGE_API_KEY,
    suiteId: '018f-task-id',
    timeoutSeconds: 86400
  )
  echo "AutoForge batch: ${result.batchId}"
  echo "Permanent result: ${result.resultUrl}"
}
```

步骤会等待任务完整生命周期，并按服务端返回的轮询间隔输出单行轮次进度。`timeoutSeconds`
可选；省略或设为 `0` 时使用服务端的 604800 秒（7 天）上限，也可配置 1–604800 秒的更短
总等待时限。API 密钥需要 `run.create` 权限；控制台在启动时输出七天有效的实时进度链接，
在任务到达终态后输出独立的永久匿名结果链接，返回值中也可通过 `result.resultUrl` 获取。
两种链接都只读且只绑定本批次。客户端固定使用 HTTP/1.1，支持 `http://` Lite 部署。

仓库根目录的 [`examples/jenkins/Jenkinsfile`](../../../examples/jenkins/Jenkinsfile) 给出了与依赖发布步骤组合的完整 Declarative Pipeline。`pnpm test:jenkins-plugins` 会把该步骤加载进真实 Jenkins Pipeline Job 执行，并在 Maven `verify` 后检查 HPI manifest、依赖和内部 step class。
