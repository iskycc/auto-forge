import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const matrixPath = resolve(repositoryRoot, "tests/e2e/coverage-matrix.json");
const matrix = JSON.parse(await readFile(matrixPath, "utf8"));
const expectedIds = Array.from(
  { length: 18 },
  (_, index) => `AF-E2E-${String(index + 1).padStart(3, "0")}`,
);
const allowedStates = new Set(["covered", "partial", "planned", "not-applicable"]);

if (matrix.schemaVersion !== 1) fail("Unsupported E2E matrix schemaVersion.");
if (!Array.isArray(matrix.dimensions) || matrix.dimensions.length === 0) {
  fail("E2E matrix dimensions are missing.");
}
const items = new Map(matrix.items.map((item) => [item.id, item]));
for (const id of expectedIds) {
  const item = items.get(id);
  if (!item) fail(`E2E matrix is missing ${id}.`);
  if (!allowedStates.has(item.status)) fail(`${id} has invalid status ${item.status}.`);
  for (const dimension of matrix.dimensions) {
    if (!allowedStates.has(item.coverage?.[dimension])) {
      fail(`${id} has no valid ${dimension} coverage state.`);
    }
  }
  if (item.status === "covered" && item.evidence.length === 0) {
    fail(`${id} is covered without evidence.`);
  }
  for (const evidence of item.evidence) {
    const evidencePath = resolve(repositoryRoot, evidence);
    if (!evidencePath.startsWith(`${repositoryRoot}/`)) fail(`${id} evidence escapes repository.`);
    await access(evidencePath).catch(() => fail(`${id} evidence does not exist: ${evidence}`));
  }
}
if (items.size !== expectedIds.length) fail("E2E matrix contains unknown or duplicate item IDs.");

process.stdout.write(`Validated ${expectedIds.length} E2E coverage rows.\n`);

function fail(message) {
  throw new Error(message);
}
