# AutoForge Dependency Publisher Jenkins Plugin

`autoforgePublishDependencies` 在构建完成后，把可由 Runner 访问的依赖压缩包链接登记到
指定项目版本。它发布的是外部 URL 和完整性元数据，不会把 Jenkins 工作区文件直接上传到
AutoForge。

## 最小 Pipeline 示例

```groovy
withCredentials([string(credentialsId: 'autoforge-api-key', variable: 'AUTOFORGE_API_KEY')]) {
  autoforgePublishDependencies(
    baseUrl: 'https://autoforge.internal.example',
    apiKey: env.AUTOFORGE_API_KEY,
    projectId: '018f-project-id',
    version: '1.8.0',
    dependencyUrl: 'https://jenkins.internal/job/app/42/artifact/test-dependencies.zip',
    sha256: env.DEPENDENCY_SHA256,
    sizeBytes: 12345678
  )
}
```

## 参数说明

| 参数            | 必填 | 类型     | 默认值                       | 说明                                                                                                                                                                                                                      |
| --------------- | ---- | -------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`       | 是   | `String` | 无                           | AutoForge 控制面的根地址，例如 `https://autoforge.internal.example`。只接受 `http://` 或 `https://`，不要追加 `/api/v1`；该地址必须能由 Jenkins Controller 访问。末尾 `/` 可省略。                                        |
| `apiKey`        | 是   | `String` | 无                           | AutoForge API Key，格式以 `af_api_` 开头，并且需要对目标项目拥有 `project.manage` 权限。在平台“系统设置 → 服务账号”中签发后，应通过 Jenkins Credentials 的 Secret text 注入，禁止直接写入 Jenkinsfile。                   |
| `projectId`     | 是   | `String` | 无                           | AutoForge 目标项目 ID，不是项目名称。API Key 必须对该项目有权限。                                                                                                                                                         |
| `version`       | 是   | `String` | 无                           | 目标项目的版本名称，例如 `1.8.0`，不是版本 ID。按忽略首尾空白和大小写的名称匹配；版本不存在时平台会创建该版本，已归档版本会拒绝更新。                                                                                     |
| `dependencyUrl` | 是   | `String` | 无                           | 压缩包的完整 `http://` 或 `https://` 下载地址，最长 2048 个字符且不能在 URL 中携带用户名或密码。执行任务的所有候选 Runner 都必须能访问该地址；若使用 Jenkins Artifact URL，应确保无需交互式登录或另行提供网络侧访问能力。 |
| `sha256`        | 是   | `String` | 无                           | 压缩包实际内容的 SHA-256，必须是 64 位小写十六进制。可用 `sha256sum <文件>` 生成。Runner 下载后会据此校验内容。                                                                                                           |
| `sizeBytes`     | 是   | `long`   | 无                           | 压缩包实际字节数，必须为正整数且不超过 JavaScript 安全整数。可用 Linux `stat -c %s <文件>` 生成，必须与下载内容完全一致。                                                                                                 |
| `fileName`      | 否   | `String` | `autoforge-dependencies.zip` | 平台和 Runner 使用的逻辑文件名。ZIP 必须以 `.zip` 结尾；`tar.gz` 格式必须以 `.tar.gz` 或 `.tgz` 结尾。不能是空字符串。                                                                                                    |
| `archiveFormat` | 否   | `String` | `zip`                        | 压缩格式，只允许 `zip` 或 `tar.gz`。发布非 ZIP 包时必须与 `fileName` 一起显式设置。                                                                                                                                       |

发布 `tar.gz` 或 `.tgz` 时的选填参数示例：

```groovy
autoforgePublishDependencies(
  baseUrl: params.AUTOFORGE_BASE_URL,
  apiKey: env.AUTOFORGE_API_KEY,
  projectId: params.AUTOFORGE_PROJECT_ID,
  version: params.AUTOFORGE_PROJECT_VERSION,
  dependencyUrl: "${env.BUILD_URL}artifact/target/autoforge-dependencies.tar.gz",
  sha256: env.DEPENDENCY_SHA256,
  sizeBytes: env.DEPENDENCY_SIZE as Long,
  fileName: 'autoforge-dependencies.tar.gz', // 选填；非 ZIP 时需要显式填写
  archiveFormat: 'tar.gz'                   // 选填；非 ZIP 时需要显式填写
)
```

## 返回值

步骤成功后返回包含 `projectId`、`projectVersionId`、`version` 和 `assetId` 的 Map；其中
`assetId` 是本次登记的新依赖资产 ID。

## 运行行为与网络要求

- 同一项目版本每次只保留最新依赖元数据；新链接原子替换旧链接，不累积历史文件。
- ZIP 是默认格式，最小示例只填写安全校验所必需的 SHA-256 与字节数。
- 插件客户端固定使用 HTTP/1.1；服务端拒绝请求时，Pipeline 控制台与构建错误会包含经过
  安全提取的具体原因。
- 插件不会转发 Jenkins 登录 Cookie 或下载凭据。依赖 URL 若受保护，应在网络入口提供
  Runner 可使用的受控下载机制，不要把账号、密码或 API Key 拼接进 URL。

当前插件目录的 [`Jenkinsfile`](./Jenkinsfile) 是只包含必要参数的独立示例。完整构建、归档、发布依赖并执行任务的 Declarative Pipeline 见 [`examples/jenkins/Jenkinsfile`](../../../examples/jenkins/Jenkinsfile)。依赖 URL 必须能由执行该项目任务的 Runner 所在网络读取。
