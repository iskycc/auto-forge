import type { RunnerGroupRepository } from "@autoforge/application";
import type { RunnerGroup } from "@autoforge/domain";
import { and, asc, eq, isNull, sql } from "drizzle-orm";

import type { SqliteDatabaseHandle } from "./database";
import { runnerGroupMembers, runnerGroups, runners } from "./schema";

export class SqliteRunnerGroupRepository implements RunnerGroupRepository {
  constructor(private readonly handle: SqliteDatabaseHandle) {}

  async list(limit?: number): Promise<RunnerGroup[]> {
    const query = this.handle.db
      .select()
      .from(runnerGroups)
      .orderBy(asc(runnerGroups.name), asc(runnerGroups.id));
    const rows = limit === undefined ? query.all() : query.limit(runnerGroupListLimit(limit)).all();
    return rows.map((row) => this.mapGroup(row));
  }

  async get(groupId: string): Promise<RunnerGroup | null> {
    const row = this.handle.db
      .select()
      .from(runnerGroups)
      .where(eq(runnerGroups.id, groupId))
      .get();
    return row ? this.mapGroup(row) : null;
  }

  async create(input: {
    id: string;
    name: string;
    normalizedName: string;
    description: string;
    runnerIds: string[];
    recordedAt: string;
  }): Promise<RunnerGroup> {
    return this.handle.client.transaction(() => {
      const row = this.handle.db
        .insert(runnerGroups)
        .values({
          id: input.id,
          name: input.name,
          normalizedName: input.normalizedName,
          description: input.description,
          revision: 1,
          createdAt: input.recordedAt,
          updatedAt: input.recordedAt,
        })
        .returning()
        .get();
      this.replaceMembers(input.id, input.runnerIds, input.recordedAt);
      return this.mapGroup(row);
    })();
  }

  async update(input: {
    groupId: string;
    expectedRevision: number;
    name?: string;
    normalizedName?: string;
    description?: string;
    runnerIds?: string[];
    updatedAt: string;
  }): Promise<RunnerGroup | null> {
    return this.handle.client.transaction(() => {
      const row = this.handle.db
        .update(runnerGroups)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.normalizedName !== undefined ? { normalizedName: input.normalizedName } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          revision: sql`${runnerGroups.revision} + 1`,
          updatedAt: input.updatedAt,
        })
        .where(
          and(
            eq(runnerGroups.id, input.groupId),
            eq(runnerGroups.revision, input.expectedRevision),
          ),
        )
        .returning()
        .get();
      if (!row) return null;
      if (input.runnerIds) this.replaceMembers(input.groupId, input.runnerIds, input.updatedAt);
      return this.mapGroup(row);
    })();
  }

  async delete(groupId: string): Promise<boolean> {
    return (
      this.handle.db.delete(runnerGroups).where(eq(runnerGroups.id, groupId)).run().changes > 0
    );
  }

  private replaceMembers(groupId: string, runnerIds: readonly string[], addedAt: string): void {
    this.handle.db.delete(runnerGroupMembers).where(eq(runnerGroupMembers.groupId, groupId)).run();
    if (runnerIds.length === 0) return;
    this.handle.db
      .insert(runnerGroupMembers)
      .values(runnerIds.map((runnerId) => ({ groupId, runnerId, addedAt })))
      .run();
  }

  private mapGroup(row: typeof runnerGroups.$inferSelect): RunnerGroup {
    const memberRows = this.handle.db
      .select({ runnerId: runnerGroupMembers.runnerId })
      .from(runnerGroupMembers)
      .innerJoin(runners, eq(runners.id, runnerGroupMembers.runnerId))
      .where(and(eq(runnerGroupMembers.groupId, row.id), isNull(runners.purgedAt)))
      .orderBy(asc(runnerGroupMembers.runnerId))
      .all();
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      runnerIds: memberRows.map(({ runnerId }) => runnerId),
      revision: row.revision,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

function runnerGroupListLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new Error("Runner group list limit must be an integer from 1 to 1000.");
  }
  return value;
}
