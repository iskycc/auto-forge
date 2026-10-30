import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/archive-viewer",
  timeout: 90_000,
  workers: 1,
  retries: 0,
  use: {
    viewport: { width: 1536, height: 960 },
    trace: "retain-on-failure",
    actionTimeout: 15_000,
  },
});
