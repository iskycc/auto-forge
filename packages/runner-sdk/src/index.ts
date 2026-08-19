import type { ExecutionControlService } from "@autoforge/application";
import {
  acquireAttemptSecretsInputSchema,
  claimAssignmentsInputSchema,
  completeAttemptInputSchema,
  declareArtifactsInputSchema,
  reconcileAttemptsInputSchema,
  renewLeaseInputSchema,
  uploadLogChunksInputSchema,
  RUNNER_PROTOCOL_VERSION,
} from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";

const POLL_INTERVAL_MS = 500;

export class RunnerProtocolController {
  constructor(private readonly executions: ExecutionControlService) {}

  async claim(runnerId: string, credential: string, rawInput: unknown) {
    const input = claimAssignmentsInputSchema.parse(rawInput);
    const deadline = Date.now() + input.waitSeconds * 1_000;
    do {
      const response = await this.executions.claim(runnerId, credential, {
        ...input,
        waitSeconds: 0,
      });
      if (
        response.assignments.length > 0 ||
        response.closedBatchIds.length > 0 ||
        Date.now() >= deadline
      ) {
        return { ...response, retryAfterMs: response.assignments.length > 0 ? 100 : 1_000 };
      }
      await delay(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    } while (Date.now() < deadline);
    return this.executions.claim(runnerId, credential, { ...input, waitSeconds: 0 });
  }

  renewLease(runnerId: string, credential: string, leaseId: string, rawInput: unknown) {
    return this.executions.renewLease(
      runnerId,
      credential,
      leaseId,
      renewLeaseInputSchema.parse(rawInput),
    );
  }

  complete(runnerId: string, credential: string, attemptId: string, rawInput: unknown) {
    return this.executions.complete(
      runnerId,
      credential,
      attemptId,
      completeAttemptInputSchema.parse(rawInput),
    );
  }

  reconcile(runnerId: string, credential: string, rawInput: unknown) {
    return this.executions.reconcile(
      runnerId,
      credential,
      reconcileAttemptsInputSchema.parse(rawInput),
    );
  }

  uploadLogs(runnerId: string, credential: string, attemptId: string, rawInput: unknown) {
    return this.executions.uploadLogs(
      runnerId,
      credential,
      attemptId,
      uploadLogChunksInputSchema.parse(rawInput),
    );
  }

  acquireSecrets(runnerId: string, credential: string, attemptId: string, rawInput: unknown) {
    return this.executions.acquireSecrets(
      runnerId,
      credential,
      attemptId,
      acquireAttemptSecretsInputSchema.parse(rawInput),
    );
  }

  declareArtifacts(runnerId: string, credential: string, attemptId: string, rawInput: unknown) {
    return this.executions.declareArtifacts(
      runnerId,
      credential,
      attemptId,
      declareArtifactsInputSchema.parse(rawInput),
    );
  }

  negotiate(protocolVersion: number): { schemaVersion: 1 } {
    if (protocolVersion !== RUNNER_PROTOCOL_VERSION) {
      throw new DomainError(
        "RUNNER_PROTOCOL_UNSUPPORTED",
        `仅支持 Runner Protocol v${RUNNER_PROTOCOL_VERSION}。`,
      );
    }
    return { schemaVersion: RUNNER_PROTOCOL_VERSION };
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
