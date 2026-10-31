import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { readPostgresInfrastructureUsage } from "./postgres-infrastructure-usage";
import { readPostgresStorageCapacity } from "./postgres-storage-capacity";
const url = process.env.AUTOFORGE_TEST_POSTGRES_URL;
describe.skipIf(!url)("native PostgreSQL usage", () => {
  it("reports actual database/pool counters separately from filesystem capacity", async () => {
    const pool = new Pool({ connectionString: url, max: 1, statement_timeout: 2000 });
    try {
      const usage = await readPostgresInfrastructureUsage(pool, new Date());
      expect(usage.metrics).toContainEqual(
        expect.objectContaining({ key: "database_bytes", value: expect.any(Number) }),
      );
      expect(
        usage.metrics.find((metric) => metric.key === "database_bytes")!.value,
      ).toBeGreaterThan(0);
      expect(usage.metrics).toContainEqual(
        expect.objectContaining({ key: "pool_total", value: 1 }),
      );
      expect(usage.storage?.status).toMatch(/available|not_configured|permission_denied|stale/);
      if (process.env.AUTOFORGE_TEST_POSTGRES_CAPACITY === "1") {
        const sample = await readPostgresStorageCapacity(pool, new Date());
        expect(sample.status).toBe("available");
        expect(sample.capacityBytes).toBeGreaterThan(sample.availableBytes!);
        expect(sample.availableBytes).toBeGreaterThan(0);
      }
    } finally {
      await pool.end();
    }
  });
});
