import { expect, type Page } from "@playwright/test";

export async function associateDdtSr(page: Page, srNum: string, className: string): Promise<void> {
  await page.getByRole("button", { name: "SR 测试类关联", exact: true }).click();
  await expect(page.getByRole("heading", { name: "SR 测试类关联", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "配置测试类范围" }).click();
  const range = page.getByRole("dialog", { name: "测试类候选范围" });
  await range.getByLabel("搜索测试类").fill(className);
  await range.getByRole("button", { name: "搜索", exact: true }).click();
  await range.getByRole("button", { name: `加入 ${className}`, exact: true }).click();
  await expect(range.getByRole("button", { name: `移除 ${className}`, exact: true })).toBeVisible();
  await range.getByRole("button", { name: "完成", exact: true }).click();
  await page.getByRole("button", { name: `关联 ${srNum} 的测试类`, exact: true }).click();
  const mapping = page.getByRole("dialog", { name: `关联 SR ${srNum}`, exact: true });
  await mapping.getByRole("radio", { name: className, exact: true }).check();
  await mapping.getByRole("button", { name: "保存 SR 关联", exact: true }).click();
  await expect(mapping).toHaveCount(0);
  await expect(
    page.locator(".ddt-sr-row").filter({ has: page.getByText(srNum, { exact: true }) }),
  ).toContainText(className);
  await page.getByRole("link", { name: "返回 DDT 用例", exact: true }).click();
}
