import { describe, expect, it, vi } from "vitest";

import type { ProjectVersion } from "@autoforge/domain";

import { ProjectStructureService } from "../src/manage-project-structure";
import type { JarObjectStorePort, ProjectStructureRepository } from "../src/ports";

const timestamp = "2026-08-20T00:00:00.000Z";
const archive = {
  url: "https://jenkins.internal/job/dependencies/lastSuccessfulBuild/artifact/dependencies.zip",
  fileName: "dependencies.zip",
  sha256: "a".repeat(64),
  sizeBytes: 12_345,
  archiveFormat: "zip" as const,
};

describe("version dependency publication", () => {
  it("creates a missing version and atomically replaces its sole dependency archive", async () => {
    const structures = repositoryFake({ versions: [] });
    structures.createVersion.mockResolvedValue(projectVersion("version-1", "2026.08"));
    structures.replaceVersionRuntimeAsset.mockResolvedValue({
      version: projectVersion("version-1", "2026.08"),
      asset: { id: "asset-1" },
    });
    const ids = ["version-1", "asset-1"];
    const service = new ProjectStructureService(
      structures,
      {} as JarObjectStorePort,
      { now: () => new Date(timestamp) },
      { next: () => ids.shift()! },
    );

    await service.replaceVersionDependency(
      { projectId: "project-1", version: "2026.08", dependencyArchive: archive },
      "user-1",
    );

    expect(structures.createVersion).toHaveBeenCalledWith({
      id: "version-1",
      projectId: "project-1",
      name: "2026.08",
      normalizedName: "2026.08",
      recordedAt: timestamp,
    });
    expect(structures.replaceVersionRuntimeAsset).toHaveBeenCalledWith(
      "version-1",
      expect.objectContaining({
        id: "asset-1",
        projectId: "project-1",
        kind: "jar-bundle",
        sourceType: "url",
        createdBy: "user-1",
        ...archive,
      }),
    );
  });

  it("reuses an active normalized version and rejects an archived version", async () => {
    const active = repositoryFake({ versions: [projectVersion("version-1", "Release A")] });
    active.replaceVersionRuntimeAsset.mockResolvedValue({
      version: projectVersion("version-1", "Release A"),
      asset: { id: "asset-1" },
    });
    const service = new ProjectStructureService(
      active,
      {} as JarObjectStorePort,
      { now: () => new Date(timestamp) },
      { next: () => "asset-1" },
    );

    await service.replaceVersionDependency({
      projectId: "project-1",
      version: " release a ",
      dependencyArchive: archive,
    });
    expect(active.createVersion).not.toHaveBeenCalled();
    expect(active.replaceVersionRuntimeAsset).toHaveBeenCalledWith("version-1", expect.any(Object));

    const archived = repositoryFake({
      versions: [{ ...projectVersion("version-2", "Release B"), status: "archived" as const }],
    });
    const archivedService = new ProjectStructureService(
      archived,
      {} as JarObjectStorePort,
      { now: () => new Date(timestamp) },
      { next: () => "unused" },
    );
    await expect(
      archivedService.replaceVersionDependency({
        projectId: "project-1",
        version: "Release B",
        dependencyArchive: archive,
      }),
    ).rejects.toMatchObject({ code: "PROJECT_VERSION_ARCHIVED" });
  });

  it("inherits runtime assets by reference and deletes an orphaned uploaded object", async () => {
    const structures = repositoryFake({ versions: [] });
    structures.inheritAdapterConfiguration = vi.fn().mockResolvedValue({
      projectId: "project-1",
      projectVersionId: "version-2",
      inheritedFromProjectVersionId: "version-1",
      revision: 1,
      updatedAt: timestamp,
    });
    structures.detachVersionRuntimeAsset = vi.fn().mockResolvedValue({
      configuration: {
        projectId: "project-1",
        projectVersionId: "version-2",
        revision: 0,
        updatedAt: "",
      },
      orphanedAsset: {
        id: "asset-upload",
        projectId: "project-1",
        kind: "jdk",
        sourceType: "upload",
        fileName: "jdk.zip",
        objectKey: "projects/project-1/runtime-assets/asset-upload.zip",
        sha256: "d".repeat(64),
        sizeBytes: 1024,
        archiveFormat: "zip",
        createdAt: timestamp,
      },
    });
    structures.deleteRuntimeAssetMetadata = vi.fn().mockResolvedValue(undefined);
    const objectStore = {
      delete: vi.fn().mockResolvedValue(undefined),
    } as unknown as JarObjectStorePort;
    const service = new ProjectStructureService(
      structures,
      objectStore,
      { now: () => new Date(timestamp) },
      { next: () => "unused" },
    );

    await service.inheritAdapterConfiguration({
      projectId: "project-1",
      sourceProjectVersionId: "version-1",
      targetProjectVersionId: "version-2",
      expectedRevision: 0,
    });
    await service.deleteVersionRuntimeAsset({
      projectId: "project-1",
      projectVersionId: "version-2",
      kind: "jdk",
      expectedRevision: 1,
    });

    expect(structures.inheritAdapterConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({ updatedAt: timestamp }),
    );
    expect(objectStore.delete).toHaveBeenCalledWith(
      "projects/project-1/runtime-assets/asset-upload.zip",
    );
    expect(structures.deleteRuntimeAssetMetadata).toHaveBeenCalledWith("asset-upload");
  });
});

function repositoryFake(structure: { versions: ReturnType<typeof projectVersion>[] }) {
  return {
    list: vi.fn().mockResolvedValue({
      projectId: "project-1",
      versions: structure.versions,
      stages: [],
      runtimeAssets: [],
      revision: 0,
      updatedAt: timestamp,
    }),
    createVersion: vi.fn(),
    replaceVersionRuntimeAsset: vi.fn(),
    inheritAdapterConfiguration: vi.fn(),
    detachVersionRuntimeAsset: vi.fn(),
    deleteRuntimeAssetMetadata: vi.fn(),
  } as unknown as ProjectStructureRepository & {
    createVersion: ReturnType<typeof vi.fn>;
    replaceVersionRuntimeAsset: ReturnType<typeof vi.fn>;
    inheritAdapterConfiguration: ReturnType<typeof vi.fn>;
    detachVersionRuntimeAsset: ReturnType<typeof vi.fn>;
    deleteRuntimeAssetMetadata: ReturnType<typeof vi.fn>;
  };
}

function projectVersion(id: string, name: string): ProjectVersion {
  return {
    id,
    projectId: "project-1",
    name,
    status: "active" as const,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
