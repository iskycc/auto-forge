import { expect, it } from "vitest";
import { readModelQuerySchema } from "@autoforge/contracts";
import { readModelKey } from "../src/read-model-snapshots";
import { executionOverviewQuery } from "../src/read-execution-overview";

it.each(["queued", "running"] as const)(
  "keeps %s progress and page statistics on one stable current-version query",
  (status) => {
    const batch = { id: "batch", projectId: "project", status, version: 1 };
    const query = executionOverviewQuery(batch);
    expect(query).toMatchObject({ kind: "execution_overview", snapshotVersion: 3 });
    expect(query).not.toHaveProperty("terminalVersion");
    expect(readModelKey(query)).toBe(
      readModelKey(executionOverviewQuery({ ...batch, version: 2 })),
    );
  },
);

it.each(["succeeded", "failed", "cancelled"] as const)(
  "refreshes %s progress and page statistics when the authoritative batch version changes",
  (status) => {
    const batch = { id: "batch", projectId: "project", status, version: 1 };
    const query = executionOverviewQuery(batch);
    expect(readModelQuerySchema.parse(query)).toMatchObject({
      snapshotVersion: 3,
      terminalVersion: 1,
    });
    expect(readModelKey(query)).not.toBe(
      readModelKey(executionOverviewQuery({ ...batch, version: 2 })),
    );
  },
);

it("keeps class-path sorted case snapshots separate from legacy name-sorted snapshots", () => {
  const legacyQuery = readModelQuerySchema.parse({
    kind: "execution_case_page",
    projectId: "project",
    batchId: "batch",
    terminalVersion: 3,
    filter: { scope: "summary", sort: "name", direction: "asc", offset: 0, limit: 50 },
  });
  const classPathQuery = readModelQuerySchema.parse({ ...legacyQuery, snapshotVersion: 2 });
  expect(readModelKey(classPathQuery)).not.toBe(readModelKey(legacyQuery));
});

it("rebuilds overview and list counters after final-outcome selection changes", () => {
  const overview = { kind: "execution_overview", projectId: "project", batchId: "batch" };
  const legacyOverview = readModelQuerySchema.parse({ ...overview, snapshotVersion: 2 });
  const currentOverview = readModelQuerySchema.parse({ ...overview, snapshotVersion: 3 });
  expect(readModelKey(currentOverview)).not.toBe(readModelKey(legacyOverview));

  const counters = {
    kind: "batch_counters",
    projectId: "project",
    batches: [{ id: "batch", projectId: "project", terminalVersion: 3 }],
  };
  const legacyCounters = readModelQuerySchema.parse(counters);
  const currentCounters = readModelQuerySchema.parse({ ...counters, snapshotVersion: 2 });
  expect(readModelKey(currentCounters)).not.toBe(readModelKey(legacyCounters));
});
