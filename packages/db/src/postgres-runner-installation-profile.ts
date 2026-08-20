import type {
  RunnerInstallationProfileRecord,
  RunnerInstallationProfileRepository,
} from "@autoforge/application";
import { and, desc, eq, isNull } from "drizzle-orm";

import type { PostgresDatabaseHandle } from "./postgres-database";
import { pgRunnerInstallationProfiles } from "./postgres-schema";

export class PostgresRunnerInstallationProfileRepository implements RunnerInstallationProfileRepository {
  constructor(private readonly handle: PostgresDatabaseHandle) {}

  private async ready(): Promise<void> {
    await this.handle.ready;
  }

  async list(limit: number): Promise<RunnerInstallationProfileRecord[]> {
    await this.ready();
    return (
      await this.handle.db
        .select()
        .from(pgRunnerInstallationProfiles)
        .orderBy(desc(pgRunnerInstallationProfiles.updatedAt))
        .limit(limit)
    ).map(mapProfile);
  }

  async get(profileId: string): Promise<RunnerInstallationProfileRecord | null> {
    await this.ready();
    const [row] = await this.handle.db
      .select()
      .from(pgRunnerInstallationProfiles)
      .where(eq(pgRunnerInstallationProfiles.id, profileId))
      .limit(1);
    return row ? mapProfile(row) : null;
  }

  async findByRunnerId(runnerId: string): Promise<RunnerInstallationProfileRecord | null> {
    await this.ready();
    const [row] = await this.handle.db
      .select()
      .from(pgRunnerInstallationProfiles)
      .where(eq(pgRunnerInstallationProfiles.runnerId, runnerId))
      .limit(1);
    return row ? mapProfile(row) : null;
  }

  async findPendingByRunnerName(
    runnerName: string,
  ): Promise<RunnerInstallationProfileRecord | null> {
    await this.ready();
    const [row] = await this.handle.db
      .select()
      .from(pgRunnerInstallationProfiles)
      .where(
        and(
          eq(pgRunnerInstallationProfiles.runnerName, runnerName),
          isNull(pgRunnerInstallationProfiles.runnerId),
        ),
      )
      .orderBy(desc(pgRunnerInstallationProfiles.updatedAt))
      .limit(1);
    return row ? mapProfile(row) : null;
  }

  async upsert(record: RunnerInstallationProfileRecord): Promise<RunnerInstallationProfileRecord> {
    await this.ready();
    const [row] = await this.handle.db
      .insert(pgRunnerInstallationProfiles)
      .values(record)
      .onConflictDoUpdate({
        target: pgRunnerInstallationProfiles.id,
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
      .returning();
    if (!row) throw new Error("PostgreSQL did not return the Runner installation profile.");
    return mapProfile(row);
  }

  async bindPending(input: {
    runnerName: string;
    runnerId: string;
    updatedAt: string;
  }): Promise<void> {
    await this.ready();
    await this.handle.db.transaction(async (transaction) => {
      const [pending] = await transaction
        .select({ id: pgRunnerInstallationProfiles.id })
        .from(pgRunnerInstallationProfiles)
        .where(
          and(
            eq(pgRunnerInstallationProfiles.runnerName, input.runnerName),
            isNull(pgRunnerInstallationProfiles.runnerId),
          ),
        )
        .orderBy(desc(pgRunnerInstallationProfiles.updatedAt))
        .limit(1)
        .for("update");
      if (!pending) return;
      await transaction
        .update(pgRunnerInstallationProfiles)
        .set({ runnerId: input.runnerId, updatedAt: input.updatedAt })
        .where(eq(pgRunnerInstallationProfiles.id, pending.id));
    });
  }
}

function mapProfile(
  row: typeof pgRunnerInstallationProfiles.$inferSelect,
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
