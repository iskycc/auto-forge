import { describe, expect, it, vi } from "vitest";
import { boundedDetailResponse } from "./bounded-detail-response";

describe("legacy detail response bounds", () => {
  it("rejects oversized aggregates before loading their complete member collections", async () => {
    const load = vi.fn();
    await expect(
      boundedDetailResponse({
        summary: { id: "batch" },
        memberCount: 100_000,
        load,
        view: "full",
        pageUrl: "/api/v1/run-batches/batch/cases",
      }),
    ).rejects.toMatchObject({ code: "DETAIL_RESPONSE_TOO_LARGE" });
    expect(load).not.toHaveBeenCalled();
  });
  it("keeps the existing small detail shape and provides a summary for any aggregate size", async () => {
    const load = vi.fn(async () => ({ id: "suite", items: [{ id: "member" }] }));
    const input = { summary: { id: "suite" }, memberCount: 1, load, pageUrl: "/members" };
    expect(await (await boundedDetailResponse({ ...input, view: "full" })).json()).toEqual({
      id: "suite",
      items: [{ id: "member" }],
    });
    load.mockClear();
    expect(
      await (
        await boundedDetailResponse({ ...input, memberCount: 100_000, view: "summary" })
      ).json(),
    ).toEqual({ id: "suite" });
    expect(load).not.toHaveBeenCalled();
  });
  it("also limits serialized bytes when a small aggregate contains large nested fields", async () => {
    await expect(
      boundedDetailResponse({
        summary: {},
        memberCount: 1,
        view: "full",
        pageUrl: "/members",
        load: async () => ({ text: "x".repeat(2 * 1024 * 1024) }),
      }),
    ).rejects.toMatchObject({ code: "DETAIL_RESPONSE_TOO_LARGE" });
  });
});
