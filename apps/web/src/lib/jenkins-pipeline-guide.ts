/** Single-quoted Groovy values keep project names and URLs out of executable syntax. */
export function groovyStringLiteral(value: string): string {
  return `'${value
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'")
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n")}'`;
}

export function dependencyPublicationPipeline(scope: {
  baseUrl: string;
  projectId: string;
  version: string;
}): string {
  return `// 在 Pipeline 的 steps 中使用；先构建好此依赖压缩包。
withCredentials([string(credentialsId: 'autoforge-api-key', variable: 'AUTOFORGE_API_KEY')]) {
  autoforgePublishDependencies(
    baseUrl: ${groovyStringLiteral(scope.baseUrl)},
    apiKey: env.AUTOFORGE_API_KEY,
    projectId: ${groovyStringLiteral(scope.projectId)},
    version: ${groovyStringLiteral(scope.version)},
    // 也支持当前 Agent 的绝对路径，例如 /opt/builds/dependencies.zip 或 D:/builds/dependencies.zip。
    filePath: 'target/autoforge-dependencies.zip'
  )
}`;
}
