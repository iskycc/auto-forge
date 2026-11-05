import { expect, type Page } from "@playwright/test";

export async function openExecutionCaseDetails(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "用例执行明细", exact: true });
  if (!(await dialog.isVisible()))
    await page.getByRole("button", { name: "查看用例明细", exact: true }).click();
  await expect(dialog).toBeVisible();
}

export async function closeExecutionCaseDetails(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "用例执行明细", exact: true });
  if (!(await dialog.isVisible())) return;
  await dialog.getByRole("button", { name: "关闭明细", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

/** Older scenarios select the page's round; explicitly leave the workspace first. */
export async function selectExecutionRound(page: Page, label: string): Promise<void> {
  await closeExecutionCaseDetails(page);
  await page.getByRole("button", { name: label, exact: true }).click();
  await openExecutionCaseDetails(page);
}
