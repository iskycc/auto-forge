import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const e2eDataDirectory = mkdtempSync(join(tmpdir(), "autoforge-e2e-"));

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
          : {},
      },
    },
  ],
  webServer: {
    command: "pnpm --filter @autoforge/web dev",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: true,
    timeout: 120_000,
    env: {
      ...process.env,
      AUTOFORGE_MODE: "lite",
      AUTOFORGE_DATA_DIR: e2eDataDirectory,
      AUTOFORGE_RUNNER_BOOTSTRAP_TOKEN: "e2e-runner-bootstrap-token-000000000000",
      AUTOFORGE_TERMINAL_ACCESS_TOKEN: "e2e-terminal-access-token-000000000000",
      HOSTNAME: "127.0.0.1",
      PORT: "3100",
    },
  },
});
