# AutoForge Dependency Publisher Jenkins Plugin

构建完成后将可由 Runner 访问的依赖压缩包链接推送到指定项目版本：

```groovy
withCredentials([string(credentialsId: 'autoforge-api-key', variable: 'AUTOFORGE_API_KEY')]) {
  autoforgePublishDependencies(
    baseUrl: 'https://autoforge.internal.example',
    apiKey: env.AUTOFORGE_API_KEY,
    projectId: '018f-project-id',
    version: '1.8.0',
    dependencyUrl: 'https://jenkins.internal/job/app/42/artifact/test-dependencies.zip',
    fileName: 'test-dependencies.zip',
    sha256: env.DEPENDENCY_SHA256,
    sizeBytes: 12345678,
    archiveFormat: 'zip'
  )
}
```

API 密钥需要目标项目的 `project.manage` 权限。同一项目版本每次只保留最新依赖元数据；新链接会原子替换旧链接，不累积历史文件。

完整构建、归档、发布依赖并执行任务的 Declarative Pipeline 见 [`examples/jenkins/Jenkinsfile`](../../../examples/jenkins/Jenkinsfile)。依赖 URL 必须能由 AutoForge 控制面和 Runner 所在网络读取。
