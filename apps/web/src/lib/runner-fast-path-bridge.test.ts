import { beforeEach, describe, expect, it, vi } from "vitest";
import { renewLeaseInputSchema } from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import {
  registerRunnerFastPathBridge,
  type RunnerFastPathContext,
} from "./runner-fast-path-bridge";

const calls = vi.hoisted(() => ({ allow: vi.fn(), renew: vi.fn() }));
vi.mock("./services", () => ({
  getPlatformServices: async () => ({
    runnerRequestLimiter: { allow: calls.allow },
    runnerProtocol: { renewLease: calls.renew },
  }),
}));

const runtime = globalThis as typeof globalThis & {
  __autoforgeRunnerFastPath?: {
    dispatch(
      route: { kind: "renew-lease"; runnerId: string; leaseId: string },
      context: RunnerFastPathContext,
    ): Promise<{ status: number; payload: unknown }>;
  };
};
const route = { kind: "renew-lease" as const, runnerId: "runner", leaseId: "lease" };
const input = {
  schemaVersion: 1,
  requestId: "request",
  leaseToken: "a".repeat(32),
  leaseVersion: 2,
};
function context(
  rawBody: Buffer | null = Buffer.from(JSON.stringify(input)),
): RunnerFastPathContext {
  return {
    rawBody,
    bearerToken: "runner-credential",
    runnerIdHeader: null,
    requestId: "http-request",
  };
}
beforeEach(() => {
  calls.allow.mockReset().mockResolvedValue(true);
  calls.renew.mockReset().mockImplementation(async (_runnerId, _credential, _leaseId, value) => ({
    ...renewLeaseInputSchema.parse(value),
    instruction: "continue",
  }));
  registerRunnerFastPathBridge();
});

describe("lease renewal fast path preserves protocol boundaries", () => {
  it("uses the same Runner identity, credential, lease input and limiter as the Route Handler", async () => {
    expect(await runtime.__autoforgeRunnerFastPath!.dispatch(route, context())).toMatchObject({
      status: 200,
      payload: { instruction: "continue", leaseVersion: 2 },
    });
    expect(calls.renew).toHaveBeenCalledWith("runner", "runner-credential", "lease", input);
    expect(calls.allow).toHaveBeenCalledWith("runner:lease:v1:runner", 600, 60_000);
  });
  it("rejects rate limiting and oversized bodies before renewing any lease", async () => {
    calls.allow.mockResolvedValue(false);
    expect(await runtime.__autoforgeRunnerFastPath!.dispatch(route, context())).toMatchObject({
      status: 429,
    });
    expect(await runtime.__autoforgeRunnerFastPath!.dispatch(route, context(null))).toMatchObject({
      status: 413,
    });
    expect(calls.renew).not.toHaveBeenCalled();
  });
  it("keeps strict JSON and protocol validation and the standard requestId error envelope", async () => {
    expect(
      await runtime.__autoforgeRunnerFastPath!.dispatch(route, context(Buffer.from("{"))),
    ).toMatchObject({
      status: 400,
      payload: { error: { code: "INVALID_JSON", requestId: "http-request" } },
    });
    expect(
      await runtime.__autoforgeRunnerFastPath!.dispatch(route, context(Buffer.from("{}"))),
    ).toMatchObject({
      status: 400,
      payload: { error: { code: "VALIDATION_FAILED", requestId: "http-request" } },
    });
  });
  it.each([
    ["LEASE_AUTH_REJECTED", 401],
    ["LEASE_EXPIRED", 409],
    ["LEASE_VERSION_CONFLICT", 409],
  ] as const)("retains %s as HTTP %i", async (code, status) => {
    calls.renew.mockRejectedValue(new DomainError(code, "Rejected renewal"));
    expect(await runtime.__autoforgeRunnerFastPath!.dispatch(route, context())).toMatchObject({
      status,
      payload: { error: { code, requestId: "http-request" } },
    });
  });
});
