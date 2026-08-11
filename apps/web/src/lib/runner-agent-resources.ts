import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { DomainError } from "@autoforge/domain";
import { z } from "zod";

const MAXIMUM_AGENT_RESOURCE_BYTES = 64 * 1024 * 1024;

const resourceFileSchema = z.object({
  path: z.string().min(1).max(256),
  size: z.number().int().positive().max(MAXIMUM_AGENT_RESOURCE_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

const agentResourceManifestSchema = z.object({
  schemaVersion: z.literal(1),
  version: z.string().min(1).max(64),
  revision: z.string().min(1).max(128),
  createdAt: z.iso.datetime({ offset: true }),
  files: z.object({
    "linux-amd64": resourceFileSchema,
    "linux-arm64": resourceFileSchema,
    installer: resourceFileSchema,
  }),
});

export type AgentArchitecture = "amd64" | "arm64";

export type RunnerAgentResources = {
  version: string;
  revision: string;
  binary: Buffer;
  installer: Buffer;
};

export class RunnerAgentResourceStore {
  constructor(private readonly resourceDirectory: string) {}

  async read(architecture: AgentArchitecture): Promise<RunnerAgentResources> {
    try {
      const manifest = agentResourceManifestSchema.parse(
        JSON.parse(await readFile(join(this.resourceDirectory, "manifest.json"), "utf8")),
      );
      const binary = await this.readVerifiedFile(
        manifest.files[`linux-${architecture}`],
        `linux-${architecture}/autoforge-agent`,
      );
      const installer = await this.readVerifiedFile(manifest.files.installer, "install.sh");
      return {
        version: manifest.version,
        revision: manifest.revision,
        binary,
        installer,
      };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        "RUNNER_AGENT_RESOURCE_UNAVAILABLE",
        "平台内置 Agent 资源不可用，请重新构建或安装完整的主平台发布物。",
        { cause: error },
      );
    }
  }

  private async readVerifiedFile(
    file: z.infer<typeof resourceFileSchema>,
    requiredRelativePath: string,
  ): Promise<Buffer> {
    if (file.path !== requiredRelativePath) {
      throw new DomainError(
        "RUNNER_AGENT_RESOURCE_INVALID",
        `Agent 资源清单路径不匹配：${requiredRelativePath}`,
      );
    }
    const absolutePath = resolve(this.resourceDirectory, file.path);
    if (!absolutePath.startsWith(`${resolve(this.resourceDirectory)}/`)) {
      throw new DomainError("RUNNER_AGENT_RESOURCE_INVALID", "Agent 资源路径越界。", undefined);
    }
    const content = await readFile(absolutePath);
    const digest = createHash("sha256").update(content).digest("hex");
    if (content.byteLength !== file.size || digest !== file.sha256) {
      throw new DomainError(
        "RUNNER_AGENT_RESOURCE_INVALID",
        `Agent 资源校验失败：${requiredRelativePath}`,
      );
    }
    return content;
  }
}
