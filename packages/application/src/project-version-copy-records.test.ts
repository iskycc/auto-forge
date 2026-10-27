import { describe, expect, it } from "vitest";
import { permissionCatalog, type AuthenticatedIdentity } from "@autoforge/domain";
import { assertVersionCopyAccess, publicVersionCopy } from "./copy-project-version";
import {
  copyVersionRecord,
  versionCopyId,
  versionCopyObjectReferences,
} from "./project-version-copy-records";
import type { VersionCopyState } from "./project-version-copy-ports";
import { createProjectVersionCopySchema } from "@autoforge/contracts";

const job: VersionCopyState = {
  id: "019a1280-0000-7000-8000-000000000001",
  sourceProjectId: "source",
  sourceVersionId: "source-version",
  sourceVersionName: "原版本",
  targetProjectId: "target",
  targetVersionId: "target-version",
  targetVersionName: "副本",
  targetMode: "new",
  requestKey: "request",
  requestedBy: "user",
  status: "running",
  phase: "records",
  totalRows: 1,
  copiedRows: 0,
  totalObjects: 0,
  copiedObjects: 0,
  totalAttempts: 0,
  copiedAttempts: 0,
  progressPercent: 40,
  errorCode: null,
  errorMessage: null,
  createdAt: "2026-10-23T00:00:00.000Z",
  updatedAt: "2026-10-23T00:00:00.000Z",
  snapshot: null,
  cursor: -1,
  collectionIndex: 0,
  leaseToken: "private-lease",
  leaseExpiresAt: null,
};
const cipher = {
  available: false,
  encrypt: () => {
    throw new Error("unexpected secret");
  },
  decrypt: () => {
    throw new Error("unexpected secret");
  },
};

describe("version-copy record boundaries", () => {
  it("keeps historical actors without copying the source public execution replay key", () => {
    const actors = JSON.stringify({
      schemaVersion: 1,
      publisher: { id: "original-user", username: "owner", source: "local" },
    });
    const copied = copyVersionRecord({
      job,
      collection: "run_batches",
      cipher,
      row: {
        id: "batch",
        suite_id: "suite",
        public_request_key: "source-request",
        public_execution_json: actors,
        terminated_by_json: actors,
      },
    });
    expect(copied.public_request_key).toBeNull();
    expect(copied.public_execution_json).toBe(actors);
    expect(copied.terminated_by_json).toBe(actors);
  });
  it("requires exactly one new-version name or existing-version ID", () => {
    const input = {
      sourceProjectId: "source",
      sourceVersionId: "source-version",
      targetProjectId: "target",
      requestKey: "request",
    };
    expect(createProjectVersionCopySchema.safeParse(input).success).toBe(false);
    expect(
      createProjectVersionCopySchema.safeParse({ ...input, targetVersionName: "新版本" }).success,
    ).toBe(true);
    expect(
      createProjectVersionCopySchema.safeParse({ ...input, targetVersionId: "empty-version" })
        .success,
    ).toBe(true);
    expect(
      createProjectVersionCopySchema.safeParse({
        ...input,
        targetVersionName: "新版本",
        targetVersionId: "empty-version",
      }).success,
    ).toBe(false);
  });
  it("rewrites task snapshot member IDs and known metadata, while preserving arbitrary DDT and TestNG input", () => {
    const raw = {
      id: "business-id",
      projectId: "source",
      projectVersionId: "source-version",
      objectKey: "用户输入",
      CaseId: "中文-1",
      value: false,
    };
    const snapshot = {
      name: "原任务",
      policy: { projectVersionId: "source-version", runnerId: "runner", runnerGroupId: "group" },
      caseDefinitionIds: ["case"],
      ddtCaseIds: ["ddt"],
    };
    const copied = copyVersionRecord({
      job,
      collection: "case_suite_versions",
      cipher,
      row: {
        id: "snapshot",
        suite_id: "suite",
        snapshot_json: JSON.stringify(snapshot),
        data_json: JSON.stringify(raw),
        before_json: JSON.stringify(raw),
        parameters_json: JSON.stringify(raw),
      },
    });
    expect(JSON.parse(String(copied.snapshot_json))).toEqual({
      ...snapshot,
      policy: { ...snapshot.policy, projectVersionId: job.targetVersionId },
      caseDefinitionIds: [versionCopyId(job, "case")],
      ddtCaseIds: [versionCopyId(job, "ddt")],
    });
    expect(copied.data_json).toBe(JSON.stringify(raw));
    expect(copied.before_json).toBe(JSON.stringify(raw));
    expect(copied.parameters_json).toBe(JSON.stringify(raw));
    const execution = copyVersionRecord({
      job,
      collection: "execution_runs",
      cipher,
      row: {
        id: "run",
        case_definition_id: "ddt",
        assigned_runner_id: "runner",
        execution_spec_json: JSON.stringify({ id: "run", parameters: raw, classData: raw }),
      },
    });
    expect(JSON.parse(String(execution.execution_spec_json))).toEqual({
      id: versionCopyId(job, "run"),
      parameters: raw,
      classData: raw,
    });
    expect(execution.assigned_runner_id).toBe("runner");
  });
  it("never discovers files in user payloads and skips artifacts that were never uploaded", () => {
    const reference = { objectKey: "real-object", sha256: "a".repeat(64), sizeBytes: 0 };
    expect(
      versionCopyObjectReferences("ddt_cases", {
        data_json: JSON.stringify({ objectKey: "user-value" }),
        snapshot_json: JSON.stringify({
          parameters: { objectKey: "parameter-value" },
          artifact: reference,
        }),
      }),
    ).toEqual([reference]);
    expect(
      versionCopyObjectReferences("attempt_artifacts", {
        status: "declared",
        object_key: "not-uploaded",
      }),
    ).toEqual([]);
    expect(
      versionCopyObjectReferences("failure_analysis_claims", {
        screenshot_object_key: "picture",
        screenshot_sha256: "b".repeat(64),
        screenshot_size_bytes: 5,
      }),
    ).toEqual([{ objectKey: "picture", sha256: "b".repeat(64), sizeBytes: 5 }]);
  });
  it("hides internal credentials, storage references and unfinished target IDs from public progress DTOs", () => {
    const visible = publicVersionCopy(job);
    expect(visible).not.toHaveProperty("leaseToken");
    expect(visible).not.toHaveProperty("requestKey");
    expect(visible).not.toHaveProperty("snapshot");
    expect(visible).not.toHaveProperty("targetVersionId");
    expect(publicVersionCopy({ ...job, status: "completed" }).targetVersionId).toBe(
      "target-version",
    );
  });
  it("requires full source visibility and management permission in both project scopes", () => {
    const identity = {
      user: {
        id: "operator",
        username: "operator",
        displayName: "Operator",
        source: "local",
        status: "active",
        forcePasswordChange: false,
        failedLoginAttempts: 0,
        createdAt: job.createdAt,
        updatedAt: job.createdAt,
        version: 1,
      },
      sessionId: "session",
      systemPermissions: [],
      projectPermissions: { source: [...permissionCatalog], target: [...permissionCatalog] },
    } satisfies AuthenticatedIdentity;
    expect(() => assertVersionCopyAccess(identity, "source", "target")).not.toThrow();
    expect(() =>
      assertVersionCopyAccess(
        {
          ...identity,
          projectPermissions: {
            ...identity.projectPermissions,
            source: permissionCatalog.filter((permission) => permission !== "log.read"),
          },
        },
        "source",
        "target",
      ),
    ).toThrow(/完整数据读取权限/);
    expect(() => assertVersionCopyAccess(identity, "source", "unauthorized")).toThrow();
  });
});
