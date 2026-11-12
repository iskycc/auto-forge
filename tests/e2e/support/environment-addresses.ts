import { expect, type Locator, type Page } from "@playwright/test";

/** Each visible row is one address; never encode a list into a textarea. */
export async function fillEnvironmentAddressList(
  dialog: Locator,
  addresses: readonly string[],
): Promise<void> {
  const inputs = dialog.getByRole("textbox");
  const rowCount = Math.max(addresses.length, 1);
  while ((await inputs.count()) < rowCount)
    await dialog.getByRole("button", { name: "添加环境 IP", exact: true }).click();
  while ((await inputs.count()) > rowCount)
    await dialog
      .getByRole("button", { name: /^删除.+ \d+$/u })
      .last()
      .click();
  for (let index = 0; index < rowCount; index++)
    await inputs.nth(index).fill(addresses[index] ?? "");
}

export async function editEnvironmentAddresses(
  page: Page,
  scope: Locator,
  addresses: readonly string[],
): Promise<void> {
  await scope.getByRole("button", { name: "修改环境 IP", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /^修改(?:任务默认|执行)环境 IP$/u });
  await expect(dialog).toBeVisible();
  await fillEnvironmentAddressList(dialog, addresses);
  await dialog.getByRole("button", { name: /^(?:保留到任务配置|使用这些 IP)$/u }).click();
  await expect(dialog).toBeHidden();
}
