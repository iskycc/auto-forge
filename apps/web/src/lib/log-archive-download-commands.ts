import type { LogArchiveDownloadLink, LogArchiveJob } from "@autoforge/contracts";

export type ArchiveDownloadFormat = "wget" | "curl" | "links";
export function archiveDownloadCommands(
  items: readonly LogArchiveDownloadLink[],
  format: ArchiveDownloadFormat,
): string {
  return items
    .map((item) => {
      if (format === "links") return item.url;
      const filename = quote(`./${item.filename.replace(/[/\\\u0000-\u001f]/g, "_")}`);
      const url = quote(item.url);
      return format === "curl"
        ? `curl --fail --location --retry 2 --output ${filename} -- ${url}`
        : `wget --tries=3 --no-verbose --output-document=${filename} -- ${url}`;
    })
    .join("\n");
}
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
export function archiveDownloadAvailable(job: LogArchiveJob): boolean {
  return Boolean(job.sha256 && job.filename && (!job.copyState || job.copyState === "retained"));
}
export function archiveCopyRemovalBlocker(job: LogArchiveJob): string | undefined {
  if (job.status !== "completed") return "请先完成“清理原日志”，再删除平台归档副本。";
  if (!job.downloadedAt && job.copyState !== "delete_failed")
    return "请先使用当前账号完整下载本卷，并确认离线查看正常。";
  return undefined;
}
