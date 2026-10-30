import { describe, expect, it, vi } from "vitest";
import { DomainError } from "@autoforge/domain";
import { RunBatchSchedulingService } from "../src/schedule-run-batches";
import type { CaseSuiteRepository, RunBatchRepository, RunnerRepository } from "../src/ports";
import type { CreateSingleCaseRunInput } from "@autoforge/contracts";

describe("execution log admission", () => {
  it.each(["task", "single"] as const)(
    "rejects %s execution before loading or persisting a batch when Full has no log server",
    async (entry) => {
      const batches = { create: vi.fn() };
      const suites = { get: vi.fn() };
      const admission = {
        requireWriteTarget: vi
          .fn()
          .mockRejectedValue(new DomainError("LOG_DAILY_SERVER_REQUIRED", "请配置日志服务器")),
      };
      const service = new RunBatchSchedulingService(
        batches as unknown as RunBatchRepository,
        suites as unknown as CaseSuiteRepository,
        {} as RunnerRepository,
        { now: () => new Date(0) },
        { next: () => "id" },
        {
          maximumCpuUtilizationPercent: 90,
          maximumMemoryUtilizationPercent: 90,
          maximumLoadPerCpu: 2,
        },
        45,
        undefined,
        128,
        5,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        admission,
      );
      const result =
        entry === "task"
          ? service.create({ suiteId: "suite" })
          : service.createSingleCase("case", {} as CreateSingleCaseRunInput);
      await expect(result).rejects.toMatchObject({ code: "LOG_DAILY_SERVER_REQUIRED" });
      expect(batches.create).not.toHaveBeenCalled();
      expect(suites.get).not.toHaveBeenCalled();
      expect(admission.requireWriteTarget).toHaveBeenCalledOnce();
    },
  );
});
