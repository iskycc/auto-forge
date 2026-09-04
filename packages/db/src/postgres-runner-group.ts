import type { RunnerGroupRepository } from "@autoforge/application";
import type { RunnerGroup } from "@autoforge/domain";
import type { PoolClient } from "pg";

import type { PostgresDatabaseHandle } from "./postgres-database";

type RunnerGroupRow = {
  id: string;
  name: string;
  description: string;
  revision: number;
  created_at: string;
  updated_at: string;
  runner_ids: string[] | null;
};

export class PostgresRunnerGroupRepository implements RunnerGroupRepository {
  constructor(private readonly handle: PostgresDatabaseHandle) {}

  async list(limit?: number): Promise<RunnerGroup[]> {
    await this.handle.ready;
    const normalizedLimit = limit === undefined ? undefined : runnerGroupListLimit(limit);
    const result = await this.handle.pool.query<RunnerGroupRow>(
      normalizedLimit === undefined
        ? runnerGroupSelect()
        : `WITH selected_groups AS (
             SELECT * FROM runner_groups ORDER BY name, id LIMIT $1
           )
           ${runnerGroupSelect("", "selected_groups")}`,
      normalizedLimit === undefined ? [] : [normalizedLimit],
    );
    return result.rows.map(mapRunnerGroup);
  }

  async get(groupId: string): Promise<RunnerGroup | null> {
    await this.handle.ready;
    const result = await this.handle.pool.query<RunnerGroupRow>(
      runnerGroupSelect("WHERE g.id = $1"),
      [groupId],
    );
    return result.rows[0] ? mapRunnerGroup(result.rows[0]) : null;
  }

  async create(input: {
    id: string;
    name: string;
    normalizedName: string;
    description: string;
    runnerIds: string[];
    recordedAt: string;
  }): Promise<RunnerGroup> {
    await this.handle.ready;
    const client = await this.handle.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO runner_groups
          (id, name, normalized_name, description, revision, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 1, $5, $5)`,
        [input.id, input.name, input.normalizedName, input.description, input.recordedAt],
      );
      await replaceMembers(client, input.id, input.runnerIds, input.recordedAt);
      const group = await getRunnerGroup(client, input.id);
      await client.query("COMMIT");
      if (!group) throw new Error(`Runner group ${input.id} was not created.`);
      return group;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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
    await this.handle.ready;
    const client = await this.handle.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ id: string }>(
        `UPDATE runner_groups SET
           name = COALESCE($1, name),
           normalized_name = COALESCE($2, normalized_name),
           description = COALESCE($3, description),
           revision = revision + 1,
           updated_at = $4
         WHERE id = $5 AND revision = $6
         RETURNING id`,
        [
          input.name ?? null,
          input.normalizedName ?? null,
          input.description ?? null,
          input.updatedAt,
          input.groupId,
          input.expectedRevision,
        ],
      );
      if (result.rowCount === 0) {
        await client.query("ROLLBACK");
        return null;
      }
      if (input.runnerIds) {
        await replaceMembers(client, input.groupId, input.runnerIds, input.updatedAt);
      }
      const group = await getRunnerGroup(client, input.groupId);
      await client.query("COMMIT");
      return group;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async delete(groupId: string): Promise<boolean> {
    await this.handle.ready;
    const result = await this.handle.pool.query("DELETE FROM runner_groups WHERE id = $1", [
      groupId,
    ]);
    return (result.rowCount ?? 0) > 0;
  }
}

function runnerGroupSelect(whereClause = "", groupTable = "runner_groups"): string {
  return `SELECT
      g.id,
      g.name,
      g.description,
      g.revision,
      g.created_at,
      g.updated_at,
      COALESCE(
        array_agg(m.runner_id ORDER BY m.runner_id) FILTER (WHERE r.id IS NOT NULL),
        ARRAY[]::text[]
      ) AS runner_ids
    FROM ${groupTable} g
    LEFT JOIN runner_group_members m ON m.group_id = g.id
    LEFT JOIN runners r ON r.id = m.runner_id AND r.purged_at IS NULL
    ${whereClause}
    GROUP BY g.id, g.name, g.description, g.revision, g.created_at, g.updated_at
    ORDER BY g.name, g.id`;
}

function runnerGroupListLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new Error("Runner group list limit must be an integer from 1 to 1000.");
  }
  return value;
}

async function getRunnerGroup(client: PoolClient, groupId: string): Promise<RunnerGroup | null> {
  const result = await client.query<RunnerGroupRow>(runnerGroupSelect("WHERE g.id = $1"), [
    groupId,
  ]);
  return result.rows[0] ? mapRunnerGroup(result.rows[0]) : null;
}

async function replaceMembers(
  client: PoolClient,
  groupId: string,
  runnerIds: readonly string[],
  addedAt: string,
): Promise<void> {
  await client.query("DELETE FROM runner_group_members WHERE group_id = $1", [groupId]);
  if (runnerIds.length === 0) return;
  await client.query(
    `INSERT INTO runner_group_members (group_id, runner_id, added_at)
     SELECT $1, runner_id, $3
     FROM unnest($2::text[]) AS runner_id`,
    [groupId, runnerIds, addedAt],
  );
}

function mapRunnerGroup(row: RunnerGroupRow): RunnerGroup {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    runnerIds: row.runner_ids ?? [],
    revision: Number(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
