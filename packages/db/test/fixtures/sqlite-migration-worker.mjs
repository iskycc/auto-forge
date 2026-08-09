import { parentPort, workerData } from "node:worker_threads";

import Database from "better-sqlite3";

import { runSqliteMigrations } from "../../src/migrations.ts";

const { barrierBuffer, databasePath, migrationsFolder, workerCount } = workerData;
const barrier = new Int32Array(barrierBuffer);

const readyWorkers = Atomics.add(barrier, 0, 1) + 1;
Atomics.notify(barrier, 0, workerCount);
while (readyWorkers < workerCount && Atomics.load(barrier, 0) < workerCount) {
  Atomics.wait(barrier, 0, Atomics.load(barrier, 0), 100);
}

const client = new Database(databasePath);
client.pragma("busy_timeout = 10000");

try {
  runSqliteMigrations(client, migrationsFolder);
  parentPort?.postMessage({ status: "ok" });
} catch (error) {
  parentPort?.postMessage({
    status: "error",
    message: error instanceof Error ? error.stack : String(error),
  });
} finally {
  client.close();
}
