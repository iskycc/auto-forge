import type {
  JarImportJob,
  JarImportResult,
  JarInspection,
  JobEnvelope,
  TestNgClassCandidate,
} from "@autoforge/contracts";
import { DEFAULT_PROJECT_ID, DomainError } from "@autoforge/domain";

import type {
  CaseCatalogRepository,
  Clock,
  ExistingSource,
  IdGenerator,
  ImportCaseRecord,
  JarDiscoveryPort,
  JarObjectStorePort,
} from "./ports";

export type ImportTestNgJarDependencies = {
  discovery: JarDiscoveryPort;
  objectStore: JarObjectStorePort;
  catalog: CaseCatalogRepository;
  clock: Clock;
  ids: IdGenerator;
};

export type ImportTestNgJarInput = {
  fileName: string;
  content: Uint8Array;
  projectId?: string;
  projectVersionId?: string;
  testStageId?: string;
  actorId?: string;
};

export type EnqueueTestNgJarImportInput = ImportTestNgJarInput & {
  sha256: string;
  idempotencyKey: string;
};

function duplicateResult(source: ExistingSource, inspection: JarInspection): JarImportResult {
  return {
    sourceId: source.sourceId,
    duplicate: true,
    importedClassCount: source.classCount,
    importedMethodCount: source.methodCount,
    inspection,
  };
}

function importedCases(classes: TestNgClassCandidate[], ids: IdGenerator): ImportCaseRecord[] {
  return classes.map((candidate) => ({
    caseDefinitionId: ids.next(),
    caseVersionId: ids.next(),
    candidate,
    methods: candidate.methods.map((_, methodIndex) => ({
      methodId: ids.next(),
      methodIndex,
    })),
  }));
}

function displayName(fileName: string): string {
  return fileName.replace(/\.jar$/i, "") || fileName;
}

export class ImportTestNgJarService {
  constructor(private readonly dependencies: ImportTestNgJarDependencies) {}

  async execute(input: ImportTestNgJarInput): Promise<JarImportResult> {
    const inspection = await this.dependencies.discovery.inspect(input.fileName, input.content);
    const projectId = input.projectId ?? DEFAULT_PROJECT_ID;
    if (inspection.testClassCount === 0) {
      throw new DomainError(
        "NO_TESTNG_TESTS",
        "JAR 中没有发现带 TestNG @Test 注解的测试类或测试方法。",
      );
    }

    const existing = await this.dependencies.catalog.findSourceBySha256(
      inspection.sha256,
      projectId,
      input.projectVersionId,
      input.testStageId,
    );
    if (existing) {
      return duplicateResult(existing, inspection);
    }

    const stored = await this.dependencies.objectStore.putJar(
      projectId,
      inspection.sha256,
      input.content,
    );
    const sourceId = this.dependencies.ids.next();
    const importedAt = this.dependencies.clock.now().toISOString();

    try {
      await this.dependencies.catalog.importCatalog({
        sourceId,
        projectId,
        ...(input.projectVersionId ? { projectVersionId: input.projectVersionId } : {}),
        ...(input.testStageId ? { testStageId: input.testStageId } : {}),
        ...(input.actorId ? { importedBy: input.actorId } : {}),
        objectKey: stored.objectKey,
        displayName: displayName(input.fileName),
        importedAt,
        inspection,
        cases: importedCases(inspection.classes, this.dependencies.ids),
      });
    } catch (error) {
      const concurrentImport = await this.dependencies.catalog.findSourceBySha256(
        inspection.sha256,
        projectId,
        input.projectVersionId,
        input.testStageId,
      );
      if (concurrentImport) {
        return duplicateResult(concurrentImport, inspection);
      }
      if (stored.created) {
        try {
          await this.dependencies.objectStore.delete(stored.objectKey);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "JAR 目录写入失败，且无法清理已保存的对象。",
            { cause: error },
          );
        }
      }
      throw error;
    }

    return {
      sourceId,
      duplicate: false,
      importedClassCount: inspection.testClassCount,
      importedMethodCount: inspection.testMethodCount,
      inspection,
    };
  }

  async enqueue(input: EnqueueTestNgJarImportInput): Promise<JarImportJob> {
    if (!/^[a-f0-9]{64}$/.test(input.sha256)) {
      throw new DomainError("JAR_DIGEST_INVALID", "JAR SHA-256 摘要格式无效。");
    }
    const idempotencyKey = input.idempotencyKey.trim();
    if (!idempotencyKey || idempotencyKey.length > 256) {
      throw new DomainError("IDEMPOTENCY_KEY_INVALID", "幂等键必须为 1 至 256 个字符。");
    }
    const projectId = input.projectId ?? DEFAULT_PROJECT_ID;
    const stored = await this.dependencies.objectStore.putJar(
      projectId,
      input.sha256,
      input.content,
    );
    const now = this.dependencies.clock.now().toISOString();
    const jobId = this.dependencies.ids.next();
    const job: JarImportJob = {
      id: jobId,
      projectId,
      ...(input.projectVersionId ? { projectVersionId: input.projectVersionId } : {}),
      ...(input.testStageId ? { testStageId: input.testStageId } : {}),
      fileName: input.fileName,
      sha256: input.sha256,
      sizeBytes: input.content.byteLength,
      status: "queued",
      progressPercent: 0,
      ...(input.actorId ? { requestedBy: input.actorId } : {}),
      createdAt: now,
      updatedAt: now,
    };
    return this.dependencies.catalog.createJarImportJob({
      job,
      objectKey: stored.objectKey,
      idempotencyKey,
      dispatchJob: this.importJobEnvelope(
        jobId,
        now,
        `jar-import:${importScopeKey(job)}:${idempotencyKey}`,
      ),
    });
  }

  getJob(jobId: string, projectIds?: readonly string[]) {
    return this.dependencies.catalog.getJarImportJob(jobId, projectIds);
  }

  requestCancellation(jobId: string, projectIds?: readonly string[]) {
    return this.dependencies.catalog.requestJarImportCancellation({
      jobId,
      ...(projectIds ? { projectIds } : {}),
      updatedAt: this.dependencies.clock.now().toISOString(),
    });
  }

  retry(jobId: string, projectIds?: readonly string[]) {
    const now = this.dependencies.clock.now().toISOString();
    const messageId = this.dependencies.ids.next();
    return this.dependencies.catalog.retryJarImportJob({
      jobId,
      ...(projectIds ? { projectIds } : {}),
      dispatchJob: this.importJobEnvelope(
        jobId,
        now,
        `jar-import:${jobId}:retry:${messageId}`,
        messageId,
      ),
      updatedAt: now,
    });
  }

  jobHandler() {
    return async (envelope: JobEnvelope, signal: AbortSignal): Promise<void> => {
      const jobId = envelope.payload.jobId;
      if (typeof jobId !== "string") throw new Error("JAR import jobId is invalid.");
      const startedAt = this.dependencies.clock.now().toISOString();
      const claimed = await this.dependencies.catalog.claimJarImportJob({ jobId, startedAt });
      if (!claimed) return;
      try {
        await this.throwIfCancelled(jobId, signal);
        const content = await this.dependencies.objectStore.read(claimed.objectKey);
        await this.dependencies.catalog.updateJarImportJob({
          jobId,
          status: "running",
          progressPercent: 25,
          updatedAt: this.dependencies.clock.now().toISOString(),
        });
        await this.throwIfCancelled(jobId, signal);
        const result = await this.execute({
          fileName: claimed.job.fileName,
          content,
          projectId: claimed.job.projectId,
          ...(claimed.job.projectVersionId
            ? { projectVersionId: claimed.job.projectVersionId }
            : {}),
          ...(claimed.job.testStageId ? { testStageId: claimed.job.testStageId } : {}),
          ...(claimed.job.requestedBy ? { actorId: claimed.job.requestedBy } : {}),
        });
        const finishedAt = this.dependencies.clock.now().toISOString();
        await this.dependencies.catalog.updateJarImportJob({
          jobId,
          status: "succeeded",
          progressPercent: 100,
          result,
          updatedAt: finishedAt,
          finishedAt,
        });
      } catch (error) {
        const finishedAt = this.dependencies.clock.now().toISOString();
        if (error instanceof ImportCancellationError || signal.aborted) {
          await this.dependencies.catalog.updateJarImportJob({
            jobId,
            status: "cancelled",
            progressPercent: 100,
            updatedAt: finishedAt,
            finishedAt,
          });
          return;
        }
        await this.dependencies.catalog.updateJarImportJob({
          jobId,
          status: "failed",
          progressPercent: 100,
          errorCode: error instanceof DomainError ? error.code : "JAR_IMPORT_FAILED",
          errorSummary: error instanceof Error ? error.message.slice(0, 1_000) : "JAR 导入失败。",
          updatedAt: finishedAt,
          finishedAt,
        });
        throw error;
      }
    };
  }

  private async throwIfCancelled(jobId: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new ImportCancellationError();
    const job = await this.dependencies.catalog.getJarImportJob(jobId);
    if (job?.status === "cancel_requested" || job?.status === "cancelled") {
      throw new ImportCancellationError();
    }
  }

  private importJobEnvelope(
    jobId: string,
    createdAt: string,
    deduplicationKey: string,
    messageId = this.dependencies.ids.next(),
  ): JobEnvelope {
    return {
      schemaVersion: 1,
      messageId,
      runId: jobId,
      attempt: 1,
      createdAt,
      priority: 0,
      deduplicationKey,
      kind: "jar-import",
      payload: { jobId },
    };
  }
}

function importScopeKey(job: Pick<JarImportJob, "projectId" | "projectVersionId" | "testStageId">) {
  return job.projectVersionId && job.testStageId
    ? `${job.projectId}:${job.projectVersionId}:${job.testStageId}`
    : `${job.projectId}:legacy`;
}

class ImportCancellationError extends Error {
  constructor() {
    super("JAR import was cancelled.");
  }
}
