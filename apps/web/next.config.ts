import type { NextConfig } from "next";
import { resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "../..");

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: workspaceRoot,
  outputFileTracingIncludes: {
    "/*": ["../../packages/db/drizzle/sqlite/*.sql", "../../packages/db/drizzle/postgresql/*.sql"],
  },
  reactStrictMode: true,
  serverExternalPackages: ["better-sqlite3"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
  transpilePackages: [
    "@autoforge/application",
    "@autoforge/contracts",
    "@autoforge/db",
    "@autoforge/domain",
    "@autoforge/object-store",
    "@autoforge/runner-sdk",
    "@autoforge/testng-discovery",
  ],
};

export default nextConfig;
