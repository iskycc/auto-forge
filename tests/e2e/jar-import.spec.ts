import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";

import { buildClassFile } from "../../packages/testng-discovery/test/class-fixture";

test("imports TestNG methods from a JAR into the case library", async ({ page }) => {
  const jar = zipSync({
    "com/example/CheckoutTest.class": buildClassFile({
      className: "com.example.CheckoutTest",
      methods: [
        {
          name: "checkout",
          annotations: [{ type: "Test", values: { groups: ["smoke", "checkout"] } }],
        },
      ],
    }),
    "testng.xml": new TextEncoder().encode('<suite name="AutoForge fixture" />'),
  });

  await page.goto("/cases/import");
  await expect(page.getByRole("heading", { name: "导入 TestNG JAR" })).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles({
    name: "checkout-tests.jar",
    mimeType: "application/java-archive",
    buffer: Buffer.from(jar),
  });
  await page.getByRole("button", { name: "扫描测试类" }).click();

  await expect(page.getByText("com.example.CheckoutTest")).toBeVisible();
  await expect(page.locator(".method-row code")).toHaveText("checkout");
  await expect(page.getByText("smoke", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(page.getByRole("status")).toContainText(/已导入|已返回现有用例/);

  await page.getByRole("link", { name: "查看用例库" }).click();
  await expect(page.getByText("com.example.CheckoutTest")).toBeVisible();
});
