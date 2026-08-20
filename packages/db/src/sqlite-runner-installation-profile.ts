import type {
  RunnerInstallationProfileRecord,
  RunnerInstallationProfileRepository,
} from "@autoforge/application";
import { and, desc, eq, isNull } from "drizzle-orm";

import type { SqliteDatabaseHandle } from "./database";
import { runnerInstallationProfiles } from "./schema";

export class SqliteRunnerInstallationProfileRepository implements RunnerInstallationProfileRepository {
  constructor(private readonly handle: SqliteDatabaseHandle) {}

  async list(limit: number): Promise<RunnerInstallationProfileRecord[]> {
    return this.handle.db
      .select()
      .from(runnerInstallationProfiles)
      .orderBy(desc(runnerInstallationProfiles.updatedAt))
      .limit(limit)
      .all()
      .map(mapProfile);
  }

  async get(profileId: string): Promise<RunnerInstallationProfileRecord | null> {
    const row = this.handle.db
      .select()
      .from(runnerInstallationProfiles)
      .where(eq(runnerInstallationProfiles.id, profileId))
      .get();
    return row ? mapProfile(row) : null;
  }

  async findByRunnerId(runnerId: string): Promise<RunnerInstallationProfileRecord | null> {
    const row = this.handle.db
      .select()
      .from(runnerInstallationProfiles)
      .where(eq(runnerInstallationProfiles.runnerId, runnerId))
      .get();
    return row ? mapProfile(row) : null;
  }

  async findPendingByRunnerName(
    runnerName: string,
  ): Promise<RunnerInstallationProfileRecord | null> {
    const row = this.handle.db
      .select()
      .from(runnerInstallationProfiles)
      .where(
        and(
          eq(runnerInstallationProfiles.runnerName, runnerName),
          isNull(runnerInstallationProfiles.runnerId),
        ),
      )
      .orderBy(desc(runnerInstallationProfiles.updatedAt))
      .limit(1)
      .get();
    return row ? mapProfile(row) : null;
  }

  async upsert(record: RunnerInstallationProfileRecord): Promise<RunnerInstallationProfileRecord> {
    const row = this.handle.db
      .insert(runnerInstallationProfiles)
      .values(record)
      .onConflictDoUpdate({
        target: runnerInstallationProfiles.id,
        set: {
          runnerId: record.runnerId ?? null,
          runnerName: record.runnerName,
          connectionEncrypted: record.connectionEncrypted,
          expectedHostKeySha256: record.expectedHostKeySha256,
          installationMode: record.installationMode,
          runAsRoot: record.runAsRoot,
          dataDirectory: record.dataDirectory ?? null,
          updatedAt: record.updatedAt,
        },
      })
      .returning()
      .get();
    return mapProfile(row);
  }

  async bindPending(input: {
    runnerName: string;
    runnerId: string;
    updatedAt: string;
  }): Promise<void> {
    this.handle.client.transaction(() => {
      const pending = this.handle.db
        .select({ id: runnerInstallationProfiles.id })
        .from(runnerInstallationProfiles)
        .where(
          and(
            eq(runnerInstallationProfiles.runnerName, input.runnerName),
            isNull(runnerInstallationProfiles.runnerId),
          ),
        )
        .orderBy(desc(runnerInstallationProfiles.updatedAt))
        .limit(1)
        .get();
      if (!pending) return;
      this.handle.db
        .update(runnerInstallationProfiles)
        .set({ runnerId: input.runnerId, updatedAt: input.updatedAt })
        .where(eq(runnerInstallationProfiles.id, pending.id))
        .run();
    })();
  }
}

function mapProfile(
  row: typeof runnerInstallationProfiles.$inferSelect,
): RunnerInstallationProfileRecord {
  return {
    id: row.id,
    ...(row.runnerId ? { runnerId: row.runnerId } : {}),
    runnerName: row.runnerName,
    connectionEncrypted: row.connectionEncrypted,
    expectedHostKeySha256: row.expectedHostKeySha256,
    installationMode: row.installationMode,
    runAsRoot: row.runAsRoot,
    ...(row.dataDirectory ? { dataDirectory: row.dataDirectory } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
