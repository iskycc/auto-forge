# AutoForge Execution Jenkins Plugin

Pipeline 示例：

```groovy
withCredentials([string(credentialsId: 'autoforge-api-key', variable: 'AUTOFORGE_API_KEY')]) {
  def result = autoforgeRun(
    baseUrl: 'https://autoforge.internal.example',
    apiKey: env.AUTOFORGE_API_KEY,
    suiteId: '018f-task-id'
  )
  echo "AutoForge batch: ${result.batchId}"
}
```

步骤会等待任务完整生命周期，并按 30 秒间隔输出单行轮次进度。API 密钥需要 `run.create` 权限；控制台中的进度链接使用独立、只读、限批次的短期令牌。
