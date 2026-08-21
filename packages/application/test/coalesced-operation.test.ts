import { CoalescedOperation } from "../src/coalesced-operation";
import { describe, expect, it, vi } from "vitest";

describe("CoalescedOperation", () => {
  it("turns any requests during the leading pass into one trailing pass", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = vi
      .fn<() => Promise<number>>()
      .mockImplementationOnce(async () => {
        await gate;
        return 1;
      })
      .mockResolvedValue(2);
    const coalesced = new CoalescedOperation(operation);

    const results = Array.from({ length: 100 }, () => coalesced.requestAnotherPass());
    expect(operation).toHaveBeenCalledOnce();
    release();

    await expect(Promise.all([coalesced.result, ...results])).resolves.toEqual(
      Array.from({ length: 101 }, () => 2),
    );
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
