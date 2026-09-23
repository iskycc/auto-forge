import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: [
      "packages/**/*.test.ts",
      "apps/web/src/**/*.test.{ts,tsx}",
      "apps/web/server/**/*.test.ts",
      "apps/worker/src/**/*.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
    },
  },
});
