/** Only bounded identifiers cross worker boundaries; SQL, URLs and error messages stay out. */
export type RuntimeDiagnosticContext = {
  operation: string;
  database?: "sqlite" | "postgresql" | "attempt-logs";
  errorCode?: string;
  requestId?: string;
  batchId?: string;
  projectId?: string;
};

const identifier = /^[a-zA-Z0-9_.:-]{1,120}$/;

export function runtimeDiagnosticContext(
  error: unknown,
  fallback: RuntimeDiagnosticContext,
): RuntimeDiagnosticContext {
  const context: RuntimeDiagnosticContext = { operation: "unknown" };
  copyIdentifiers(fallback, context);
  const visited = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 16 && current && typeof current === "object"; depth++) {
    if (visited.has(current)) break;
    visited.add(current);
    if ("runtimeContext" in current) copyIdentifiers(current.runtimeContext, context);
    if ("code" in current && typeof current.code === "string" && identifier.test(current.code))
      context.errorCode = current.code;
    current = "cause" in current ? current.cause : undefined;
  }
  return context;
}

function copyIdentifiers(source: unknown, target: RuntimeDiagnosticContext): void {
  if (!source || typeof source !== "object") return;
  for (const field of ["operation", "errorCode", "requestId", "batchId", "projectId"] as const) {
    if (field in source) {
      const value = (source as Record<string, unknown>)[field];
      if (typeof value === "string" && identifier.test(value)) target[field] = value;
    }
  }
  if (
    "database" in source &&
    ["sqlite", "postgresql", "attempt-logs"].includes(String(source.database))
  )
    target.database = source.database as NonNullable<RuntimeDiagnosticContext["database"]>;
}

export function isRuntimeDatabaseContention(context: RuntimeDiagnosticContext): boolean {
  return /^(SQLITE_(BUSY|LOCKED)(_|$)|55P03$|57014$|40P01$|40001$)/.test(context.errorCode ?? "");
}

export type RuntimeIncident = {
  id: string;
  kind:
    | "log_io"
    | "background_refresh"
    | "web_pressure"
    | "database_busy"
    | "execution_control"
    | "resource_pressure";
  createdAt: string;
  context?: RuntimeDiagnosticContext;
};
