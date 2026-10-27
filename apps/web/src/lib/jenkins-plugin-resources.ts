import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { DomainError } from "@autoforge/domain";

const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][0-9A-Za-z.-]+)?$/),
  plugins: z
    .array(
      z.object({
        kind: z.enum(["execution", "dependency-publisher"]),
        fileName: z
          .string()
          .regex(/^autoforge-jenkins-(?:execution|dependency-publisher)-[0-9A-Za-z.-]+\.hpi$/),
        sizeBytes: z
          .number()
          .int()
          .positive()
          .max(20 * 1024 * 1024),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .length(2),
});

export async function readJenkinsPlugin(
  resourcesDirectory: string,
  kind: "execution" | "dependency-publisher",
) {
  try {
    const manifest = manifestSchema.parse(
      JSON.parse(await readFile(join(resourcesDirectory, "manifest.json"), "utf8")),
    );
    const plugin = manifest.plugins.find((plugin) => plugin.kind === kind);
    if (!plugin || plugin.fileName !== `autoforge-jenkins-${kind}-${manifest.version}.hpi`)
      throw new Error("Jenkins plugin manifest does not match the requested plugin.");
    const content = await readFile(join(resourcesDirectory, plugin.fileName));
    if (
      content.byteLength !== plugin.sizeBytes ||
      createHash("sha256").update(content).digest("hex") !== plugin.sha256
    )
      throw new Error("Jenkins plugin checksum does not match the packaged manifest.");
    return { content, fileName: plugin.fileName, sha256: plugin.sha256 };
  } catch (cause) {
    throw new DomainError(
      "JENKINS_PLUGIN_UNAVAILABLE",
      "内置 Jenkins 插件缺失或校验失败，请使用完整的主平台发布包。",
      { cause },
    );
  }
}
