import { describe, expect, it } from "vitest";
import { dependencyPublicationPipeline, groovyStringLiteral } from "./jenkins-pipeline-guide";

describe("Jenkins dependency publication guide", () => {
  it("generates a scoped ZIP example with required integrity metadata and credential binding", () => {
    const pipeline = dependencyPublicationPipeline({
      baseUrl: "https://platform.internal",
      projectId: "project-1",
      version: "中文版本 1.21",
    });
    expect(pipeline).toContain("baseUrl: 'https://platform.internal'");
    expect(pipeline).toContain("projectId: 'project-1'");
    expect(pipeline).toContain("version: '中文版本 1.21'");
    expect(pipeline).toContain("withCredentials([string(credentialsId: 'autoforge-api-key'");
    expect(pipeline).toContain("apiKey: env.AUTOFORGE_API_KEY");
    expect(pipeline).toContain("archiveArtifacts artifacts: archivePath");
    expect(pipeline).toContain('dependencyUrl: "${env.BUILD_URL}artifact/${archivePath}"');
    expect(pipeline).toContain("sha256: dependencySha256");
    expect(pipeline).toContain("sizeBytes: dependencySize");
    expect(pipeline).not.toContain("archiveFormat:");
    expect(pipeline).not.toContain("fileName:");
  });

  it("quotes version names as literal Groovy strings without expanding dollar expressions", () => {
    const pipeline = dependencyPublicationPipeline({
      baseUrl: "http://platform",
      projectId: "project-1",
      version: "Wallet's \\ Release\n${env.SECRET}",
    });
    expect(pipeline).toContain("version: 'Wallet\\'s \\\\ Release\\n${env.SECRET}'");
    expect(pipeline).not.toContain("Release\n${env.SECRET}");
    expect(groovyStringLiteral("a\r\nb")).toBe("'a\\r\\nb'");
  });
});
