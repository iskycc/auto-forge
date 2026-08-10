import { describe, expect, it, vi } from "vitest";

import { ExecutionEnvironmentService } from "../src/manage-execution-environments";
import type { ExecutionEnvironmentRepository } from "../src/ports";

describe("ExecutionEnvironmentService.copy", () => {
  it("copies the exact immutable secret version without exposing a value", async () => {
    const create = vi.fn().mockImplementation(async (record) => record);
    const repository = {
      get: vi.fn().mockResolvedValue({
        id: "environment-1",
        projectId: "project-1",
        name: "Staging",
        description: "Original",
        status: "active",
        currentVersion: 2,
        revision: 2,
        createdBy: "user-1",
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:00.000Z",
        current: {
          id: "environment-version-2",
          environmentId: "environment-1",
          version: 2,
          variables: [{ name: "BASE_URL", value: "https://example.test" }],
          secretBindings: [
            {
              name: "API_TOKEN",
              secretId: "secret-1",
              secretVersionId: "secret-version-1",
            },
          ],
          createdBy: "user-1",
          createdAt: "2026-08-10T00:00:00.000Z",
        },
      }),
      create,
    } as unknown as ExecutionEnvironmentRepository;
    let sequence = 0;
    const service = new ExecutionEnvironmentService(
      repository,
      { now: () => new Date("2026-08-10T01:00:00.000Z") },
      { next: () => `copy-${++sequence}` },
    );

    await service.copy("environment-1", { name: "Staging copy" }, "user-2", ["project-1"]);

    expect(repository.get).toHaveBeenCalledWith("environment-1", ["project-1"]);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "copy-1",
        versionId: "copy-2",
        projectId: "project-1",
        description: "Original",
        variables: [{ name: "BASE_URL", value: "https://example.test" }],
        secretBindings: [
          expect.objectContaining({
            secretId: "secret-1",
            secretVersionId: "secret-version-1",
          }),
        ],
      }),
    );
  });
});
