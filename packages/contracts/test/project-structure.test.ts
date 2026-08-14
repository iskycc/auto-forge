import { describe, expect, it } from "vitest";

import { runtimeAssetUrlInputSchema } from "../src/project-structure";

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
});
