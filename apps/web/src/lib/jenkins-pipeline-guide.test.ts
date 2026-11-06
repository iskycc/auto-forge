import { describe, expect, it } from "vitest";
import { dependencyPublicationPipeline, groovyStringLiteral } from "./jenkins-pipeline-guide";

describe("Jenkins dependency publication guide", () => {
  it("generates a direct workspace upload with credentials and no archive or shell steps", () => {
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
    expect(pipeline).toContain("filePath: 'target/autoforge-dependencies.zip'");
    expect(pipeline).not.toMatch(
      /archiveArtifacts|dependencyUrl:|sha256sum|stat -c|sha256:|sizeBytes:/u,
    );
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
