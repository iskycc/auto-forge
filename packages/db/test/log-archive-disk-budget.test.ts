import { describe, expect, it } from "vitest";
import {
  archiveDiskBudget,
  assertArchiveDiskBudget,
  estimateArchiveTemporaryBytes,
} from "../src/log-archive-disk-budget";
const GiB = 1024 ** 3;
describe("archive temporary storage admission", () => {
  it("reserves the larger of absolute and filesystem percentage allowances", () => {
    expect(
      archiveDiskBudget(
        { totalBytes: 100 * GiB, availableBytes: 20 * GiB },
        { minimumFreeMiB: 1024, minimumFreePercent: 10 },
      ),
    ).toEqual({ availableBytes: 20 * GiB, reservedBytes: 10 * GiB });
  });
  it("includes simultaneous staging, ZIP, local object copy and attempt metadata", () => {
    expect(
      estimateArchiveTemporaryBytes({
        sourceBytes: GiB,
        attemptCount: 200000,
        viewerBytes: 24 * 1024 ** 2,
      }),
    ).toBeGreaterThan(3 * GiB);
  });
  it("rejects insufficient initial space while retaining the operational reserve during work", () => {
    const budget = { availableBytes: 11 * GiB, reservedBytes: 10 * GiB };
    expect(() => assertArchiveDiskBudget(budget, 2 * GiB)).toThrow(/空间/);
    expect(() => assertArchiveDiskBudget(budget, 0)).not.toThrow();
    expect(() => assertArchiveDiskBudget({ ...budget, availableBytes: 9 * GiB }, 0)).toThrow(
      /空间/,
    );
  });
});
