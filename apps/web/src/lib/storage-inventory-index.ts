import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import {
  storageInventoryItemSchema,
  storageInventorySummarySchema,
  type StorageInventoryItem,
  type StorageInventorySummary,
} from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";

/** Node-local, disposable read index. Business deletion checks never consult this file. */
export class StorageInventoryIndex {
  private readonly database: Database.Database;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new Database(path);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("busy_timeout = 5000");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS inventory_generations_v1 (id TEXT PRIMARY KEY, summary TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS inventory_entries_v1 (generation TEXT NOT NULL, ordinal INTEGER NOT NULL, category TEXT NOT NULL, search_text TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(generation,ordinal));
      CREATE INDEX IF NOT EXISTS inventory_category_v1 ON inventory_entries_v1(generation,category,ordinal);
      CREATE TABLE IF NOT EXISTS inventory_state_v2 (id INTEGER PRIMARY KEY CHECK(id=1), generation TEXT, refresh_after INTEGER NOT NULL DEFAULT 0, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, requested_revision INTEGER NOT NULL DEFAULT 0, lease_revision INTEGER NOT NULL DEFAULT 0);
      INSERT OR IGNORE INTO inventory_state_v2(id) VALUES(1);
    `);
  }
  status() {
    const row = this.database
      .prepare("SELECT generation,refresh_after,failed FROM inventory_state_v2 WHERE id=1")
      .get() as { generation: string | null; refresh_after: number; failed: number };
    return {
      generation: row.generation,
      refreshAfter: row.refresh_after,
      failed: row.failed !== 0,
    };
  }
  invalidate() {
    this.database
      .prepare(
        "UPDATE inventory_state_v2 SET refresh_after=0,failed=0,requested_revision=requested_revision+1 WHERE id=1",
      )
      .run();
  }
  claim(now: number): string | undefined {
    const token = randomUUID();
    const updated = this.database
      .prepare(
        "UPDATE inventory_state_v2 SET lease=?,lease_until=?,lease_revision=requested_revision WHERE id=1 AND refresh_after<=? AND lease_until<=?",
      )
      .run(token, now + 120_000, now, now);
    if (!updated.changes) return undefined;
    this.database
      .prepare("INSERT INTO inventory_generations_v1(id,created_at) VALUES (?,?)")
      .run(token, now);
    return token;
  }
  append(token: string, start: number, items: readonly StorageInventoryItem[], now: number) {
    this.database.transaction(() => {
      if (
        !this.database
          .prepare(
            "UPDATE inventory_state_v2 SET lease_until=? WHERE id=1 AND lease=? AND lease_until>?",
          )
          .run(now + 120_000, token, now).changes
      )
        throw new Error("Storage inventory scan lease expired.");
      const insert = this.database.prepare("INSERT INTO inventory_entries_v1 VALUES (?,?,?,?,?)");
      items.forEach((item, offset) =>
        insert.run(
          token,
          start + offset,
          item.category,
          [
            item.name,
            item.logicalPath,
            item.storagePath,
            item.runBatchId,
            item.projectId,
            item.detail,
          ]
            .join("\n")
            .toLocaleLowerCase("zh-CN"),
          JSON.stringify(item),
        ),
      );
    })();
  }
  publish(token: string, summary: StorageInventorySummary, now: number) {
    this.database.transaction(() => {
      if (
        !this.database
          .prepare(
            "UPDATE inventory_state_v2 SET generation=?,refresh_after=?,lease=NULL,lease_until=0,failed=0 WHERE id=1 AND lease=? AND lease_until>? AND lease_revision=requested_revision",
          )
          .run(token, now + 300_000, token, now).changes
      ) {
        this.database
          .prepare("UPDATE inventory_state_v2 SET lease=NULL,lease_until=0 WHERE lease=?")
          .run(token);
        return;
      }
      this.database
        .prepare("UPDATE inventory_generations_v1 SET summary=? WHERE id=?")
        .run(JSON.stringify(summary), token);
      this.database
        .prepare(
          "DELETE FROM inventory_entries_v1 WHERE generation IN (SELECT id FROM inventory_generations_v1 WHERE created_at<? AND id<>?)",
        )
        .run(now - 600_000, token);
      this.database
        .prepare("DELETE FROM inventory_generations_v1 WHERE created_at<? AND id<>?")
        .run(now - 600_000, token);
    })();
  }
  fail(token: string, now: number) {
    this.database
      .prepare(
        "UPDATE inventory_state_v2 SET lease=NULL,lease_until=0,failed=1,refresh_after=? WHERE lease=?",
      )
      .run(now + 30_000, token);
  }
  page(
    generation: string,
    input: { after: number; limit: number; category?: string; query?: string },
  ) {
    const row = this.database
      .prepare("SELECT summary FROM inventory_generations_v1 WHERE id=? AND summary IS NOT NULL")
      .get(generation) as { summary: string } | undefined;
    if (!row)
      throw new DomainError(
        "READ_MODEL_GENERATION_CONFLICT",
        "存储清单已更新或请求到达另一平台节点，请重新扫描或使用该节点地址访问。",
      );
    const where = ["generation=?", "ordinal>?"];
    const parameters: Array<string | number> = [generation, input.after];
    if (input.category) {
      where.push("category=?");
      parameters.push(input.category);
    }
    if (input.query?.trim()) {
      where.push("instr(search_text,?)>0");
      parameters.push(input.query.trim().toLocaleLowerCase("zh-CN"));
    }
    const rows = this.database
      .prepare(
        `SELECT ordinal,payload FROM inventory_entries_v1 WHERE ${where.join(" AND ")} ORDER BY ordinal LIMIT ?`,
      )
      .all(...parameters, input.limit + 1) as Array<{ ordinal: number; payload: string }>;
    const selected = rows.slice(0, input.limit);
    return {
      items: selected.map((item) => storageInventoryItemSchema.parse(JSON.parse(item.payload))),
      summary: storageInventorySummarySchema.parse(JSON.parse(row.summary)),
      nextOrdinal: rows.length > input.limit ? selected.at(-1)?.ordinal : undefined,
    };
  }
  close() {
    this.database.close();
  }
}
