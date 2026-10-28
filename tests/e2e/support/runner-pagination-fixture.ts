import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Seed inventory without exhausting the intentionally low Agent registration rate limit. */
export function insertRunnerPaginationFixture(directory: string, prefix: string) {
  const databasePath = resolve(directory, "db", "autoforge.sqlite");
  const database = new DatabaseSync(databasePath);
  const ids = Array.from({ length: 26 }, () => randomUUID());
  const now = new Date().toISOString();
  let transactionStarted = false;
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    const insert = database.prepare(`INSERT INTO runners
      (id,credential_hash,name,os,architecture,agent_version,protocol_version,labels_json,capabilities_json,max_concurrency,busy_slots,last_seen_at,created_at,updated_at)
      VALUES (?,?,?,'linux','amd64','999.0.0',1,?,'[]',2,0,?,?,?)`);
    ids.forEach((id, offset) => {
      const index = offset + 1;
      const labels = [
        ...(index <= 10 ? [`${prefix}-ten`] : []),
        ...(index <= 12 ? [`${prefix}-twelve`] : []),
        ...(index <= 13 ? [`${prefix}-thirteen`] : []),
      ];
      insert.run(
        id,
        `fixture-${id}`,
        `${prefix}-${String(index).padStart(2, "0")}`,
        JSON.stringify(labels),
        now,
        now,
        now,
      );
    });
    database.exec("COMMIT");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
  return {
    runnerIds: ids,
    dispose() {
      const cleanup = new DatabaseSync(databasePath);
      try {
        cleanup.exec("PRAGMA busy_timeout = 5000");
        const remove = cleanup.prepare("DELETE FROM runners WHERE id=?");
        for (const id of ids) remove.run(id);
      } finally {
        cleanup.close();
      }
    },
  };
}
