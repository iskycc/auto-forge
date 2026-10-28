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
  return `// 在 Pipeline 的 steps 中使用；先构建好此 ZIP 文件。
script {
  def archivePath = 'target/autoforge-dependencies.zip'
  archiveArtifacts artifacts: archivePath, fingerprint: true
  def dependencySha256 = sh(
    script: "sha256sum '\${archivePath}'",
    returnStdout: true
  ).trim().tokenize()[0]
  def dependencySize = sh(
    script: "stat -c %s '\${archivePath}'",
    returnStdout: true
  ).trim().toLong()

  withCredentials([string(credentialsId: 'autoforge-api-key', variable: 'AUTOFORGE_API_KEY')]) {
    autoforgePublishDependencies(
      baseUrl: ${groovyStringLiteral(scope.baseUrl)},
      apiKey: env.AUTOFORGE_API_KEY,
      projectId: ${groovyStringLiteral(scope.projectId)},
      version: ${groovyStringLiteral(scope.version)},
      dependencyUrl: "\${env.BUILD_URL}artifact/\${archivePath}",
      sha256: dependencySha256,
      sizeBytes: dependencySize
    )
  }
}`;
}
