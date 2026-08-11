import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlatformConfigurationStore } from "@autoforge/platform-config";

const e2eDataDirectory =
  process.env.AUTOFORGE_E2E_DATA_DIR ?? mkdtempSync(join(tmpdir(), "autoforge-e2e-"));
process.env.AUTOFORGE_E2E_DATA_DIR = e2eDataDirectory;
const e2eConfigurationStore = new PlatformConfigurationStore(e2eDataDirectory);
const initialConfiguration = e2eConfigurationStore.initialize();
const e2eConfiguration =
  initialConfiguration.web.port === 3100
    ? initialConfiguration
    : e2eConfigurationStore.replace(
        {
          ...initialConfiguration,
          web: {
            ...initialConfiguration.web,
            hostname: "127.0.0.1",
            port: 3100,
            publicBaseUrl: "http://127.0.0.1:3100",
            publicDashboardRefreshSeconds: 5,
          },
        },
        initialConfiguration.revision,
      );
process.env.E2E_ADMIN_BOOTSTRAP_TOKEN = e2eConfiguration.secrets.adminBootstrapToken;
process.env.E2E_RUNNER_BOOTSTRAP_TOKEN = e2eConfiguration.secrets.runnerBootstrapToken;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 300_000,
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
        viewport: { width: 1536, height: 1024 },
        launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
          : {},
      },
    },
  ],
  webServer: {
    command: `pnpm --filter @autoforge/web build && NODE_ENV=production pnpm --filter @autoforge/web start -- --data-dir=${e2eDataDirectory}`,
    url: "http://127.0.0.1:3100",
    reuseExistingServer: true,
    timeout: 120_000,
    env: {
      ...process.env,
      NODE_ENV: "production",
    },
  },
});
