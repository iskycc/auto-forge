import type { AttemptLogShareRepository } from "@autoforge/application";
import { describe, expect, it } from "vitest";

/**
 * 日志公开访问仓储的适配器契约：SQLite 与 PostgreSQL 共用同一组断言，
 * 覆盖批量插入原子性与批量查询的“每个 attempt 最新有效记录”语义。
 * 工厂需预置 fixture：batchId 与两条已授权 attempt（attemptIds）。
 */
export type AttemptLogShareHarness = {
  repository: AttemptLogShareRepository;
  fixture: { batchId: string; attemptIds: readonly [string, string] };
  dispose(): Promise<void>;
};

type HarnessFactory = () => Promise<AttemptLogShareHarness>;

const ACTIVE_EXPIRY = "2026-09-16T00:00:00.000Z";
const REFERENCE_TIME = "2026-08-17T04:00:00.000Z";

async function withHarness(
  createHarness: HarnessFactory,
  run: (harness: AttemptLogShareHarness) => Promise<void>,
): Promise<void> {
  const harness = await createHarness();
  try {
    await run(harness);
  } finally {
    await harness.dispose();
  }
}

export function attemptLogShareContract(adapterName: string, createHarness: HarnessFactory): void {
  describe(`${adapterName} contract`, () => {
    it("createMany writes every record and findActiveByAttemptIds returns the newest active share per attempt", async () => {
      await withHarness(createHarness, async ({ repository, fixture }) => {
        const [firstAttemptId, secondAttemptId] = fixture.attemptIds;
        await repository.createMany([
          shareRecord(fixture, { id: "share-old", tokenHash: "hash-old" }),
          shareRecord(fixture, {
            id: "share-new",
            tokenHash: "hash-new",
            createdAt: "2026-08-17T01:00:00.000Z",
          }),
          shareRecord(fixture, {
            id: "share-expired",
            tokenHash: "hash-expired",
            attemptId: secondAttemptId,
            createdAt: "2026-08-17T02:00:00.000Z",
            expiresAt: "2026-08-17T03:00:00.000Z",
          }),
          shareRecord(fixture, {
            id: "share-active",
            tokenHash: "hash-active",
            attemptId: secondAttemptId,
            createdAt: "2026-08-17T01:30:00.000Z",
          }),
        ]);

        const active = await repository.findActiveByAttemptIds(
          [firstAttemptId, secondAttemptId, "attempt-missing"],
          REFERENCE_TIME,
        );
        // 失效记录与不存在的 attempt 不出现；每个 attempt 只保留最新一条。
        const byAttempt = new Map(active.map((share) => [share.attemptId, share.id]));
        expect(byAttempt.size).toBe(2);
        expect(byAttempt.get(firstAttemptId)).toBe("share-new");
        expect(byAttempt.get(secondAttemptId)).toBe("share-active");
      });
    });

    it("breaks createdAt ties by id, matching the single-attempt lookup", async () => {
      await withHarness(createHarness, async ({ repository, fixture }) => {
        await repository.createMany([
          shareRecord(fixture, { id: "share-a", tokenHash: "hash-a" }),
          shareRecord(fixture, { id: "share-b", tokenHash: "hash-b" }),
        ]);
        const [firstAttemptId] = fixture.attemptIds;
        const [active] = await repository.findActiveByAttemptIds([firstAttemptId], REFERENCE_TIME);
        expect(active?.id).toBe("share-b");
        const single = await repository.findActiveByAttemptId(firstAttemptId, REFERENCE_TIME);
        expect(single?.id).toBe("share-b");
      });
    });

    it("rolls back the whole batch when one record conflicts", async () => {
      await withHarness(createHarness, async ({ repository, fixture }) => {
        const [firstAttemptId] = fixture.attemptIds;
        await expect(
          repository.createMany([
            shareRecord(fixture, { id: "share-keep", tokenHash: "hash-keep" }),
            shareRecord(fixture, { id: "share-conflict", tokenHash: "hash-keep" }),
          ]),
        ).rejects.toThrow();
        // 事务整体回滚：第一条也不应可见。
        expect(await repository.findActiveByAttemptIds([firstAttemptId], REFERENCE_TIME)).toEqual(
          [],
        );
      });
    });

    it("treats empty inputs as no-ops", async () => {
      await withHarness(createHarness, async ({ repository }) => {
        await repository.createMany([]);
        await expect(repository.findActiveByAttemptIds([], REFERENCE_TIME)).resolves.toEqual([]);
      });
    });
  });
}

function shareRecord(
  fixture: AttemptLogShareHarness["fixture"],
  overrides: Partial<{
    id: string;
    tokenHash: string;
    attemptId: string;
    createdAt: string;
    expiresAt: string;
  }>,
) {
  return {
    id: "share-1",
    tokenHash: "hash-1",
    attemptId: fixture.attemptIds[0],
    batchId: fixture.batchId,
    createdBy: "user-1",
    createdAt: "2026-08-17T00:00:00.000Z",
    expiresAt: ACTIVE_EXPIRY,
    ...overrides,
  };
}
