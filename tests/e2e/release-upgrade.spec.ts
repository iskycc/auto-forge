import { expect, test } from "@playwright/test";

import { browserJson, ensureAdministrator } from "./support/session";

test("persists a business sentinel across release migration and rollback", async ({ page }) => {
  await ensureAdministrator(page);
  const sentinel = requiredEnvironment("E2E_UPGRADE_SENTINEL");
  const phase = requiredEnvironment("E2E_UPGRADE_PHASE");

  if (phase === "seed") {
    const created = await browserJson<{ id: string; name: string }>(page, "/api/v1/case-suites", {
      method: "POST",
      body: {
        name: sentinel,
        description: "Immutable release upgrade and rollback sentinel",
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe(sentinel);
  } else if (phase !== "verify") {
    throw new Error(`Unsupported upgrade acceptance phase: ${phase}`);
  }

  const suites = await browserJson<{ items: Array<{ name: string }> }>(
    page,
    "/api/v1/case-suites?limit=200",
  );
  expect(suites.status).toBe(200);
  expect(suites.body.items.map((suite) => suite.name)).toContain(sentinel);
  await page.goto("/case-suites");
  await expect(page.getByRole("link", { name: sentinel })).toBeVisible();
});

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for release upgrade acceptance.`);
  return value;
}
