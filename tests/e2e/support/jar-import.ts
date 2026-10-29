import { expect, type Page } from "@playwright/test";

export interface JarFilePayload {
  name: string;
  mimeType: "application/java-archive";
  buffer: Buffer;
}

export function jarImportFileInput(page: Page) {
  return page.locator('.file-dropzone:visible input[type="file"]');
}

export async function selectJarForInspection(
  page: Page,
  payload: JarFilePayload | string,
): Promise<void> {
  const fileInput = jarImportFileInput(page);
  const inspectButton = page.getByRole("button", { name: "扫描测试类" });

  // setInputFiles bypasses disabled inputs; React must have attached its change handler.
  await expect(fileInput).toBeEnabled();
  await expect(async () => {
    await fileInput.setInputFiles([]);
    await fileInput.setInputFiles(payload);
    await expect(inspectButton).toBeEnabled({ timeout: 1_000 });
  }).toPass({ intervals: [100, 250, 500, 1_000], timeout: 15_000 });
}
