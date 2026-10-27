import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJenkinsPlugin } from "./jenkins-plugin-resources";

describe("embedded Jenkins plugin downloads", () => {
  it("returns the pinned artifact and rejects corruption, traversal and missing resources", async () => {
    const directory = await mkdtemp(join(tmpdir(), "autoforge-jenkins-"));
    const content = Buffer.from("packaged-hpi-content");
    const fileName = "autoforge-jenkins-execution-1.2.3.hpi";
    const plugin = {
      kind: "execution",
      fileName,
      sizeBytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
    const manifest = {
      schemaVersion: 1,
      version: "1.2.3",
      plugins: [
        plugin,
        {
          ...plugin,
          kind: "dependency-publisher",
          fileName: "autoforge-jenkins-dependency-publisher-1.2.3.hpi",
        },
      ],
    };
    try {
      await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
      await writeFile(join(directory, fileName), content);
      expect(await readJenkinsPlugin(directory, "execution")).toMatchObject({
        content,
        fileName,
        sha256: plugin.sha256,
      });
      await writeFile(join(directory, fileName), "bad");
      await expect(readJenkinsPlugin(directory, "execution")).rejects.toMatchObject({
        code: "JENKINS_PLUGIN_UNAVAILABLE",
      });
      await writeFile(
        join(directory, "manifest.json"),
        JSON.stringify({
          ...manifest,
          plugins: [{ ...plugin, fileName: "../../secret" }, manifest.plugins[1]],
        }),
      );
      await expect(readJenkinsPlugin(directory, "execution")).rejects.toMatchObject({
        code: "JENKINS_PLUGIN_UNAVAILABLE",
      });
      await rm(join(directory, "manifest.json"));
      await expect(readJenkinsPlugin(directory, "execution")).rejects.toMatchObject({
        code: "JENKINS_PLUGIN_UNAVAILABLE",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
