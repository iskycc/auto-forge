import {
  createRunnerGroupInputSchema,
  updateRunnerGroupInputSchema,
  type CreateRunnerGroupInput,
  type UpdateRunnerGroupInput,
} from "@autoforge/contracts";
import { DomainError, type RunnerGroup } from "@autoforge/domain";

import type { Clock, IdGenerator, RunnerGroupRepository, RunnerRepository } from "./ports";

export class RunnerGroupService {
  constructor(
    private readonly groups: RunnerGroupRepository,
    private readonly runners: RunnerRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  list(limit?: number): Promise<RunnerGroup[]> {
    return this.groups.list(limit);
  }

  async get(groupId: string): Promise<RunnerGroup> {
    const group = await this.groups.get(groupId);
    if (!group) throw new DomainError("RUNNER_GROUP_NOT_FOUND", "指定的执行机组不存在。");
    return group;
  }

  async create(input: CreateRunnerGroupInput): Promise<RunnerGroup> {
    const validated = createRunnerGroupInputSchema.parse(input);
    await this.assertRunnersExist(validated.runnerIds);
    const recordedAt = this.clock.now().toISOString();
    try {
      return await this.groups.create({
        id: this.ids.next(),
        name: validated.name,
        normalizedName: normalizeRunnerGroupName(validated.name),
        description: validated.description,
        runnerIds: [...validated.runnerIds].sort(),
        recordedAt,
      });
    } catch (error) {
      throw runnerGroupWriteError(error);
    }
  }

  async update(groupId: string, input: UpdateRunnerGroupInput): Promise<RunnerGroup> {
    const validated = updateRunnerGroupInputSchema.parse(input);
    await this.get(groupId);
    if (validated.runnerIds) await this.assertRunnersExist(validated.runnerIds);
    try {
      const updated = await this.groups.update({
        groupId,
        expectedRevision: validated.expectedRevision,
        ...(validated.name
          ? {
              name: validated.name,
              normalizedName: normalizeRunnerGroupName(validated.name),
            }
          : {}),
        ...(validated.description !== undefined ? { description: validated.description } : {}),
        ...(validated.runnerIds ? { runnerIds: [...validated.runnerIds].sort() } : {}),
        updatedAt: this.clock.now().toISOString(),
      });
      if (!updated) {
        throw new DomainError(
          "RUNNER_GROUP_REVISION_CONFLICT",
          "执行机组已被其他操作修改，请刷新后重试。",
        );
      }
      return updated;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw runnerGroupWriteError(error);
    }
  }

  async delete(groupId: string): Promise<void> {
    await this.get(groupId);
    if (!(await this.groups.delete(groupId))) {
      throw new DomainError("RUNNER_GROUP_NOT_FOUND", "指定的执行机组不存在。");
    }
  }

  private async assertRunnersExist(runnerIds: readonly string[]): Promise<void> {
    const offlineBefore = new Date(this.clock.now().getTime() - 45_000).toISOString();
    const runners = await Promise.all(
      runnerIds.map((runnerId) => this.runners.get(runnerId, offlineBefore)),
    );
    if (runners.some((runner) => !runner || runner.purgedAt)) {
      throw new DomainError("RUNNER_NOT_FOUND", "执行机组中包含不存在或已删除的执行机。");
    }
  }
}

function normalizeRunnerGroupName(name: string): string {
  return name.trim().normalize("NFKC").toLocaleLowerCase("zh-CN");
}

function runnerGroupWriteError(error: unknown): DomainError {
  const message = error instanceof Error ? error.message : "";
  const databaseCode =
    error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (
    databaseCode === "23505" ||
    databaseCode === "SQLITE_CONSTRAINT_UNIQUE" ||
    message.includes("runner_groups_normalized_name_uq") ||
    message.includes("runner_groups.normalized_name")
  ) {
    return new DomainError("RUNNER_GROUP_NAME_CONFLICT", "执行机组名称已存在。", {
      cause: error,
    });
  }
  return new DomainError("RUNNER_GROUP_WRITE_FAILED", "保存执行机组失败。", { cause: error });
}
