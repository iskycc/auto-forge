import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

import { ddtApiExample } from "./ddt-api-examples";

describe("DDT JavaScript calling example", () => {
  const base = "http://platform.test/api/v1/public/ddt/projects/p/versions/v/stages/s";
  const caseId = "支付'\" ${globalThis.unexpected = true} \\ /%2F?#+&";

  function execute(response: Response) {
    const fetch = vi.fn().mockResolvedValue(response);
    const result = runInNewContext(
      `(async () => { ${ddtApiExample("javascript", base, caseId)}; return caseData; })()`,
      { fetch, URL, AbortSignal },
    ) as Promise<unknown>;
    return { result, fetch };
  }

  it("encodes a literal CaseID and reads the raw response without browser credentials", async () => {
    const payload = { CaseID: caseId, count: 3, enabled: false, note: null };
    const { result, fetch } = execute(Response.json(payload));
    await expect(result).resolves.toEqual(payload);
    const [url, options] = fetch.mock.calls[0]!;
    expect((url as URL).pathname).toBe(new URL(base).pathname + "/case");
    expect((url as URL).searchParams.get("caseId")).toBe(caseId);
    expect(options).toMatchObject({ credentials: "omit", cache: "no-store" });
    expect((options as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("returns null only for a missing case", async () => {
    await expect(execute(Response.json({ error: {} }, { status: 404 })).result).resolves.toBeNull();
  });

  it.each([400, 503, 500])(
    "rejects HTTP %i instead of treating it as a missing case",
    async (status) => {
      await expect(execute(Response.json({ error: {} }, { status })).result).rejects.toThrow(
        `DDT HTTP ${status}`,
      );
    },
  );
});
