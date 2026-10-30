import { describe, expect, it } from "vitest";
import {
  createLogArchiveSchema,
  removeLogArchiveCopySchema,
  createLogArchiveDownloadLinksSchema,
} from "../src/log-archives";

describe("archive volume and download confirmation input", () => {
  it("bounds selected download links and rejects empty, duplicate and invalid IDs", () => {
    const id = "019a25a1-0000-7000-8000-000000000001";
    expect(createLogArchiveDownloadLinksSchema.parse({ archiveIds: [id] }).archiveIds).toEqual([
      id,
    ]);
    for (const archiveIds of [
      [],
      [id, id],
      ["invalid"],
      Array.from(
        { length: 51 },
        (_, i) => `019a25a1-0000-7000-8000-${String(i).padStart(12, "0")}`,
      ),
    ])
      expect(createLogArchiveDownloadLinksSchema.safeParse({ archiveIds }).success).toBe(false);
  });
  it("uses bounded volumes and disk reserves without changing old create requests", () => {
    expect(createLogArchiveSchema.parse({ month: "2026-10" })).toMatchObject({
      month: "2026-10",
      targetVolumeMiB: 1024,
      minimumFreeMiB: 1024,
      minimumFreePercent: 10,
    });
    expect(createLogArchiveSchema.safeParse({ month: "2026-10", targetVolumeMiB: 0 }).success).toBe(
      false,
    );
    expect(
      createLogArchiveSchema.safeParse({ month: "2026-10", minimumFreePercent: 0 }).success,
    ).toBe(false);
  });
  it("requires explicit downloaded and verified acknowledgement for the exact archive checksum", () => {
    expect(removeLogArchiveCopySchema.safeParse({ confirm: true }).success).toBe(false);
    expect(
      removeLogArchiveCopySchema.safeParse({ downloadedAndVerified: false, sha256: "a".repeat(64) })
        .success,
    ).toBe(false);
    expect(
      removeLogArchiveCopySchema.parse({ downloadedAndVerified: true, sha256: "a".repeat(64) })
        .sha256,
    ).toBe("a".repeat(64));
  });
});
