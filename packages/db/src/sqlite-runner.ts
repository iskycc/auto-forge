import type { RegisterRunnerRecord, RunnerRepository } from "@autoforge/application";
import type { Runner } from "@autoforge/domain";
import { desc, eq } from "drizzle-orm";

import type { SqliteDatabaseHandle } from "./database";
import { runnerBootstrapUses, runners } from "./schema";

function labels(json: string): string[] {
  const parsed: unknown = JSON.parse(json);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}

function toRunner(row: typeof runners.$inferSelect, offlineBefore?: string): Runner {
  const state = row.disabled
    ? "disabled"
    : offlineBefore && row.lastSeenAt < offlineBefore
      ? "offline"
      : "online";
  return {
    id: row.id,
    name: row.name,
    state,
    os: row.os,
    architecture: row.architecture,
    agentVersion: row.agentVersion,
    protocolVersion: row.protocolVersion,
    labels: labels(row.labelsJson),
    maxConcurrency: row.maxConcurrency,
    busySlots: row.busySlots,
    lastSeenAt: row.lastSeenAt,
    terminalEnabled: row.terminalEnabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class SqliteRunnerRepository implements RunnerRepository {
  constructor(private readonly handle: SqliteDatabaseHandle) {}

  async register(record: RegisterRunnerRecord): Promise<Runner | null> {
    return this.handle.client.transaction(() => {
      const use = this.handle.db
        .insert(runnerBootstrapUses)
        .values({ tokenHash: record.bootstrapTokenHash, usedAt: record.recordedAt })
        .onConflictDoNothing()
        .run();
      if (use.changes === 0) return null;
      const row = this.handle.db
        .insert(runners)
        .values({
          id: record.id,
          credentialHash: record.credentialHash,
          name: record.name,
          disabled: false,
          os: record.os,
          architecture: record.architecture,
          agentVersion: record.agentVersion,
          protocolVersion: record.protocolVersion,
          labelsJson: JSON.stringify(record.labels),
          maxConcurrency: record.maxConcurrency,
          busySlots: 0,
          lastSeenAt: record.recordedAt,
          terminalEnabled: record.terminalEnabled,
          createdAt: record.recordedAt,
          updatedAt: record.recordedAt,
        })
        .returning()
        .get();
      return toRunner(row);
    })();
  }

  async findByCredentialHash(credentialHash: string): Promise<Runner | null> {
    const row = this.handle.db
      .select()
      .from(runners)
      .where(eq(runners.credentialHash, credentialHash))
      .get();
    return row ? toRunner(row) : null;
  }

  async heartbeat(input: {
    runnerId: string;
    labels: string[];
    maxConcurrency: number;
    busySlots: number;
    agentVersion: string;
    terminalEnabled: boolean;
    recordedAt: string;
  }): Promise<Runner> {
    const row = this.handle.db
      .update(runners)
      .set({
        labelsJson: JSON.stringify(input.labels),
        maxConcurrency: input.maxConcurrency,
        busySlots: input.busySlots,
        agentVersion: input.agentVersion,
        terminalEnabled: input.terminalEnabled,
        lastSeenAt: input.recordedAt,
        updatedAt: input.recordedAt,
      })
      .where(eq(runners.id, input.runnerId))
      .returning()
      .get();
    if (!row) throw new Error(`Runner ${input.runnerId} does not exist.`);
    return toRunner(row);
  }

  async list(offlineBefore: string, limit: number): Promise<Runner[]> {
    return this.handle.db
      .select()
      .from(runners)
      .orderBy(desc(runners.lastSeenAt))
      .limit(limit)
      .all()
      .map((row) => toRunner(row, offlineBefore));
  }

  async get(runnerId: string, offlineBefore: string): Promise<Runner | null> {
    const row = this.handle.db.select().from(runners).where(eq(runners.id, runnerId)).get();
    return row ? toRunner(row, offlineBefore) : null;
  }
}
