import type { NextConfig } from "next";
import { resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "../..");

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: workspaceRoot,
  outputFileTracingIncludes: {
    "/*": ["../../packages/db/drizzle/sqlite/*.sql"],
  },
  reactStrictMode: true,
  serverExternalPackages: ["better-sqlite3"],
  transpilePackages: [
    "@autoforge/application",
    "@autoforge/contracts",
    "@autoforge/db",
    "@autoforge/domain",
    "@autoforge/object-store",
    "@autoforge/testng-discovery",
  ],
};

export default nextConfig;
