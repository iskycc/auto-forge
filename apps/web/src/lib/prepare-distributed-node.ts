import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  persistedPlatformConfigurationSchema,
  type PersistedPlatformConfiguration,
} from "@autoforge/platform-config";

export function prepareDistributedNode(
  source: PersistedPlatformConfiguration,
  outputFile: string,
  identity: "original" | "new",
): string {
  if (source.mode !== "full") throw new Error("请先完成 Full 基础设施配置，再生成分布式节点配置。");
  const configuration = persistedPlatformConfigurationSchema.parse({
    ...source,
    deployment: "distributed",
    nodeId: identity === "new" ? randomUUID() : (source.nodeId ?? randomUUID()),
  });
  const destination = resolve(outputFile);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  // Fail rather than overwrite a deployed node identity or its encryption material.
  writeFileSync(destination, `${JSON.stringify(configuration, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  return configuration.nodeId!;
}
