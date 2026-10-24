import { createHash } from "node:crypto";
import { setImmediate as yieldTurn, setTimeout as delay } from "node:timers/promises";
import { projectVersionCopySchema, type ProjectVersionCopy } from "@autoforge/contracts";
import {
  DomainError,
  hasPermission,
  type AuthenticatedIdentity,
  type Permission,
} from "@autoforge/domain";
import type {
  Clock,
  IdGenerator,
  IdentityAccessRepository,
  JarObjectStorePort,
  SecretCipherPort,
} from "./ports";
import type {
  ProjectVersionCopyRepository,
  VersionCopyArchivePort,
  VersionCopyLogPort,
  VersionCopySnapshotReader,
  VersionCopyState,
} from "./project-version-copy-ports";
import {
  copyVersionRecord,
  versionCopyId,
  versionCopyObjectKey,
  versionCopyPrimaryKey,
} from "./project-version-copy-records";

const SOURCE_PERMISSIONS: readonly Permission[] = [
  "project.manage",
  "case.read",
  "case_source.read",
  "case_suite.manage",
  "run.read",
  "log.read",
  "artifact.read",
  "analysis.manage",
];
const TARGET_PERMISSIONS: readonly Permission[] = [
  "project.manage",
  "case.manage",
  "case_source.manage",
  "case_suite.manage",
  "analysis.manage",
];

export function canCopyProjectVersion(
  identity: AuthenticatedIdentity,
  sourceProjectId: string,
  targetProjectId: string,
): boolean {
  return (
    SOURCE_PERMISSIONS.every((permission) =>
      hasPermission(identity, permission, sourceProjectId),
    ) &&
    TARGET_PERMISSIONS.every((permission) => hasPermission(identity, permission, targetProjectId))
  );
}
export function assertVersionCopyAccess(
  identity: AuthenticatedIdentity,
  sourceProjectId: string,
  targetProjectId: string,
): void {
  if (!canCopyProjectVersion(identity, sourceProjectId, targetProjectId))
    throw new DomainError(
      "AUTH_FORBIDDEN",
      "复制版本需要来源项目的完整数据读取权限及来源、目标项目的管理权限。",
    );
}

/** Re-read roles for queued work rather than trusting a serialized browser/session permission snapshot. */
export async function authorizeVersionCopyActor(
  repository: IdentityAccessRepository,
  userId: string,
  sourceProjectId: string,
  targetProjectId: string,
): Promise<void> {
  const user = await repository.findUser(userId);
  if (!user || user.status !== "active" || user.forcePasswordChange)
    throw new DomainError("AUTH_FORBIDDEN", "复制发起人已停用或需修改密码。");
  const [system, projects] = await Promise.all([
    repository.listSystemRoleBindings([userId]),
    repository.listUserProjectRoleBindings([userId], [sourceProjectId, targetProjectId]),
  ]);
  const roles = new Map<string, Awaited<ReturnType<IdentityAccessRepository["findRole"]>>>();
  for (const id of new Set([...system, ...projects].map((binding) => binding.roleId)))
    roles.set(id, await repository.findRole(id));
  const permissions = (roleId: string): Permission[] => {
    const role = roles.get(roleId);
    return role && role.active !== false ? role.permissions : [];
  };
  const projectPermissions: Record<string, Permission[]> = {};
  for (const binding of projects)
    projectPermissions[binding.projectId] = [
      ...(projectPermissions[binding.projectId] ?? []),
      ...permissions(binding.roleId),
    ];
  assertVersionCopyAccess(
    {
      user,
      sessionId: "version-copy",
      systemPermissions: system.flatMap((binding) => permissions(binding.roleId)),
      projectPermissions,
    },
    sourceProjectId,
    targetProjectId,
  );
}

export function publicVersionCopy(state: VersionCopyState): ProjectVersionCopy {
  const { targetVersionId, ...visible } = state;
  return projectVersionCopySchema.parse({
    ...visible,
    ...(state.status === "completed" ? { targetVersionId } : {}),
  });
}

export class ProjectVersionCopyService {
  constructor(
    private readonly dependencies: {
      repository: ProjectVersionCopyRepository;
      archive: VersionCopyArchivePort;
      objects: JarObjectStorePort;
      logs: VersionCopyLogPort;
      cipher: SecretCipherPort;
      clock: Clock;
      ids: IdGenerator;
      authorize: (
        actorId: string,
        sourceProjectId: string,
        targetProjectId: string,
      ) => Promise<void>;
      invalidate: (projectId: string) => Promise<void>;
    },
  ) {}

  async execute(id: string, signal: AbortSignal): Promise<void> {
    const { repository } = this.dependencies;
    const token = this.dependencies.ids.next();
    let state = await repository.claim(id, token, this.now(), this.expiry());
    while (!state) {
      const current = await repository.get(id);
      if (!current || !["queued", "running", "cancelling"].includes(current.status)) return;
      // A crashed owner's application lease can outlive its queue lease.
      // Keep the redelivery alive until it can fence and resume that work.
      await delay(1000, undefined, { signal });
      state = await repository.claim(id, token, this.now(), this.expiry());
    }
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const heartbeat = this.heartbeat(state, token, controller).catch((cause: unknown) => {
      controller.abort(cause);
      return cause;
    });
    let snapshot: VersionCopySnapshotReader | undefined;
    let cleaning = false;
    try {
      if (state.status === "cancelling" || state.phase === "cleanup") {
        cleaning = true;
        if (state.snapshot)
          snapshot = await this.dependencies.archive.open(state.snapshot, controller.signal);
        await this.cleanup(state, snapshot, token, controller.signal);
        return;
      }
      await this.dependencies.authorize(
        state.requestedBy,
        state.sourceProjectId,
        state.targetProjectId,
      );
      if (!state.snapshot) {
        const captured = await this.dependencies.archive.capture(state, controller.signal);
        state.snapshot = captured.descriptor;
        state.totalRows = captured.manifest.rows;
        state.totalObjects = captured.manifest.objects;
        state.totalAttempts = captured.manifest.attempts;
        state.phase = "files";
        state.cursor = -1;
        state.progressPercent = 10;
        await this.save(state, token);
      }
      snapshot = await this.dependencies.archive.open(state.snapshot, controller.signal);
      if (state.phase === "files")
        await this.copyObjects(state, snapshot, token, controller.signal);
      if (state.phase === "records")
        await this.copyRecords(state, snapshot, token, controller.signal);
      if (state.phase === "logs") await this.copyLogs(state, snapshot, token, controller.signal);
      controller.signal.throwIfAborted();
      await this.dependencies.authorize(
        state.requestedBy,
        state.sourceProjectId,
        state.targetProjectId,
      );
      // Check presence again after metadata/log transfer; writes were already SHA-256 validated.
      for (let cursor = -1; ;) {
        const page = await snapshot.objects(cursor, 32);
        if (!page.length) break;
        for (const object of page)
          if (
            !(await this.dependencies.objects.exists(versionCopyObjectKey(state, object.objectKey)))
          )
            throw new DomainError(
              "VERSION_COPY_OBJECT_MISSING",
              "复制文件在最终校验前丢失，请重试。",
            );
        cursor = page.at(-1)!.ordinal;
        controller.signal.throwIfAborted();
        await yieldTurn();
      }
      state.updatedAt = this.now();
      await repository.finish(state, snapshot.manifest, token);
      await this.dependencies.invalidate(state.targetProjectId);
    } catch (cause) {
      const current = await repository.get(id);
      if (current?.leaseToken !== token) return;
      if (signal.aborted) {
        await repository.release(id, token, this.now());
        throw cause;
      }
      if (current.status === "cancelling" && !cleaning) {
        controller.abort();
        await heartbeat;
        const cleanupController = new AbortController();
        const abortCleanup = () => cleanupController.abort(signal.reason);
        signal.addEventListener("abort", abortCleanup, { once: true });
        if (signal.aborted) abortCleanup();
        const cleanupHeartbeat = this.heartbeat(current, token, cleanupController).catch(
          (cause: unknown) => {
            cleanupController.abort(cause);
          },
        );
        try {
          snapshot ??= current.snapshot
            ? await this.dependencies.archive.open(current.snapshot, cleanupController.signal)
            : undefined;
          await this.cleanup(current, snapshot, token, cleanupController.signal);
          return;
        } catch (cleanupCause) {
          if (signal.aborted) {
            await repository.release(id, token, this.now());
            throw cleanupCause;
          }
          await repository.fail(
            id,
            token,
            this.now(),
            "VERSION_COPY_CLEANUP_FAILED",
            "副本清理未完成，请重试清理。",
          );
          throw new DomainError("VERSION_COPY_CLEANUP_FAILED", "副本清理未完成，请重试清理。", {
            cause: cleanupCause,
          });
        } finally {
          cleanupController.abort();
          signal.removeEventListener("abort", abortCleanup);
          await cleanupHeartbeat;
        }
      }
      const error =
        cause instanceof DomainError
          ? cause
          : new DomainError("VERSION_COPY_FAILED", "版本复制未完成，请检查源数据和存储后重试。", {
              cause,
            });
      await repository.fail(id, token, this.now(), error.code, error.message);
      throw error;
    } finally {
      controller.abort();
      signal.removeEventListener("abort", abort);
      await heartbeat;
      await snapshot?.close();
    }
  }
  private async heartbeat(
    state: VersionCopyState,
    token: string,
    controller: AbortController,
  ): Promise<void> {
    while (!controller.signal.aborted) {
      try {
        await delay(10_000, undefined, { signal: controller.signal });
      } catch (cause) {
        if (controller.signal.aborted) return;
        throw cause;
      }
      // Release only this job's hidden resources even if its requester was revoked.
      if (state.status !== "cancelling" && state.phase !== "cleanup")
        await this.dependencies.authorize(
          state.requestedBy,
          state.sourceProjectId,
          state.targetProjectId,
        );
      if (!(await this.dependencies.repository.renew(state.id, token, this.now(), this.expiry())))
        throw new DomainError("VERSION_COPY_LEASE_LOST", "版本复制工作器租约失效。");
      if (
        state.status !== "cancelling" &&
        state.phase !== "cleanup" &&
        (await this.dependencies.repository.get(state.id))?.status === "cancelling"
      )
        throw new DomainError("VERSION_COPY_CANCELLED", "版本复制已请求取消。");
    }
  }
  private async copyObjects(
    state: VersionCopyState,
    snapshot: VersionCopySnapshotReader,
    token: string,
    signal: AbortSignal,
  ): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      const page = await snapshot.objects(state.cursor, 8);
      if (!page.length) break;
      for (const object of page) {
        signal.throwIfAborted();
        const first = await this.dependencies.objects.openRead(object.objectKey);
        const hash = createHash("sha256");
        let bytes = 0;
        for await (const chunk of first.content) {
          signal.throwIfAborted();
          hash.update(chunk);
          bytes += chunk.byteLength;
        }
        if (bytes !== first.sizeBytes)
          throw new DomainError("VERSION_COPY_OBJECT_CORRUPT", "源文件长度与实际内容不一致。");
        const sha256 = hash.digest("hex");
        if (
          (object.sha256 && object.sha256 !== sha256) ||
          (object.sizeBytes !== undefined && object.sizeBytes !== bytes)
        )
          throw new DomainError(
            "VERSION_COPY_OBJECT_CORRUPT",
            "源文件未通过记录中的 SHA-256／大小校验，复制已停止。",
          );
        await this.dependencies.archive.ensureObjectCapacity(bytes);
        const objects = this.dependencies.objects;
        const checked = async function* () {
          const source = await objects.openRead(object.objectKey);
          for await (const chunk of source.content) {
            signal.throwIfAborted();
            yield chunk;
          }
        };
        await this.dependencies.objects.putObject({
          objectKey: versionCopyObjectKey(state, object.objectKey),
          sha256,
          sizeBytes: bytes,
          mediaType: "application/octet-stream",
          content: checked(),
        });
        state.cursor = object.ordinal;
        state.copiedObjects++;
        state.progressPercent =
          10 + Math.floor((30 * state.copiedObjects) / Math.max(1, state.totalObjects));
        await this.save(state, token);
        await yieldTurn();
      }
    }
    state.phase = "records";
    state.cursor = -1;
    await this.save(state, token);
  }
  private async copyRecords(
    state: VersionCopyState,
    snapshot: VersionCopySnapshotReader,
    token: string,
    signal: AbortSignal,
  ): Promise<void> {
    while (state.collectionIndex < snapshot.manifest.collections.length) {
      const collection = snapshot.manifest.collections[state.collectionIndex]!;
      for (;;) {
        signal.throwIfAborted();
        const page = await snapshot.records(collection.name, state.cursor, 32);
        if (!page.length) break;
        const records = [];
        for (const record of page) {
          const batch =
            collection.name === "run_batch_round_recoveries"
              ? await snapshot.find("run_batches", JSON.stringify([record.row.batch_id]))
              : null;
          records.push({
            ...record,
            row: copyVersionRecord({
              job: state,
              collection: collection.name,
              row: record.row,
              cipher: this.dependencies.cipher,
              ...(batch ? { sourceSuiteId: String(batch.suite_id) } : {}),
            }),
          });
        }
        state.cursor = page.at(-1)!.ordinal;
        state.copiedRows += page.length;
        state.progressPercent =
          40 + Math.floor((30 * state.copiedRows) / Math.max(1, state.totalRows));
        state.updatedAt = this.now();
        await this.dependencies.repository.insertPage(state, records, token);
        await yieldTurn();
      }
      state.cursor = -1;
      // Persist the next collection before yielding, so a restart never repeats committed rows.
      state.collectionIndex++;
      await this.save(state, token);
    }
    state.phase = "logs";
    state.cursor = -1;
    await this.save(state, token);
  }
  private async copyLogs(
    state: VersionCopyState,
    snapshot: VersionCopySnapshotReader,
    token: string,
    signal: AbortSignal,
  ): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      const attempts = await snapshot.records("run_attempts", state.cursor, 16);
      if (!attempts.length) break;
      for (const attempt of attempts) {
        const run = await snapshot.find(
          "execution_runs",
          JSON.stringify([attempt.row.execution_run_id]),
        );
        if (!run)
          throw new DomainError(
            "VERSION_COPY_RELATION_MISSING",
            "源执行记录缺少对应的用例执行任务。",
          );
        const batchId = String(run.batch_id);
        const attemptId = String(attempt.row.id);
        for (const stream of ["stdout", "stderr", "agent"] as const) {
          const watermark = await snapshot.find(
            "attempt_log_watermarks",
            JSON.stringify([attemptId, stream]),
          );
          const expected = Math.max(
            Number(watermark?.acknowledged_sequence ?? -1),
            await this.dependencies.logs.acknowledgedSequence(batchId, attemptId, stream),
          );
          let after = -1;
          for (;;) {
            signal.throwIfAborted();
            const page = await this.dependencies.logs.listChunks({
              batchId,
              attemptId,
              stream,
              afterSequence: after,
              limit: 32,
            });
            if (page.items.length) {
              await this.dependencies.logs.appendChunks({
                batchId: versionCopyId(state, batchId),
                attemptId: versionCopyId(state, attemptId),
                receivedAt: this.now(),
                chunks: page.items,
              });
              after = page.items.at(-1)!.sequence;
            }
            if (!page.hasMore) break;
            if (!page.items.length)
              throw new DomainError("VERSION_COPY_LOG_INCOMPLETE", "源日志分页未能前进。");
            await yieldTurn();
          }
          if (after < expected)
            throw new DomainError(
              "VERSION_COPY_LOG_INCOMPLETE",
              "源日志缺少已确认的数据，不能生成不完整的版本副本。",
            );
          if (
            (await this.dependencies.logs.acknowledgedSequence(
              versionCopyId(state, batchId),
              versionCopyId(state, attemptId),
              stream,
            )) < expected
          )
            throw new DomainError(
              "VERSION_COPY_LOG_INCOMPLETE",
              "目标日志未达到来源确认水位，副本暂不开放。",
            );
        }
        state.cursor = attempt.ordinal;
        state.copiedAttempts++;
        state.progressPercent =
          70 + Math.floor((28 * state.copiedAttempts) / Math.max(1, state.totalAttempts));
        await this.save(state, token);
        await yieldTurn();
      }
    }
    state.phase = "verify";
    state.progressPercent = 99;
    await this.save(state, token);
  }
  private async cleanup(
    state: VersionCopyState,
    snapshot: VersionCopySnapshotReader | undefined,
    token: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (snapshot)
      for (const collection of [...snapshot.manifest.collections].reverse()) {
        for (let cursor = -1; ;) {
          signal.throwIfAborted();
          const page = await snapshot.records(collection.name, cursor, 32);
          if (!page.length) break;
          if (collection.name === "run_batches")
            for (const record of page)
              await this.dependencies.logs.removeBatchStore(
                versionCopyId(state, String(record.row.id)),
              );
          state.updatedAt = this.now();
          await this.dependencies.repository.removePage(
            state,
            collection,
            page.map((record) => versionCopyPrimaryKey(state, collection, record.row)),
            token,
          );
          cursor = page.at(-1)!.ordinal;
          await yieldTurn();
        }
      }
    // Metadata and log deletion is complete. Persist this checkpoint before
    // deleting the archive itself, so a later DB/storage failure can still resume.
    state.snapshot = null;
    state.phase = "cleanup";
    await this.save(state, token);
    const prefix = `projects/${state.targetProjectId}/version-copies/${state.id}/`;
    // Re-read from the beginning after deletion; storage cursors may name a removed filesystem entry.
    for (;;) {
      signal.throwIfAborted();
      const page = await this.dependencies.objects.list({ prefix, limit: 100 });
      if (!page.items.length) break;
      for (const object of page.items) await this.dependencies.objects.delete(object.objectKey);
      await yieldTurn();
    }
    state.updatedAt = this.now();
    await this.dependencies.repository.removeTarget(state, token);
    await this.dependencies.invalidate(state.targetProjectId);
  }
  private async save(state: VersionCopyState, token: string): Promise<void> {
    state.updatedAt = this.now();
    await this.dependencies.repository.save(state, token);
  }
  private now(): string {
    return this.dependencies.clock.now().toISOString();
  }
  private expiry(): string {
    return new Date(this.dependencies.clock.now().getTime() + 60_000).toISOString();
  }
}
