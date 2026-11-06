# AutoForge Dependency Publisher Jenkins Plugin

`autoforgePublishDependencies` 直接读取 **Jenkins Agent 上已经构建好的依赖压缩包**，
在插件内部计算 SHA-256 和字节数，再流式上传到 AutoForge，原子替换指定项目版本的依赖绑定。
不需要 `archiveArtifacts`、Artifact URL、`sha256sum`、`stat` 或额外上传脚本。

最低支持 Jenkins `2.479.3`、Java 17 和 Pipeline: Step API `700.v6e45cb_a_5a_a_21`，
安装与兼容性验证见[插件说明](../README.md)。HPI 随主平台交付，可在“项目设置 →
JDK 与依赖 JAR 压缩包 → Jenkins 接入指导”下载，弹窗提供当前项目、版本的 Pipeline 示例。

## 最小 Pipeline 示例

在已分配 `agent` 的 Declarative Pipeline `steps` 内，或 Scripted Pipeline 的 `node` 内调用：

```groovy
withCredentials([string(credentialsId: 'autoforge-api-key', variable: 'AUTOFORGE_API_KEY')]) {
  autoforgePublishDependencies(
    baseUrl: 'https://autoforge.internal.example',
    apiKey: env.AUTOFORGE_API_KEY,
    projectId: '018f-project-id',
    version: '1.8.0',
    filePath: 'target/autoforge-dependencies.zip'
  )
}
```

将 `filePath` 改为实际构建产物路径即可，支持工作区相对路径和当前 Agent 的绝对路径。ZIP、`.tar.gz` 和 `.tgz` 都自动识别；
Windows Agent 同样不需要安装 Shell 或摘要工具。文件必须已生成且不再被其他构建修改。
插件通过 Jenkins `FilePath.act` 在当前 Agent 上完成读取和 HTTP 上传，不把整个文件经
Controller 内存中转。Agent 必须能访问 `baseUrl`。

绝对路径示例（同样需要放在 `node` 或已分配 `agent` 的 `steps` 中）：

```groovy
// Linux Agent
filePath: '/opt/builds/autoforge-dependencies.zip'
// Windows Agent：使用正斜杠可避免 Groovy 反斜杠转义
filePath: 'D:/builds/autoforge-dependencies.zip'
```

路径必须存在于**当前执行该步骤的 Jenkins Agent**，而非 Controller 或主平台机器。
绝对路径文件不要求工作区目录已经生成；相对路径仍依赖工作区。摘要、大小和上传方式相同，
本次不改变 AutoForge API、项目权限、Lite／Full 对象存储或 Runner 下载协议。

## 参数说明

| 参数 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `baseUrl` | 是 | 无 | AutoForge HTTP(S) 根地址，不追加 `/api/v1`，不能携带账号、密码或查询参数。当前 Jenkins Agent 必须能访问。 |
| `apiKey` | 是 | 无 | `af_api_` 开头的 API Key。服务账号与令牌均需目标项目的“管理项目”（`project.manage`）权限。通过 Jenkins Secret text 凭据注入，禁止明文写入 Jenkinsfile。 |
| `projectId` | 是 | 无 | 目标项目 ID，不是项目名称。 |
| `version` | 是 | 无 | 版本名称，不是版本 ID。忽略首尾空白、大小写及兼容字符差异；不存在时创建，已归档时拒绝。 |
| `filePath` | 是 | 无 | 当前 Agent 上的普通文件路径，支持工作区相对路径或绝对路径。相对路径不得通过 `..` 或符号链接越出工作区；绝对路径允许工作区外文件，按 Agent 原生系统语义解析，并要求 Agent 运行账号可读。不支持通配符、`~` 或 Shell 变量展开。 |
| `fileName` | 否 | 本地文件名 | 仅需更改平台显示文件名时填写；必须保留与格式一致的扩展名。 |
| `archiveFormat` | 否 | 根据文件名识别 | 可填 `zip` 或 `tar.gz`；通常不必填写。 |

## 返回值和执行行为

返回 Map 包含 `projectId`、`projectVersionId`、`version`、`assetId`、`fileName`、`sha256`
和 `sizeBytes`。控制台展示中文上传阶段、文件、大小、摘要和资产编号，不输出 API Key。

- 平台先鉴权，再流式暂存并重新计算摘要、大小和压缩格式签名；校验通过才写入托管存储
  并更新版本绑定。Lite 使用本地对象存储，Full 使用 MinIO；Runner 沿用平台的受控下载协议。
- 只更新目标版本的依赖绑定，保留 JDK；不导入测试类、不自动执行任务。后续新建批次使用新绑定，
  已创建批次保持原执行快照。旧上传文件保留在托管文件库，沿用引用保护和文件管理清理流程。
- 文件缺失、空文件、扩展名错误、相对路径越界、文件不可读或上传期间文件改变会失败；服务端拒绝时展示可操作原因。
  数据库登记失败会清理本次新上传对象，保留原绑定；版本在上传期间被归档也会拒绝登记。
- 使用 HTTP/1.1，不跟随重定向；连接超时 15 秒，上传请求等待上限 15 分钟。大文件采用有界缓冲，
  不整体装入 Java 或 Web 内存。平台暂存占用数据目录磁盘，需保留足够余量。
- 不自动重试上传。网络超时或 Jenkins 停止可能发生在平台已提交之后，请先刷新版本配置核对；
  手工重试会发布一个新资产并更新绑定。该步骤不支持跨 Controller 重启恢复，重启后需要重新运行。

共享控制台库 `autoforge-console` 随 HPI 内置，无需额外安装。
独立示例见 [`Jenkinsfile`](./Jenkinsfile)，完整构建、发布及执行见
[`examples/jenkins/Jenkinsfile`](../../../examples/jenkins/Jenkinsfile)。

## 旧流水线兼容

已有 `dependencyUrl`、`sha256`、`sizeBytes` 参数及 `POST /api/v1/jenkins/dependencies`
保持兼容，避免升级插件后破坏现有流水线；新示例均使用 `filePath`，不能同时传入 `filePath`
和 `dependencyUrl`。旧 URL 模式仍要求候选 Runner 可直接下载该 URL，不会变成文件上传。

新上传接口为 `POST /api/v1/jenkins/dependencies/upload`：查询参数 `projectId`、`version`、
`archiveFormat`，请求头 `Authorization: Bearer …`、`X-Autoforge-Sha256`、
`X-Autoforge-File-Name`（UTF-8 百分号编码），正文为文件原始字节，`Content-Length` 由插件计算。
接口成功返回 HTTP 201；业务校验失败返回稳定错误码与 `requestId`。日常接入直接调用插件即可。

开发构建与测试使用 `mvn --file integrations/jenkins/pom.xml clean verify`。
