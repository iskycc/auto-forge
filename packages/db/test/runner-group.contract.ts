import type { RunnerGroupRepository } from "@autoforge/application";
import { describe, expect, it } from "vitest";

export type RunnerGroupHarness = {
  repository: RunnerGroupRepository;
  runnerIds: readonly [string, string];
  purgeRunner(runnerId: string): Promise<void>;
  dispose(): Promise<void>;
};

type HarnessFactory = () => Promise<RunnerGroupHarness>;

const CREATED_AT = "2026-08-20T00:00:00.000Z";
const UPDATED_AT = "2026-08-20T00:05:00.000Z";

async function withHarness(
  createHarness: HarnessFactory,
  run: (harness: RunnerGroupHarness) => Promise<void>,
): Promise<void> {
  const harness = await createHarness();
  try {
    await run(harness);
  } finally {
    await harness.dispose();
  }
}

export function runnerGroupContract(adapterName: string, createHarness: HarnessFactory): void {
  describe(`${adapterName} contract`, () => {
    it("creates, lists and updates a group with stable member ordering", async () => {
      await withHarness(createHarness, async ({ repository, runnerIds }) => {
        const [runnerA, runnerB] = runnerIds;
        const created = await repository.create({
          id: "group-1",
          name: "华东执行池",
          normalizedName: "华东执行池",
          description: "首选资源池",
          runnerIds: [runnerB, runnerA],
          recordedAt: CREATED_AT,
        });
        expect(created).toMatchObject({
          id: "group-1",
          runnerIds: [runnerA, runnerB],
          revision: 1,
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
        });
        expect(await repository.list()).toEqual([created]);

        const updated = await repository.update({
          groupId: "group-1",
          expectedRevision: 1,
          name: "华东核心池",
          normalizedName: "华东核心池",
          description: "仅保留一台",
          runnerIds: [runnerB],
          updatedAt: UPDATED_AT,
        });
        expect(updated).toMatchObject({
          name: "华东核心池",
          description: "仅保留一台",
          runnerIds: [runnerB],
          revision: 2,
          createdAt: CREATED_AT,
          updatedAt: UPDATED_AT,
        });

        await expect(
          repository.update({
            groupId: "group-1",
            expectedRevision: 1,
            description: "过期写入",
            updatedAt: UPDATED_AT,
          }),
        ).resolves.toBeNull();
        expect(await repository.get("group-1")).toEqual(updated);
      });
    });

    it("enforces normalized-name uniqueness and supports empty groups", async () => {
      await withHarness(createHarness, async ({ repository }) => {
        await repository.create({
          id: "group-1",
          name: "资源池 A",
          normalizedName: "pool-a",
          description: "",
          runnerIds: [],
          recordedAt: CREATED_AT,
        });
        await expect(
          repository.create({
            id: "group-2",
            name: "资源池 A 的重复名称",
            normalizedName: "pool-a",
            description: "",
            runnerIds: [],
            recordedAt: CREATED_AT,
          }),
        ).rejects.toThrow();
        expect(await repository.get("group-1")).toMatchObject({ runnerIds: [] });
      });
    });

    it("limits list reads before loading group members", async () => {
      await withHarness(createHarness, async ({ repository }) => {
        await repository.create({
          id: "group-b",
          name: "资源池 B",
          normalizedName: "pool-b",
          description: "",
          runnerIds: [],
          recordedAt: CREATED_AT,
        });
        await repository.create({
          id: "group-a",
          name: "资源池 A",
          normalizedName: "pool-a",
          description: "",
          runnerIds: [],
          recordedAt: CREATED_AT,
        });

        await expect(repository.list(1)).resolves.toMatchObject([{ id: "group-a" }]);
      });
    });

    it("hides purged members and deletes groups idempotently", async () => {
      await withHarness(createHarness, async ({ repository, runnerIds, purgeRunner }) => {
        await repository.create({
          id: "group-1",
          name: "可清理资源池",
          normalizedName: "deletable-pool",
          description: "",
          runnerIds: [...runnerIds],
          recordedAt: CREATED_AT,
        });
        await purgeRunner(runnerIds[0]);
        expect(await repository.get("group-1")).toMatchObject({ runnerIds: [runnerIds[1]] });
        await expect(repository.delete("group-1")).resolves.toBe(true);
        await expect(repository.delete("group-1")).resolves.toBe(false);
        await expect(repository.get("group-1")).resolves.toBeNull();
      });
    });
  });
}
