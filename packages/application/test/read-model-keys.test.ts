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
