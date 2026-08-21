import { expect, type Page } from "@playwright/test";

export interface JarFilePayload {
  name: string;
  mimeType: "application/java-archive";
  buffer: Buffer;
}

export async function selectJarForInspection(page: Page, payload: JarFilePayload): Promise<void> {
  const fileInput = page.locator('input[type="file"]');
  const inspectButton = page.getByRole("button", { name: "扫描测试类" });

  await expect(async () => {
    await fileInput.setInputFiles([]);
    await fileInput.setInputFiles(payload);
    await expect(inspectButton).toBeEnabled({ timeout: 1_000 });
  }).toPass({ intervals: [100, 250, 500, 1_000], timeout: 15_000 });
}
