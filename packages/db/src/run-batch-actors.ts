import {
  storedExecutionActorSchema,
  publicSuiteExecutionContextSchema,
} from "@autoforge/contracts";
import type { RunBatch } from "@autoforge/domain";

export function runBatchActors(row: {
  publicExecutionJson: string | null;
  terminatedByJson: string | null;
}): Pick<RunBatch, "publicExecution" | "terminatedBy"> {
  const context = row.publicExecutionJson
    ? publicSuiteExecutionContextSchema.parse(JSON.parse(row.publicExecutionJson))
    : undefined;
  return {
    ...(context
      ? { publicExecution: { publisher: context.publisher, initiator: context.initiator } }
      : {}),
    ...(row.terminatedByJson ? { terminatedBy: storedActor(row.terminatedByJson) } : {}),
  };
}

export function storedActor(json: string) {
  const { schemaVersion, ...actor } = storedExecutionActorSchema.parse(JSON.parse(json));
  void schemaVersion;
  return actor;
}
