import { describe, expect, it } from "vitest";
import {
  runtimeDiagnosticContext,
  isRuntimeDatabaseContention,
} from "@autoforge/contracts/runtime-diagnostics";

describe("runtime diagnostics", () => {
  it("keeps the worker operation and nested lock code through a serialized error", () => {
    const error = new Error("SQL containing credentials must never enter notifications", {
      cause: Object.assign(new Error("locked"), { code: "SQLITE_BUSY" }),
    });
    Object.assign(error, {
      runtimeContext: {
        operation: "platform-maintenance.notifications",
        database: "sqlite",
        requestId: "work-32",
      },
    });
    const context = runtimeDiagnosticContext(error, { operation: "http.request" });
    expect(context).toEqual({
      operation: "platform-maintenance.notifications",
      database: "sqlite",
      requestId: "work-32",
      errorCode: "SQLITE_BUSY",
    });
    expect(isRuntimeDatabaseContention(context)).toBe(true);
  });
  it("bounds cause traversal and excludes secrets, paths and multiline context", () => {
    const error = {
      code: "55P03",
      runtimeContext: {
        operation: "postgres://user:secret@db",
        database: "postgres://user:secret@db",
        requestId: "id\nforged",
        sql: "secret",
        batchId: "batch-1",
      },
      cause: {},
    };
    error.cause = error;
    expect(
      runtimeDiagnosticContext(error, { operation: "snapshot.cleanup", database: "postgresql" }),
    ).toEqual({
      operation: "snapshot.cleanup",
      database: "postgresql",
      batchId: "batch-1",
      errorCode: "55P03",
    });
  });
});
