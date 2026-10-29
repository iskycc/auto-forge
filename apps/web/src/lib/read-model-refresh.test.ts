import { describe, expect, it, vi } from "vitest";
import { requestReadModelRefresh } from "./read-model-refresh";

describe("explicit read-model retry", () => {
  it("requests a new background build rather than only rereading the failed snapshot", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ requested: true }));
    const signal = new AbortController().signal;
    await requestReadModelRefresh(["snapshot"], signal, send);
    expect(send).toHaveBeenCalledExactlyOnceWith("/api/v1/read-models/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: ["snapshot"] }),
      signal,
    });
  });
  it("keeps a rejected retry visible to the caller", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
    await expect(
      requestReadModelRefresh(["snapshot"], new AbortController().signal, send),
    ).rejects.toThrow("请求更新失败");
  });
});
