import { expect, test } from "@playwright/test";
import { browserJson, ensureAdministrator, uniqueName } from "./support/session";
import { expectUiIntegrity } from "./support/ui-guard";
test("service credentials can be permanently removed after revocation with audit history preserved", async ({
  page,
}, testInfo) => {
  await ensureAdministrator(page);
  const name = uniqueName("删除账号与密钥验证");
  const created = await browserJson<{ id: string; revision: number }>(
    page,
    "/api/v1/service-accounts",
    {
      method: "POST",
      body: { name, description: "保留执行及审计历史", systemPermissions: ["run.read"] },
    },
  );
  expect(created.status).toBe(201);
  const id = created.body.id;
  const issued = await browserJson<{ id: string; token: string }>(
    page,
    `/api/v1/service-accounts/${id}/tokens`,
    {
      method: "POST",
      body: {
        name: "待撤销密钥",
        scopes: ["run.read"],
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      },
    },
  );
  expect(issued.status).toBe(201);
  expect(
    (await browserJson(page, `/api/v1/api-tokens/${issued.body.id}`, { method: "DELETE" })).status,
  ).toBe(409);
  await page.goto(`/settings/platform?section=accounts&query=${encodeURIComponent(name)}`);
  const account = page.getByRole("article").filter({ hasText: name });
  await account.getByRole("button", { name: "令牌", exact: true }).click();
  await expect(account.getByText("待撤销密钥", { exact: false })).toBeVisible();
  await expect(
    account.getByRole("button", { name: "删除令牌 待撤销密钥", exact: true }),
  ).toHaveCount(0);
  await account.getByRole("button", { name: "撤销 待撤销密钥", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "确认撤销", exact: true }).click();
  await expect(account.getByText("已撤销", { exact: true })).toBeVisible();
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: 960 });
    await expectUiIntegrity(page);
    await page.screenshot({
      path: testInfo.outputPath(`credentials-${width}.png`),
      fullPage: true,
    });
  }
  await account.getByRole("button", { name: "删除令牌 待撤销密钥", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(account.getByText("待撤销密钥", { exact: false })).toHaveCount(0);
  await account.getByRole("button", { name: `删除服务账号 ${name}`, exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();
  await expect(account).toBeVisible();
  await account.getByRole("button", { name: `删除服务账号 ${name}`, exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(account).toHaveCount(0);
  const auth = await page.request.get("/api/v1/service-accounts", {
    headers: { authorization: `Bearer ${issued.body.token}` },
  });
  expect(auth.status()).toBe(401);
  expect((await browserJson(page, `/api/v1/service-accounts/${id}/tokens`)).body).toMatchObject({
    items: [],
  });
});
