import { expect, test, type Page } from "@playwright/test";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";

import { browserJson, ensureAdministrator, selectProjectContext } from "./support/session";

test("persists a business sentinel across release migration and rollback", async ({ page }) => {
  await ensureAdministrator(page);
  const sentinel = requiredEnvironment("E2E_UPGRADE_SENTINEL");
  const phase = requiredEnvironment("E2E_UPGRADE_PHASE");

  if (phase === "seed") {
    const projectVersionId = await ensureDefaultProjectVersion(page);
    const created = await browserJson<{ id: string; name: string }>(page, "/api/v1/case-suites", {
      method: "POST",
      body: {
        projectId: DEFAULT_PROJECT_ID,
        name: sentinel,
        description: "Immutable release upgrade and rollback sentinel",
        policy: { projectVersionId },
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe(sentinel);
  } else if (phase !== "verify") {
    throw new Error(`Unsupported upgrade acceptance phase: ${phase}`);
  }

  const suites = await browserJson<{
    items: Array<{
      id: string;
      name: string;
      projectId: string;
      policy: { projectVersionId?: string };
    }>;
  }>(page, "/api/v1/case-suites?limit=200");
  expect(suites.status).toBe(200);
  const persistedSuite = suites.body.items.find((suite) => suite.name === sentinel);
  expect(persistedSuite).toBeDefined();
  if (!persistedSuite) {
    throw new Error("The release upgrade sentinel was not restored.");
  }
  const projectVersionId = persistedSuite.policy.projectVersionId;
  if (projectVersionId) {
    await selectProjectContext(page, persistedSuite.projectId, projectVersionId);
    await page.goto("/case-suites");
    await expect(page.getByRole("link", { name: sentinel })).toBeVisible();
  } else {
    // v0.9.10 accepts the policy input but does not persist its version field.
    // v0.9.11 intentionally excludes those legacy tasks from version-scoped
    // lists while keeping their details readable for audit and manual repair.
    await page.goto(`/case-suites/${encodeURIComponent(persistedSuite.id)}`);
    await expect(page.getByRole("heading", { name: sentinel })).toBeVisible();
  }
});

async function ensureDefaultProjectVersion(page: Page): Promise<string> {
  const structure = await browserJson<{
    versions: Array<{ id: string; status: "active" | "archived" }>;
  }>(page, `/api/v1/projects/${encodeURIComponent(DEFAULT_PROJECT_ID)}/structure`);
  expect(structure.status).toBe(200);
  const activeVersion = structure.body.versions.find((version) => version.status === "active");
  if (activeVersion) return activeVersion.id;

  const created = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${encodeURIComponent(DEFAULT_PROJECT_ID)}/versions`,
    { method: "POST", body: { name: "Release upgrade version" } },
  );
  expect(created.status).toBe(201);
  return created.body.id;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for release upgrade acceptance.`);
  return value;
}
