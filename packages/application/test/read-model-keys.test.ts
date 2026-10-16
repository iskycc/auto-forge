import { expect, it } from "vitest";
import { readModelQuerySchema } from "@autoforge/contracts";
import { readModelKey } from "../src/read-model-snapshots";

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
