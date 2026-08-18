import { describe, expect, it } from "vitest";

import {
  DEFAULT_RUNNER_DATA_DIRECTORY,
  installRunnerAgentInputSchema,
  updateRunnerAgentInputSchema,
} from "../src/management";

const connection = {
  host: "10.20.30.40",
  port: 22,
  username: "runner-admin",
  password: "correct-password",
};

const installInput = {
  connection,
  expectedHostKeySha256: `SHA256:${"a".repeat(43)}`,
  name: "runner-west-1",
};

describe("runner data directory contracts", () => {
  it("defaults to the standard directory when the field is omitted", () => {
    expect(DEFAULT_RUNNER_DATA_DIRECTORY).toBe("/var/lib/autoforge-agent");
    const parsed = installRunnerAgentInputSchema.parse(installInput);
    expect(parsed.dataDirectory).toBeUndefined();
  });

  it("accepts an absolute custom directory for install and update", () => {
    expect(
      installRunnerAgentInputSchema.parse({ ...installInput, dataDirectory: "/data/autoforge" })
        .dataDirectory,
    ).toBe("/data/autoforge");
    expect(
      updateRunnerAgentInputSchema.parse({
        connection,
        expectedHostKeySha256: `SHA256:${"a".repeat(43)}`,
        dataDirectory: "/mnt/large/runner",
      }).dataDirectory,
    ).toBe("/mnt/large/runner");
  });

  it("rejects relative paths, empty values, and traversal segments", () => {
    for (const invalid of ["", "relative/path", "/data/../etc", "/data/..", "//", "/a b/c"]) {
      expect(() =>
        installRunnerAgentInputSchema.parse({ ...installInput, dataDirectory: invalid }),
      ).toThrow();
    }
  });
});
