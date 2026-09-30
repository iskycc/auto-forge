import { describe, expect, it } from "vitest";
import type { AuthenticatedIdentity } from "@autoforge/domain";
import { authorizeReadModelQuery } from "./read-model-authorization";

const identity = {
  user: {
    id: "user",
    username: "reader",
    displayName: "Reader",
    source: "local",
    status: "active",
    forcePasswordChange: false,
    failedLoginAttempts: 0,
    createdAt: "2026-09-30T00:00:00Z",
    updatedAt: "2026-09-30T00:00:00Z",
    version: 1,
    groups: [],
  },
  sessionId: "session",
  systemPermissions: [],
  projectPermissions: { "project-a": ["run.read"], "project-b": ["case.read"] },
} as AuthenticatedIdentity;

describe("read model authorization", () => {
  it("authorizes a multi-project query by its sources rather than its default-project cache namespace", () => {
    expect(() =>
      authorizeReadModelQuery(identity, {
        kind: "analytics_scope",
        projectId: "namespace",
        projectIds: ["project-a"],
        filter: {},
      }),
    ).not.toThrow();
    expect(() =>
      authorizeReadModelQuery(identity, {
        kind: "analytics_scope",
        projectId: "project-a",
        projectIds: ["project-a", "project-b"],
        filter: {},
      }),
    ).toThrow();
    expect(() =>
      authorizeReadModelQuery(identity, {
        kind: "analytics_scope",
        projectId: "project-a",
        filter: {},
      }),
    ).toThrow();
  });

  it("rejects a comparison or batch counter when any source project is unauthorized", () => {
    expect(() =>
      authorizeReadModelQuery(identity, {
        kind: "batch_comparison",
        projectId: "project-a",
        rightProjectId: "project-b",
        leftBatchId: "a",
        rightBatchId: "b",
      }),
    ).toThrow();
    expect(() =>
      authorizeReadModelQuery(identity, {
        kind: "batch_counters",
        projectId: "project-a",
        batches: [
          { id: "a", projectId: "project-a" },
          { id: "b", projectId: "project-b" },
        ],
      }),
    ).toThrow();
  });

  it("requires suite access for a filtered case directory", () => {
    expect(() =>
      authorizeReadModelQuery(identity, {
        kind: "case_directory",
        projectId: "project-b",
        projectVersionId: "version",
        testStageId: "stage",
        filter: { query: "", outcome: "all", missingSuiteId: "suite" },
      }),
    ).toThrow();
  });
});
