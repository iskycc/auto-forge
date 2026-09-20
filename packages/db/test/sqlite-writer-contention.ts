import Database from "better-sqlite3";
import type { SqliteDatabaseHandle } from "../src/database";

/** A real competing writer that can release its lock only when the repository yields. */
export class SqliteWriterContention {
  private readonly writer: Database.Database;
  private pendingRelease: Promise<void> | undefined;

  constructor(handle: SqliteDatabaseHandle) {
    this.writer = new Database(handle.client.name);
    handle.client.pragma("busy_timeout = 25");
  }

  wrap<Repository extends object>(repository: Repository): Repository {
    return new Proxy(repository, {
      get: (target, property) => {
        const member: unknown = Reflect.get(target, property);
        if (typeof member !== "function") return member;
        return async (...arguments_: unknown[]) => {
          const released = this.holdUntilNextTurn();
          try {
            return await Reflect.apply(member, target, arguments_);
          } finally {
            // Keep direct fixture writes and disposal outside the competing transaction.
            await released;
          }
        };
      },
    });
  }

  async close(): Promise<void> {
    await this.pendingRelease;
    this.writer.close();
  }

  private holdUntilNextTurn(): Promise<void> {
    if (this.pendingRelease) return this.pendingRelease;
    this.writer.exec("BEGIN IMMEDIATE");
    this.pendingRelease = new Promise<void>((resolve, reject) => {
      setImmediate(() => {
        try {
          this.writer.exec("COMMIT");
          resolve();
        } catch (error) {
          reject(error);
        } finally {
          this.pendingRelease = undefined;
        }
      });
    });
    return this.pendingRelease;
  }
}
