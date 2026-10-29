import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { logArchiveViewerResourceSchema as resourceSchema } from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import type {
  JarObjectStorePort,
  LogArchiveRepository,
  LogArchiveRecord,
  Clock,
  IdGenerator,
} from "@autoforge/application";
import type { LogArchiveManifest, LogArchiveBatch } from "@autoforge/contracts";
import type { AttemptLogStore, AsyncAttemptLogStore } from "./attempt-log-store";
import { writeBatchArchive } from "./log-archive-format";
import {
  archiveDiskBudget,
  assertArchiveDiskBudget,
  estimateArchiveTemporaryBytes,
} from "./log-archive-disk-budget";

export class LogArchiveWorker {
  private readonly owner = randomUUID();
  constructor(
    private readonly dependencies: {
      repository: LogArchiveRepository;
      logs: AttemptLogStore | AsyncAttemptLogStore;
      objects: JarObjectStorePort;
      dataDirectory: string;
      viewerResourcesDirectory: string;
      clock: Clock;
      ids: IdGenerator;
      backgroundAllowed(): boolean;
      diskSpace?(): Promise<{ totalBytes: number; availableBytes: number }>;
    },
  ) {}
  async run(signal: AbortSignal): Promise<boolean> {
    const dependencies = this.dependencies;
    const now = () => dependencies.clock.now().toISOString();
    const expiry = () => new Date(dependencies.clock.now().getTime() + 90000).toISOString();
    const job = await dependencies.repository.claim(this.owner, now(), expiry());
    if (!job) return false;
    const removingCopy = ["delete_requested", "deleting"].includes(job.copyState ?? "");
    let renewal = Date.now();
    let polling = 0;
    let lastDiskCheck = 0;
    const checkpoint = async () => {
      signal.throwIfAborted();
      if (Date.now() - renewal > 15000) {
        if (!(await dependencies.repository.renew(this.owner, now(), expiry())))
          throw new DomainError("LOG_ARCHIVE_LEASE_LOST", "归档租约已失效，停止当前工作。");
        renewal = Date.now();
      }
      if (Date.now() - polling > 1000) {
        const current = await dependencies.repository.find(job.id);
        if (current.cancelRequested && current.status !== "cleaning")
          throw new DomainError("LOG_ARCHIVE_CANCELLED", "日志归档已取消，原日志保留。");
        polling = Date.now();
      }
      if (
        ["queued", "building", "verifying"].includes(job.status) &&
        !removingCopy &&
        Date.now() - lastDiskCheck > 1000
      ) {
        assertArchiveDiskBudget(await this.diskBudget(job), 0);
        lastDiskCheck = Date.now();
      }
      while (!dependencies.backgroundAllowed()) {
        await delay(250, undefined, { signal });
        if (Date.now() - renewal > 15000) {
          if (!(await dependencies.repository.renew(this.owner, now(), expiry())))
            throw new DomainError("LOG_ARCHIVE_LEASE_LOST", "归档工作租约已失效。");
          renewal = Date.now();
        }
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    };
    try {
      await checkpoint();
      if (removingCopy) await this.removeCopy(job, checkpoint);
      else if (["ready", "completed"].includes(job.status) && job.nextVolumePending)
        await dependencies.repository.enqueueNextVolume(
          job.id,
          this.owner,
          dependencies.ids.next(),
          now(),
        );
      else if (job.status === "cleaning") await this.cleanup(job, checkpoint);
      else await this.build(job, checkpoint, signal);
      const published = await dependencies.repository.find(job.id);
      if (
        published.objectKey &&
        published.nextVolumePending &&
        ["ready", "cleaning", "completed"].includes(published.status)
      )
        await dependencies.repository.enqueueNextVolume(
          job.id,
          this.owner,
          dependencies.ids.next(),
          now(),
        );
      return true;
    } catch (cause) {
      if (removingCopy) {
        await dependencies.repository.update(
          job.id,
          this.owner,
          {
            copyState: "delete_failed",
            copyRemovalError:
              "平台归档副本删除失败，请检查对象存储连接后重试。执行记录和结果保留。",
          },
          now(),
        );
        if (!(cause instanceof DomainError))
          throw new Error(`Removing archive copy ${job.id} failed`, { cause });
        return true;
      }
      if (cause instanceof DomainError && cause.code === "LOG_ARCHIVE_CANCELLED")
        await this.discardIncompleteArtifacts(job);
      const message =
        cause instanceof DomainError
          ? cause.message
          : "归档处理失败，原日志保留；请检查数据目录空间、归档资源和日志存储连接后重试。";
      await dependencies.repository.update(
        job.id,
        this.owner,
        {
          status:
            cause instanceof DomainError && cause.code === "LOG_ARCHIVE_CANCELLED"
              ? "cancelled"
              : "failed",
          errorMessage: message,
        },
        now(),
      );
      if (!(cause instanceof DomainError))
        throw new Error(`Log archive ${job.id} failed`, { cause });
      return true;
    } finally {
      await dependencies.repository.release(this.owner);
    }
  }
  private async diskBudget(job: LogArchiveRecord) {
    const disk = this.dependencies.diskSpace
      ? await this.dependencies.diskSpace()
      : await statfs(this.dependencies.dataDirectory).then((value) => ({
          totalBytes: Number(value.blocks) * Number(value.bsize),
          availableBytes: Number(value.bavail) * Number(value.bsize),
        }));
    return archiveDiskBudget(disk, {
      minimumFreeMiB: job.minimumFreeMiB ?? 1024,
      minimumFreePercent: job.minimumFreePercent ?? 10,
    });
  }
  private async removeCopy(job: LogArchiveRecord, checkpoint: () => Promise<void>): Promise<void> {
    if (!job.objectKey || job.status !== "completed")
      throw new DomainError("LOG_ARCHIVE_NOT_READY", "归档未完成原日志清理，不能删除平台副本。");
    const { repository, objects, clock } = this.dependencies;
    await repository.update(
      job.id,
      this.owner,
      { copyState: "deleting" },
      clock.now().toISOString(),
    );
    for (const key of [job.objectKey, `${job.objectKey}.index.json`]) {
      await checkpoint();
      await objects.delete(key);
    }
    await repository.update(
      job.id,
      this.owner,
      { copyState: "deleted", copyDeletedAt: clock.now().toISOString() },
      clock.now().toISOString(),
    );
  }
  private async build(job: LogArchiveRecord, checkpoint: () => Promise<void>, signal: AbortSignal) {
    const dependencies = this.dependencies;
    const now = () => dependencies.clock.now().toISOString();
    await this.discardIncompleteArtifacts(job);
    const workspace = await mkdtemp(
      join(dependencies.dataDirectory, "archive-staging", `${job.id}-`),
    );
    const directory = join(workspace, "content");
    await mkdir(directory, { mode: 0o700 });
    try {
      const resources = resourceSchema.parse(
        JSON.parse(
          await readFile(join(dependencies.viewerResourcesDirectory, "manifest.json"), "utf8"),
        ),
      );
      for (const resource of [...resources.files, resources.license]) {
        const path = join(dependencies.viewerResourcesDirectory, resource.path);
        const metadata = await hashFile(path);
        if (metadata.sizeBytes !== resource.sizeBytes || metadata.sha256 !== resource.sha256)
          throw new DomainError(
            "LOG_ARCHIVE_VIEWER_INVALID",
            "内置离线查看器校验失败，请安装完整的主平台发布物。",
          );
      }
      const native = `viewer-linux-${process.arch === "arm64" ? "arm64" : "amd64"}`;
      const executable = join(dependencies.viewerResourcesDirectory, native);
      await writeFile(
        join(directory, "使用说明.txt"),
        "AutoForge 月度日志归档\n\n请完整解压压缩包。Windows 双击 viewer-windows-amd64.exe；Linux 为对应架构的 viewer-linux-amd64 或 viewer-linux-arm64 添加执行权限后运行。程序自动打开本机浏览器，只监听 127.0.0.1，不访问公网，无需安装 Go、Node 或数据库。关闭程序即可停止。\n\n可传 --no-browser 只显示地址，或 --verify <zip文件> 校验归档。归档含执行日志，请妥善保管。每个分卷均可独立查看完整执行批次。平台归档副本保留期间原公开日志链接可读取；管理员确认下载并移除平台副本后，请在本地查看，平台仅保留执行结果与轮次。\n",
        { mode: 0o600 },
      );
      const total = await dependencies.repository.reserveBatches(
        job,
        this.owner,
        now(),
        checkpoint,
        job.groupId
          ? {
              maximumSourceBytes: (job.targetVolumeMiB ?? 1024) * 1024 ** 2,
              sizes: async (ids) => new Map(await dependencies.logs.batchStoreStats(ids)),
            }
          : undefined,
      );
      if (!total)
        throw new DomainError(
          "LOG_ARCHIVE_EMPTY",
          "所选月份没有可归档的已结束批次；运行中、存在有效上传租约或已被其他归档收录的批次会保留。",
        );
      await dependencies.repository.update(
        job.id,
        this.owner,
        { status: "building", totalBatches: total, processedBatches: 0 },
        now(),
      );
      let plannedSourceBytes = 0,
        budgetCursor = "";
      for (;;) {
        const page = await dependencies.repository.batches(job.id, budgetCursor);
        const sizes = await dependencies.logs.batchStoreStats(page.map((batch) => batch.id));
        for (const batch of page) {
          plannedSourceBytes += sizes.get(batch.id) ?? 0;
          budgetCursor = batch.id;
        }
        await checkpoint();
        if (page.length < 100) break;
      }
      const estimate = estimateArchiveTemporaryBytes({
        sourceBytes: plannedSourceBytes,
        attemptCount: await dependencies.repository.attemptCount(job.id),
        viewerBytes: [...resources.files, resources.license].reduce(
          (total, file) => total + file.sizeBytes,
          0,
        ),
      });
      const budget = await this.diskBudget(job);
      await dependencies.repository.update(
        job.id,
        this.owner,
        { estimatedTemporaryBytes: estimate, diskReservedBytes: budget.reservedBytes },
        now(),
      );
      assertArchiveDiskBudget(budget, estimate);
      for (const resource of [...resources.files, resources.license]) {
        await checkpoint();
        await copyFile(
          join(dependencies.viewerResourcesDirectory, resource.path),
          join(directory, resource.path),
        );
      }
      const batches: LogArchiveBatch[] = [];
      let attempts = 0,
        chunks = 0,
        rawBytes = 0,
        sourceBytes = 0;
      let cursor = "";
      for (;;) {
        const page = await dependencies.repository.batches(job.id, cursor);
        for (const batch of page) {
          await checkpoint();
          sourceBytes += (await dependencies.logs.batchStoreStats([batch.id])).get(batch.id) ?? 0;
          const counts = await writeBatchArchive({
            directory: join(directory, "batches", batch.id),
            batchId: batch.id,
            repository: dependencies.repository,
            logs: dependencies.logs,
            checkpoint,
          });
          attempts += counts.attemptCount;
          chunks += counts.chunkCount;
          rawBytes += counts.rawBytes;
          batches.push(batch);
          cursor = batch.id;
          await dependencies.repository.batchState(job.id, batch.id, "exported", this.owner, now());
          await dependencies.repository.update(
            job.id,
            this.owner,
            {
              processedBatches: batches.length,
              attemptCount: attempts,
              chunkCount: chunks,
              sourceBytes,
            },
            now(),
          );
        }
        if (page.length < 100) break;
      }
      if (batches.length !== total)
        throw new Error("Reserved archive batches changed during export.");
      const files: LogArchiveManifest["files"] = [];
      async function inventory(relative = ""): Promise<void> {
        for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
          const path = relative ? `${relative}/${entry.name}` : entry.name;
          if (entry.isDirectory()) await inventory(path);
          else if (entry.isFile()) files.push({ path, ...(await hashFile(join(directory, path))) });
          else throw new Error("Archive staging contains a non-regular file.");
        }
      }
      await inventory();
      const manifest: LogArchiveManifest = {
        format: "autoforge-log-archive",
        schemaVersion: 1,
        id: job.id,
        month: job.month,
        timeZone: "Asia/Shanghai",
        createdAt: now(),
        platformVersion: resources.version,
        ...(job.groupId ? { groupId: job.groupId, volumeNumber: job.volumeNumber ?? 1 } : {}),
        ...(job.sourceCutoffAt ? { sourceCutoffAt: job.sourceCutoffAt } : {}),
        batchCount: batches.length,
        attemptCount: attempts,
        chunkCount: chunks,
        rawBytes,
        batches,
        files,
      };
      await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
      await dependencies.repository.update(job.id, this.owner, { status: "verifying" }, now());
      const zipPath = join(workspace, "archive.zip"),
        indexPath = join(workspace, "archive.index.json");
      await runViewer(
        executable,
        ["--pack", directory, "--output", zipPath, "--index", indexPath],
        checkpoint,
        signal,
        join(workspace, ".worker-alive"),
      );
      await checkpoint();
      const zip = await hashFile(zipPath, checkpoint),
        index = await hashFile(indexPath, checkpoint);
      const objectKey = `log-archives/${job.month}/${job.id}/${zip.sha256}.zip`;
      await uploadVerified(
        dependencies.objects,
        objectKey,
        zipPath,
        zip,
        "application/zip",
        checkpoint,
      );
      await uploadVerified(
        dependencies.objects,
        `${objectKey}.index.json`,
        indexPath,
        index,
        "application/json",
        checkpoint,
      );
      for (const batch of batches)
        await dependencies.repository.batchState(job.id, batch.id, "verified", this.owner, now());
      await dependencies.repository.update(
        job.id,
        this.owner,
        {
          status: "ready",
          objectKey,
          indexSha256: index.sha256,
          filename: `AutoForge_执行日志归档_${job.month.replace("-", "")}${job.groupId ? `_第${String(job.volumeNumber ?? 1).padStart(4, "0")}卷` : ""}_${job.id.slice(-8)}.zip`,
          sha256: zip.sha256,
          archiveBytes: zip.sizeBytes,
        },
        now(),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }
  private async discardIncompleteArtifacts(job: LogArchiveRecord): Promise<void> {
    const dependencies = this.dependencies;
    if ((await dependencies.repository.find(job.id)).objectKey) return;
    const guard = async () => {
      const now = dependencies.clock.now();
      if (
        !(await dependencies.repository.renew(
          this.owner,
          now.toISOString(),
          new Date(now.getTime() + 90000).toISOString(),
        ))
      )
        throw new DomainError("LOG_ARCHIVE_LEASE_LOST", "归档清理租约已失效，保留待恢复文件。");
    };
    const staging = join(dependencies.dataDirectory, "archive-staging");
    await mkdir(staging, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(staging, { withFileTypes: true })) {
      if (!entry.name.startsWith(`${job.id}-`) || !entry.isDirectory()) continue;
      await guard();
      await rm(join(staging, entry.name), { recursive: true, force: true });
    }
    for (;;) {
      await guard();
      const page = await dependencies.objects.list({
        prefix: `log-archives/${job.month}/${job.id}/`,
        limit: 50,
      });
      if (!page.items.length) break;
      for (const entry of page.items) {
        await guard();
        await dependencies.objects.delete(entry.objectKey);
      }
    }
  }
  private async cleanup(job: LogArchiveRecord, checkpoint: () => Promise<void>) {
    const dependencies = this.dependencies;
    let cleaned = job.cleanedBatches,
      reclaimed = job.reclaimedBytes;
    // Recheck persisted objects before the first destructive operation, including after a restart.
    for (const [key, expected] of [
      [job.objectKey, job.sha256],
      [job.objectKey ? `${job.objectKey}.index.json` : undefined, job.indexSha256],
    ]) {
      if (!key || !expected)
        throw new DomainError("LOG_ARCHIVE_UNAVAILABLE", "归档文件或索引不存在，停止清理原日志。");
      const stored = await dependencies.objects.openRead(key);
      const digest = createHash("sha256");
      for await (const chunk of stored.content) {
        digest.update(chunk);
        await checkpoint();
      }
      if (digest.digest("hex") !== expected)
        throw new DomainError(
          "LOG_ARCHIVE_UNAVAILABLE",
          "归档文件或索引校验失败，停止清理原日志。",
        );
    }
    for (;;) {
      const batches = await dependencies.repository.cleanupBatches(job.id);
      if (!batches.length) break;
      for (const batchId of batches) {
        await checkpoint();
        await dependencies.repository.batchState(
          job.id,
          batchId,
          "cleaning",
          this.owner,
          dependencies.clock.now().toISOString(),
        );
        const before = (await dependencies.logs.batchStoreStats([batchId])).get(batchId) ?? 0;
        if (
          "removeBatchPayload" in dependencies.logs &&
          typeof dependencies.logs.removeBatchPayload === "function"
        )
          await dependencies.logs.removeBatchPayload(batchId, { checkpoint });
        else await dependencies.logs.removeBatchStore(batchId);
        const after = (await dependencies.logs.batchStoreStats([batchId])).get(batchId) ?? 0;
        await dependencies.repository.batchState(
          job.id,
          batchId,
          "cleaned",
          this.owner,
          dependencies.clock.now().toISOString(),
        );
        cleaned++;
        if (!("reclaimUnusedDatabases" in dependencies.logs))
          reclaimed += Math.max(0, before - after);
        await dependencies.repository.update(
          job.id,
          this.owner,
          { cleanedBatches: cleaned, reclaimedBytes: reclaimed },
          dependencies.clock.now().toISOString(),
        );
      }
    }
    if (
      "reclaimUnusedDatabases" in dependencies.logs &&
      typeof dependencies.logs.reclaimUnusedDatabases === "function"
    ) {
      reclaimed += Number(
        await dependencies.logs.reclaimUnusedDatabases(dependencies.clock.now().toISOString()),
      );
      await dependencies.repository.update(
        job.id,
        this.owner,
        { reclaimedBytes: reclaimed },
        dependencies.clock.now().toISOString(),
      );
    }
    await dependencies.repository.update(
      job.id,
      this.owner,
      { status: "completed", cleanedBatches: job.totalBatches },
      dependencies.clock.now().toISOString(),
    );
  }
}
async function hashFile(path: string, checkpoint?: () => Promise<void>) {
  const digest = createHash("sha256");
  const metadata = await stat(path);
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk);
    await checkpoint?.();
  }
  return { sizeBytes: metadata.size, sha256: digest.digest("hex") };
}
async function uploadVerified(
  objects: JarObjectStorePort,
  objectKey: string,
  path: string,
  file: { sha256: string; sizeBytes: number },
  mediaType: string,
  checkpoint: () => Promise<void>,
) {
  await objects.putObject({
    objectKey,
    ...file,
    mediaType,
    content: (async function* () {
      for await (const chunk of createReadStream(path)) {
        await checkpoint();
        yield chunk;
      }
    })(),
  });
  const stored = await objects.openRead(objectKey);
  if (stored.sizeBytes !== file.sizeBytes) throw new Error("Stored archive size mismatch.");
  const digest = createHash("sha256");
  for await (const chunk of stored.content) {
    digest.update(chunk);
    await checkpoint();
  }
  if (digest.digest("hex") !== file.sha256) throw new Error("Stored archive checksum mismatch.");
}
async function runViewer(
  executable: string,
  args: string[],
  checkpoint: () => Promise<void>,
  signal: AbortSignal,
  leasePath: string,
) {
  await writeFile(leasePath, "alive", { mode: 0o600 });
  const child = spawn(
    executable,
    ["--worker-lease", leasePath, "--worker-parent", String(process.pid), ...args],
    {
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
      env: { NODE_ENV: "production", GOMAXPROCS: "1" },
      signal,
    },
  );
  let failure = "";
  child.stderr.on("data", (chunk: Buffer) => {
    if (failure.length < 4096) failure += chunk.toString("utf8").slice(0, 4096 - failure.length);
  });
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            new DomainError(
              "LOG_ARCHIVE_VERIFICATION_FAILED",
              `归档完整性校验失败（退出码 ${code}）：${failure.trim().slice(0, 1000)}`,
            ),
          ),
    );
  });
  let complete = false;
  let childFailure: unknown;
  const observed = done.then(
    () => {
      complete = true;
    },
    (cause) => {
      complete = true;
      childFailure = cause;
    },
  );
  try {
    while (!complete) {
      await Promise.race([observed, delay(1000, undefined, { signal })]);
      if (!complete) {
        await checkpoint();
        await writeFile(leasePath, "alive", { mode: 0o600 });
      }
    }
    if (childFailure) throw childFailure;
  } catch (cause) {
    child.kill("SIGTERM");
    await observed;
    throw cause;
  }
}
