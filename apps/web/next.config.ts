import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
    "@autoforge/platform-config",
    "@autoforge/runner-sdk",
    "@autoforge/testng-discovery",
  ],
};

export default nextConfig;
