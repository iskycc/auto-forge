import type { ExecutionControlService } from "@autoforge/application";
import { DomainError } from "@autoforge/domain";
import { describe, expect, it, vi } from "vitest";

import { RunnerProtocolController } from "../src/index";

describe("Runner Protocol compatibility", () => {
  it("accepts additive optional fields from the next Agent patch release", async () => {
    const claim = vi.fn(async (_runnerId, _credential, input) => ({
      schemaVersion: 1 as const,
      requestId: input.requestId,
      assignments: [],
      retryAfterMs: 1_000,
    }));
    const controller = new RunnerProtocolController({
      claim,
    } as unknown as ExecutionControlService);

    await expect(
      controller.claim("runner-1", "credential", {
        schemaVersion: 1,
        requestId: "request-next-patch",
        availableSlots: 1,
        waitSeconds: 0,
        labels: [],
        capabilities: [],
        optionalPatchField: "ignored-by-v1-server",
      }),
    ).resolves.toMatchObject({
      schemaVersion: 1,
      requestId: "request-next-patch",
      closedBatchIds: [],
    });

    expect(claim).toHaveBeenCalledWith(
      "runner-1",
      "credential",
      expect.not.objectContaining({ optionalPatchField: expect.anything() }),
    );
  });

  it.each([0, 2])("rejects incompatible schema version %i during negotiation", (version) => {
    const controller = new RunnerProtocolController({} as ExecutionControlService);

    try {
      controller.negotiate(version);
      throw new Error("expected protocol negotiation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe("RUNNER_PROTOCOL_UNSUPPORTED");
    }
  });

  it("negotiates the current schema version", () => {
    const controller = new RunnerProtocolController({} as ExecutionControlService);

    expect(controller.negotiate(1)).toEqual({ schemaVersion: 1 });
  });
});
