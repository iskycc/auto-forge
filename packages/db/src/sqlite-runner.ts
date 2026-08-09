import type { RegisterRunnerRecord, RunnerRepository } from "@autoforge/application";
import type { Runner } from "@autoforge/domain";
import { desc, eq } from "drizzle-orm";

import type { SqliteDatabaseHandle } from "./database";
import { mapStoredRunner } from "./runner-mapper";
import { runnerBootstrapUses, runners } from "./schema";

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
          draining: false,
          os: record.os,
          architecture: record.architecture,
          agentVersion: record.agentVersion,
          protocolVersion: record.protocolVersion,
          labelsJson: JSON.stringify(record.labels),
          capabilitiesJson: JSON.stringify(record.capabilities),
          maxConcurrency: record.maxConcurrency,
          busySlots: 0,
          lastSeenAt: record.recordedAt,
          terminalEnabled: record.terminalEnabled,
          createdAt: record.recordedAt,
          updatedAt: record.recordedAt,
        })
        .returning()
        .get();
      return mapStoredRunner(row);
    })();
  }

  async findByCredentialHash(credentialHash: string): Promise<Runner | null> {
    const row = this.handle.db
      .select()
      .from(runners)
      .where(eq(runners.credentialHash, credentialHash))
      .get();
    return row ? mapStoredRunner(row) : null;
  }

  async heartbeat(input: {
    runnerId: string;
    labels: string[];
    capabilities: string[];
    maxConcurrency: number;
    busySlots: number;
    agentVersion: string;
    terminalEnabled: boolean;
    resourceSnapshot?: {
      cpuUtilizationPercent: number;
      memoryUtilizationPercent: number;
      loadAverage1m: number;
      logicalCpuCount: number;
      observedAt: string;
    };
    recordedAt: string;
  }): Promise<Runner> {
    const row = this.handle.db
      .update(runners)
      .set({
        labelsJson: JSON.stringify(input.labels),
        capabilitiesJson: JSON.stringify(input.capabilities),
        maxConcurrency: input.maxConcurrency,
        busySlots: input.busySlots,
        agentVersion: input.agentVersion,
        terminalEnabled: input.terminalEnabled,
        ...(input.resourceSnapshot
          ? {
              cpuUtilizationPercent: input.resourceSnapshot.cpuUtilizationPercent,
              memoryUtilizationPercent: input.resourceSnapshot.memoryUtilizationPercent,
              loadAverage1m: input.resourceSnapshot.loadAverage1m,
              logicalCpuCount: input.resourceSnapshot.logicalCpuCount,
              metricsObservedAt: input.resourceSnapshot.observedAt,
            }
          : {}),
        lastSeenAt: input.recordedAt,
        updatedAt: input.recordedAt,
      })
      .where(eq(runners.id, input.runnerId))
      .returning()
      .get();
    if (!row) throw new Error(`Runner ${input.runnerId} does not exist.`);
    return mapStoredRunner(row);
  }

  async list(offlineBefore: string, limit: number): Promise<Runner[]> {
    return this.handle.db
      .select()
      .from(runners)
      .orderBy(desc(runners.lastSeenAt))
      .limit(limit)
      .all()
      .map((row) => mapStoredRunner(row, offlineBefore));
  }

  async get(runnerId: string, offlineBefore: string): Promise<Runner | null> {
    const row = this.handle.db.select().from(runners).where(eq(runners.id, runnerId)).get();
    return row ? mapStoredRunner(row, offlineBefore) : null;
  }

  async setLifecycleState(input: {
    runnerId: string;
    state: "active" | "draining" | "disabled";
    updatedAt: string;
  }): Promise<Runner> {
    const row = this.handle.db
      .update(runners)
      .set({
        disabled: input.state === "disabled",
        draining: input.state === "draining",
        updatedAt: input.updatedAt,
      })
      .where(eq(runners.id, input.runnerId))
      .returning()
      .get();
    if (!row) throw new Error(`Runner ${input.runnerId} does not exist.`);
    return mapStoredRunner(row);
  }
}
