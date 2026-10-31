import { describe, expect, it } from "vitest";
import { readAssociationImportProgress } from "./ddt-association-client";
const progress = { total: 2, processed: 2, changed: 1, unchanged: 1, phase: "srCategories" };
function response(text: string) {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    }),
  );
}
describe("association import streaming confirmation", () => {
  it("supports arbitrary UTF-8/chunk boundaries and requires the completed event", async () => {
    expect(
      await readAssociationImportProgress(
        response(
          JSON.stringify({ type: "progress", ...progress }) +
            "\n" +
            JSON.stringify({ type: "completed", ...progress }) +
            "\n",
        ),
        () => {},
      ),
    ).toMatchObject(progress);
  });
  it("reports failed frames and truncated connections instead of claiming success from status 200", async () => {
    await expect(
      readAssociationImportProgress(
        response(
          JSON.stringify({
            type: "failed",
            code: "DDT_ASSOCIATION_IMPORT_INTERRUPTED",
            message: "已保存 1 项，导入中断",
            processed: 1,
          }) + "\n",
        ),
        () => {},
      ),
    ).rejects.toThrow("已保存 1 项");
    await expect(
      readAssociationImportProgress(
        response(JSON.stringify({ type: "progress", ...progress }) + "\n"),
        () => {},
      ),
    ).rejects.toThrow("连接已中断");
  });
});
