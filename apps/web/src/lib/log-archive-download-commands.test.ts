import { describe, expect, it } from "vitest";
import {
  archiveDownloadCommands,
  archiveCopyRemovalBlocker,
} from "./log-archive-download-commands";
import type { LogArchiveDownloadLink, LogArchiveJob } from "@autoforge/contracts";

const link: LogArchiveDownloadLink = {
  archiveId: "archive-1",
  filename: "归档 'Wallet' $(touch nope).zip",
  url: "https://platform.example/api/download?ticket=abc&v=1",
  sha256: "a".repeat(64),
  sizeBytes: 3,
};
describe("archive download commands and removal guidance", () => {
  it("copies one safely quoted command per file and direct links without shell syntax", () => {
    expect(archiveDownloadCommands([link], "curl")).toContain("curl --fail --location --retry 2");
    expect(archiveDownloadCommands([link], "wget")).toContain("wget --tries=3");
    expect(archiveDownloadCommands([link], "curl")).toContain("'\"'\"'");
    expect(archiveDownloadCommands([link, link], "links")).toBe(link.url + "\n" + link.url);
    expect(archiveDownloadCommands([link, link], "wget").split("\n")).toHaveLength(2);
  });
  it("explains why downloading alone does not yet permit deleting the platform copy", () => {
    const job = { status: "ready", downloadedAt: "2026-10-30T00:00:00Z" } as LogArchiveJob;
    expect(archiveCopyRemovalBlocker(job)).toContain("清理原日志");
    expect(archiveCopyRemovalBlocker({ ...job, status: "completed" })).toBeUndefined();
    const undownloaded = { status: "completed" } as LogArchiveJob;
    expect(archiveCopyRemovalBlocker(undownloaded)).toContain("完整下载");
    expect(
      archiveCopyRemovalBlocker({
        ...undownloaded,
        copyState: "delete_failed",
      }),
    ).toBeUndefined();
  });
});
