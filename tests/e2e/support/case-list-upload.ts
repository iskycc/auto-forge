import type { Locator, Page } from "@playwright/test";

type CaseListUpload = { name: string; mimeType: string; buffer: Buffer };

export async function dropCaseListFiles(
  page: Page,
  target: Locator,
  files: CaseListUpload[],
): Promise<void> {
  const transfer = await page.evaluateHandle(
    (uploads) => {
      const transfer = new DataTransfer();
      for (const upload of uploads) {
        transfer.items.add(
          new File([new Uint8Array(upload.bytes)], upload.name, { type: upload.mimeType }),
        );
      }
      return transfer;
    },
    files.map(({ name, mimeType, buffer }) => ({ name, mimeType, bytes: Array.from(buffer) })),
  );
  try {
    // A real drop lands on the visible content and bubbles through Ant's upload trigger.
    const content = target.locator(".ui-file-name");
    await content.dispatchEvent("dragenter", { dataTransfer: transfer });
    await content.dispatchEvent("dragover", { dataTransfer: transfer });
    await content.dispatchEvent("drop", { dataTransfer: transfer });
  } finally {
    await transfer.dispose();
  }
}
