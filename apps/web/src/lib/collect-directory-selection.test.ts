import { afterEach, describe, expect, it, vi } from "vitest";
import { collectDirectorySelection } from "./collect-directory-selection";

const id = "a".repeat(64);
const status = {
  id,
  generation: "00000000-0000-4000-8000-000000000001",
  generatedAt: "2026-09-06T00:00:00.000Z",
  state: "ready",
};
function fetcher(conflict = false) {
  return vi.fn<typeof fetch>(async (url) => {
    const request = String(url);
    if (request.includes("/directory?"))
      return Response.json({ status, manifest: { caseCount: 2, partCount: 2 } });
    const second = request.includes("ordinal=1");
    if (second && conflict)
      return Response.json(
        {
          error: {
            code: "READ_MODEL_GENERATION_CONFLICT",
            message: "数据已更新",
            requestId: "request",
          },
        },
        { status: 409 },
      );
    const name = second ? "Second" : "First";
    return Response.json({
      items: [
        {
          id: name,
          projectId: "project",
          directoryPath: "example",
          displayName: name,
          className: `example.${name}`,
        },
      ],
      outcomes: [],
    });
  });
}
describe("explicit directory selection", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("matches imported paths outside the current window without retaining unrelated definitions", async () => {
    const request = fetcher();
    vi.stubGlobal("fetch", request);
    const result = await collectDirectorySelection({
      baseId: id,
      filters: "",
      paths: ["example/Second"],
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });
    expect(result.items.map((item) => item.id)).toEqual(["Second"]);
    expect(request.mock.calls.filter(([url]) => String(url).includes("selection=1"))).toHaveLength(
      2,
    );
  });
  it("rejects a changed generation instead of returning a partial selection", async () => {
    vi.stubGlobal("fetch", fetcher(true));
    await expect(
      collectDirectorySelection({
        baseId: id,
        filters: "",
        signal: new AbortController().signal,
        onProgress: () => undefined,
      }),
    ).rejects.toThrow("数据已更新");
  });
  it("stops reading subsequent windows after the user cancels matching", async () => {
    const request = fetcher();
    const controller = new AbortController();
    vi.stubGlobal("fetch", request);
    await expect(
      collectDirectorySelection({
        baseId: id,
        filters: "",
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
