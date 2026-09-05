import type { PlatformNodeRepository } from "@autoforge/application";
import { platformNodeSchema, type PlatformNode } from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import type { PostgresDatabaseHandle } from "./postgres-database";

const columns = `id, name, internal_base_url AS "internalBaseUrl", revision,
  created_at AS "createdAt", updated_at AS "updatedAt"`;

export class PostgresPlatformNodeRepository implements PlatformNodeRepository {
  constructor(private readonly handle: PostgresDatabaseHandle) {}

  async register(id: string, now: string): Promise<void> {
    await this.handle.ready;
    await this.handle.pool.query(
      `INSERT INTO platform_nodes (id,name,created_at,updated_at) VALUES ($1,$1,$2,$2)
       ON CONFLICT(id) DO NOTHING`,
      [id, now],
    );
  }

  async find(id: string): Promise<PlatformNode | null> {
    await this.handle.ready;
    const result = await this.handle.pool.query(
      `SELECT ${columns} FROM platform_nodes WHERE id=$1`,
      [id],
    );
    return result.rows[0] ? platformNodeSchema.parse(result.rows[0]) : null;
  }

  async list(afterId?: string) {
    await this.handle.ready;
    const result = await this.handle.pool.query(
      `SELECT ${columns} FROM platform_nodes WHERE ($1::text IS NULL OR id>$1) ORDER BY id LIMIT 101`,
      [afterId ?? null],
    );
    const items = result.rows.slice(0, 100).map((row) => platformNodeSchema.parse(row));
    return { items, ...(result.rows.length > 100 ? { nextCursor: items.at(-1)!.id } : {}) };
  }

  async update(
    id: string,
    input: Pick<PlatformNode, "name" | "internalBaseUrl" | "revision">,
    now: string,
  ) {
    await this.handle.ready;
    const result = await this.handle.pool.query(
      `UPDATE platform_nodes SET name=$2,internal_base_url=$3,revision=revision+1,updated_at=$4
       WHERE id=$1 AND revision=$5 RETURNING ${columns}`,
      [id, input.name, input.internalBaseUrl, now, input.revision],
    );
    if (!result.rows[0])
      throw new DomainError("PLATFORM_NODE_REVISION_CONFLICT", "节点配置已变化，请刷新后重试。");
    return platformNodeSchema.parse(result.rows[0]);
  }
}
