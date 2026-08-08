import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

const environmentSchema = z.object({
  AUTOFORGE_MODE: z.enum(["lite", "full"]).default("lite"),
  AUTOFORGE_DATA_DIR: z.string().min(1).optional(),
  AUTOFORGE_MAX_JAR_BYTES: z.coerce
    .number()
    .int()
    .min(1_048_576)
    .max(268_435_456)
    .default(33_554_432),
});

export type AppConfig = {
  mode: "lite";
  workspaceRoot: string;
  dataDirectory: string;
  databasePath: string;
  migrationsFolder: string;
  maxJarBytes: number;
};

function findWorkspaceRoot(startDirectory: string): string {
  let current = resolve(startDirectory);
  for (;;) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) {
      throw new Error("无法定位包含 pnpm-workspace.yaml 的 AutoForge 工作区根目录。");
    }
    current = parent;
  }
}

export function loadAppConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(environment);
  if (parsed.AUTOFORGE_MODE === "full") {
    throw new Error("当前里程碑仅实现 Lite 模式；Full 适配器尚未完成，拒绝以 full 启动。");
  }

  const workspaceRoot = findWorkspaceRoot(process.cwd());
  const configuredDataDirectory = parsed.AUTOFORGE_DATA_DIR ?? "./data";
  const dataDirectory = isAbsolute(configuredDataDirectory)
    ? configuredDataDirectory
    : resolve(workspaceRoot, configuredDataDirectory);

  return {
    mode: "lite",
    workspaceRoot,
    dataDirectory,
    databasePath: join(dataDirectory, "db", "autoforge.sqlite"),
    migrationsFolder: join(workspaceRoot, "packages", "db", "drizzle", "sqlite"),
    maxJarBytes: parsed.AUTOFORGE_MAX_JAR_BYTES,
  };
}
