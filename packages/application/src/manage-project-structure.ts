import {
  createProjectVersionInputSchema,
  createTestStageInputSchema,
  jenkinsDependencyPublicationInputSchema,
  projectAdapterConfigurationInputSchema,
  runtimeAssetUrlInputSchema,
  type CreateProjectVersionInput,
  type CreateTestStageInput,
  type JenkinsDependencyPublicationInput,
  type ProjectAdapterConfigurationInput,
  type RuntimeAssetUrlInput,
} from "@autoforge/contracts";
import {
  DomainError,
  type ProjectVersion,
  type RuntimeArchiveFormat,
  type RuntimeAssetKind,
} from "@autoforge/domain";

import type { Clock, IdGenerator, JarObjectStorePort, ProjectStructureRepository } from "./ports";

export class ProjectStructureService {
  constructor(
    private readonly structures: ProjectStructureRepository,
    private readonly objectStore: JarObjectStorePort,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  list(projectId: string) {
    return this.structures.list(projectId);
  }

  createVersion(projectId: string, input: CreateProjectVersionInput) {
    const validated = createProjectVersionInputSchema.parse(input);
    return this.structures.createVersion({
      id: this.ids.next(),
      projectId,
      name: validated.name,
      normalizedName: normalizeName(validated.name),
      recordedAt: this.clock.now().toISOString(),
    });
  }

  createStage(projectId: string, projectVersionId: string, input: CreateTestStageInput) {
    const validated = createTestStageInputSchema.parse(input);
    return this.structures.createStage({
      id: this.ids.next(),
      projectId,
      projectVersionId,
      name: validated.name,
      normalizedName: normalizeName(validated.name),
      description: validated.description,
      recordedAt: this.clock.now().toISOString(),
    });
  }

  createUrlAsset(projectId: string, input: RuntimeAssetUrlInput, actorId?: string) {
    const validated = runtimeAssetUrlInputSchema.parse(input);
    return this.structures.createRuntimeAsset({
      id: this.ids.next(),
      projectId,
      kind: validated.kind,
      sourceType: "url",
      fileName: validated.fileName,
      url: validated.url,
      sha256: validated.sha256,
      sizeBytes: validated.sizeBytes,
      archiveFormat: validated.archiveFormat,
      ...(actorId ? { createdBy: actorId } : {}),
      createdAt: this.clock.now().toISOString(),
    });
  }

  async replaceVersionDependency(input: JenkinsDependencyPublicationInput, actorId?: string) {
    const validated = jenkinsDependencyPublicationInputSchema.parse(input);
    const structure = await this.structures.list(validated.projectId);
    const normalizedVersion = normalizeName(validated.version);
    let version: ProjectVersion | undefined = structure.versions.find(
      (candidate) => normalizeName(candidate.name) === normalizedVersion,
    );
    if (version?.status === "archived") {
      throw new DomainError("PROJECT_VERSION_ARCHIVED", "已归档的项目版本不能接收新的依赖压缩包。");
    }
    version ??= await this.structures.createVersion({
      id: this.ids.next(),
      projectId: validated.projectId,
      name: validated.version,
      normalizedName: normalizedVersion,
      recordedAt: this.clock.now().toISOString(),
    });
    const archive = validated.dependencyArchive;
    return this.structures.replaceVersionRuntimeAsset(version.id, {
      id: this.ids.next(),
      projectId: validated.projectId,
      kind: "jar-bundle",
      sourceType: "url",
      fileName: archive.fileName,
      url: archive.url,
      sha256: archive.sha256,
      sizeBytes: archive.sizeBytes,
      archiveFormat: archive.archiveFormat,
      ...(actorId ? { createdBy: actorId } : {}),
      createdAt: this.clock.now().toISOString(),
    });
  }

  async createUploadedAsset(input: {
    projectId: string;
    kind: RuntimeAssetKind;
    fileName: string;
    content: AsyncIterable<Uint8Array>;
    sizeBytes: number;
    sha256: string;
    archiveFormat: RuntimeArchiveFormat;
    actorId?: string;
  }) {
    if (!/^[a-f0-9]{64}$/u.test(input.sha256)) {
      throw new DomainError("RUNTIME_ASSET_DIGEST_INVALID", "运行时资源 SHA-256 格式无效。");
    }
    const assetId = this.ids.next();
    const extension = input.archiveFormat === "tar.gz" ? "tar.gz" : "zip";
    const objectKey = `projects/${input.projectId}/runtime-assets/${assetId}.${extension}`;
    await this.objectStore.putObject({
      objectKey,
      sha256: input.sha256,
      sizeBytes: input.sizeBytes,
      mediaType: input.archiveFormat === "zip" ? "application/zip" : "application/gzip",
      content: input.content,
    });
    try {
      return await this.structures.createRuntimeAsset({
        id: assetId,
        projectId: input.projectId,
        kind: input.kind,
        sourceType: "upload",
        fileName: input.fileName,
        objectKey,
        sha256: input.sha256,
        sizeBytes: input.sizeBytes,
        archiveFormat: input.archiveFormat,
        ...(input.actorId ? { createdBy: input.actorId } : {}),
        createdAt: this.clock.now().toISOString(),
      });
    } catch (error) {
      try {
        await this.objectStore.delete(objectKey);
      } catch (cleanupError) {
        throw new DomainError(
          "RUNTIME_ASSET_REGISTRATION_FAILED",
          "运行时资源元数据保存失败，且已上传对象未能清理，请检查对象存储。",
          { cause: new AggregateError([error, cleanupError]) },
        );
      }
      throw error;
    }
  }

  updateAdapterConfiguration(
    projectId: string,
    input: ProjectAdapterConfigurationInput,
    actorId?: string,
  ) {
    const validated = projectAdapterConfigurationInputSchema.parse(input);
    return this.structures.updateAdapterConfiguration({
      projectId,
      ...(validated.jdkAssetId ? { jdkAssetId: validated.jdkAssetId } : {}),
      ...(validated.jarBundleAssetId ? { jarBundleAssetId: validated.jarBundleAssetId } : {}),
      expectedRevision: validated.expectedRevision,
      ...(actorId ? { actorId } : {}),
      updatedAt: this.clock.now().toISOString(),
    });
  }
}

function normalizeName(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}
