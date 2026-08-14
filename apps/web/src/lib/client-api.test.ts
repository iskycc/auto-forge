import { describe, expect, it } from "vitest";

import { readApiErrorMessage } from "./client-api";

describe("readApiErrorMessage", () => {
  it("leaves a successful response body available to its caller", async () => {
    const response = Response.json({ id: "asset-1" });

    await expect(readApiErrorMessage(response, "保存失败。")).resolves.toBeUndefined();
    await expect(response.json()).resolves.toEqual({ id: "asset-1" });
  });
});
