import { readdirSync, readFileSync } from "node:fs";
import { resolve, relative } from "node:path";

const root = resolve("apps/web/src/app/api/v1");
const anonymousEndpoints = new Set([
  "GET /health/live",
  "GET /health/ready",
  "GET /time",
  "GET /public/statistics",
  "GET /auth/setup-status",
  "POST /auth/bootstrap",
  "POST /auth/login",
  "POST /auth/setup-platform",
  "GET /public/ddt/projects/[projectId]/versions/[projectVersionId]/stages/[testStageId]/case",
  "GET /public/ddt/projects/[projectId]/versions/[projectVersionId]/stages/[testStageId]/cases/[caseId]",
  "GET /public/ddt/projects/[projectId]/versions/[projectVersionId]/stages/[testStageId]/users/[ownerUserId]/debug/[accessKey]/case",
]);
const protocolEndpoints = new Set([
  "POST /internal/platform-logs",
  "POST /runner-agents/register",
  "POST /runner-agents/[runnerId]/claims",
  "POST /runner-agents/[runnerId]/credentials/rotate",
  "POST /runner-agents/[runnerId]/heartbeat",
  "POST /runner-agents/[runnerId]/leases/[leaseId]/renew",
  "POST /runner-agents/[runnerId]/reconcile",
  "POST /run-attempts/[attemptId]/artifacts",
  "PUT /run-attempts/[attemptId]/artifacts/[artifactId]",
  "POST /run-attempts/[attemptId]/artifacts/[artifactId]/finalize",
  "POST /run-attempts/[attemptId]/complete",
  "GET /run-attempts/[attemptId]/inputs/[inputId]",
  "POST /run-attempts/[attemptId]/logs",
]);

/** New HTTP entrypoints automatically join the anonymous-access regression sweep. */
export function authorizationRouteInventory() {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === "route.ts")
    .flatMap((entry) => {
      const file = resolve(entry.parentPath, entry.name);
      const path = `/${relative(root, file).replace(/\/route\.ts$/, "")}`;
      const source = readFileSync(file, "utf8");
      return [
        ...source.matchAll(
          /export\s+(?:(?:async\s+)?function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g,
        ),
      ]
        .map((match) => ({
          path,
          method: match[1]!,
          protocol: protocolEndpoints.has(`${match[1]} ${path}`),
        }))
        .filter(({ method }) => !anonymousEndpoints.has(`${method} ${path}`));
    });
}

export function anonymousRequestBody(path: string) {
  // Supply valid protocol fields so the rejection exercises credentials, not
  // input validation. Unknown fields are discarded by the endpoint schemas.
  if (path.startsWith("/runner-agents/"))
    return {
      schemaVersion: 1,
      protocolVersion: 1,
      name: "anonymous-auth-probe",
      labels: [],
      capabilities: [],
      maxConcurrency: 1,
      os: "linux",
      architecture: "amd64",
      agentVersion: "0.7.2",
      terminalEnabled: false,
      busySlots: 0,
      availableSlots: 0,
      waitSeconds: 0,
      requestId: "anonymous-auth-probe",
      attempts: [],
      leaseToken: "x".repeat(32),
      leaseVersion: 1,
    };
  return {
    ids: ["a".repeat(64)],
    projectId: "missing",
    projectVersionId: "missing",
    batchId: "missing",
    executionRunIds: ["missing"],
    assigneeId: "missing",
    action: "close",
  };
}

export function anonymousRequestPath(path: string): string {
  const id = "00000000-0000-7000-8000-000000000099";
  const pathname = path
    .replace("[[...path]]", "candidates")
    .replace("[...path]", "cases")
    .replace("[snapshotId]", "a".repeat(64))
    .replace("[version]", "1")
    .replace("[category]", "audit")
    .replace(/\[[^\]]+\]/g, id);
  return `/api/v1${pathname}?${new URLSearchParams({ generation: id, ordinal: "0", ids: "a".repeat(64), projectId: id, projectVersionId: id, testStageId: id, batchId: id, caseDefinitionId: id, caseDefinitionIds: id, analysisId: id, scope: path.includes("failure-analysis/conclusions") ? "same_case" : "all" })}`;
}
