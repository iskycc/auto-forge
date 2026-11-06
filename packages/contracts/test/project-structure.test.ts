import { describe, expect, it } from "vitest";

import {
  jenkinsDependencyPublicationInputSchema,
  jenkinsDependencyUploadInputSchema,
  runtimeAssetUrlInputSchema,
} from "../src/project-structure";

describe("project runtime asset contracts", () => {
  const validInput = {
    kind: "jdk",
    url: "http://10.0.0.9/runtime/jdk.tar.gz",
    fileName: "jdk.tar.gz",
    sha256: "a".repeat(64),
    sizeBytes: 1_024,
    archiveFormat: "tar.gz",
  };

  it("allows direct internal HTTP links with explicit integrity metadata", () => {
    expect(runtimeAssetUrlInputSchema.parse(validInput)).toMatchObject(validInput);
  });

  it("rejects credentials and archive extensions that disagree with the declared format", () => {
    expect(() =>
      runtimeAssetUrlInputSchema.parse({
        ...validInput,
        url: "http://user:password@10.0.0.9/runtime/jdk.tar.gz",
      }),
    ).toThrow();
    expect(() =>
      runtimeAssetUrlInputSchema.parse({ ...validInput, fileName: "jdk.zip" }),
    ).toThrow();
  });

  it("accepts a version-scoped Jenkins dependency archive without a client-controlled kind", () => {
    const publication = jenkinsDependencyPublicationInputSchema.parse({
      projectId: "project-1",
      version: "2026.08",
      dependencyArchive: {
        url: "https://jenkins.internal/artifacts/dependencies.zip",
        fileName: "dependencies.zip",
        sha256: "b".repeat(64),
        sizeBytes: 8_192,
        archiveFormat: "zip",
      },
    });

    expect(publication.version).toBe("2026.08");
    expect(publication.dependencyArchive).not.toHaveProperty("kind");
  });

  it("validates plugin-computed upload metadata without accepting URLs or resource kinds", () => {
    const input = {
      projectId: "project-1",
      version: "钱包版本",
      fileName: "依赖.zip",
      sha256: "a".repeat(64),
      sizeBytes: 32,
    };
    expect(jenkinsDependencyUploadInputSchema.parse(input)).toMatchObject({
      ...input,
      archiveFormat: "zip",
    });
    for (const invalid of [
      { ...input, kind: "jdk" },
      { ...input, url: "https://outside.invalid/archive.zip" },
      { ...input, fileName: "依赖.tgz" },
      { ...input, sizeBytes: 0 },
      { ...input, sha256: "invalid" },
    ])
      expect(jenkinsDependencyUploadInputSchema.safeParse(invalid).success).toBe(false);
  });
});
