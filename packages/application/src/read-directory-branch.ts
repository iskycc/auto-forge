import {
  caseDirectoryPartSchema,
  directoryBranchIndexSchema,
  directoryBranchSchema,
  suiteDirectoryPartSchema,
  type DirectoryBranch,
} from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";

export async function readDirectoryBranch(input: {
  kind: "case_directory" | "suite_directory";
  ordinal: number;
  readPart(ordinal: number): Promise<unknown | null>;
}): Promise<DirectoryBranch> {
  async function requiredPart(ordinal: number) {
    const part = await input.readPart(ordinal);
    if (part === null)
      throw new DomainError("READ_MODEL_GENERATION_CONFLICT", "目录已更新，请重新展开。");
    return part;
  }
  const index = directoryBranchIndexSchema.parse(await requiredPart(input.ordinal));
  const references = new Map<number, typeof index.entries>();
  for (const entry of index.entries) {
    const entries = references.get(entry.ordinal) ?? [];
    entries.push(entry);
    references.set(entry.ordinal, entries);
  }
  const branch: DirectoryBranch = {
    directories: index.directories,
    nextOrdinal: index.nextOrdinal,
    items: [],
    outcomes: [],
    members: { items: [], ddtItems: [] },
  };
  // Release each source chunk after extracting the requested rows; a branch never retains
  // 100 unrelated chunks when its files are spread across the catalog's storage order.
  const selected = new Map<string, Pick<DirectoryBranch, "items" | "outcomes" | "members">>();
  for (const [ordinal, entries] of references) {
    const payload = await requiredPart(ordinal);
    if (input.kind === "case_directory") {
      const chunk = caseDirectoryPartSchema.parse(payload);
      for (const entry of entries) {
        const item = chunk.items[entry.index];
        if (!item) throw new Error("Directory index references a missing case.");
        selected.set(`${ordinal}:${entry.kind}:${entry.index}`, {
          members: { items: [], ddtItems: [] },
          items: [
            {
              id: item.id,
              projectId: item.projectId,
              directoryPath: item.directoryPath,
              displayName: item.displayName,
              className: item.className,
              methodCount: item.methods.length,
            },
          ],
          outcomes: chunk.outcomes.filter((outcome) => outcome.caseDefinitionId === item.id),
        });
      }
    } else {
      const chunk = suiteDirectoryPartSchema.parse(payload);
      for (const entry of entries) {
        const items = entry.kind === "case" ? chunk.items.slice(entry.index, entry.index + 1) : [];
        const ddtItems =
          entry.kind === "ddt" ? chunk.ddtItems.slice(entry.index, entry.index + 1) : [];
        if (items.length + ddtItems.length !== 1)
          throw new Error("Directory index references a missing suite member.");
        selected.set(`${ordinal}:${entry.kind}:${entry.index}`, {
          items: [],
          outcomes: [],
          members: { items, ddtItems },
        });
      }
    }
  }
  for (const entry of index.entries) {
    const row = selected.get(`${entry.ordinal}:${entry.kind}:${entry.index}`)!;
    branch.items.push(...row.items);
    branch.outcomes.push(...row.outcomes);
    branch.members.items.push(...row.members.items);
    branch.members.ddtItems.push(...row.members.ddtItems);
  }
  return directoryBranchSchema.parse(branch);
}
