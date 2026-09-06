import { directoryBranchIndexSchema, type DirectoryNode } from "@autoforge/contracts";
import type { ReadModelBuilder } from "./read-model-snapshots";

type Entry = { ordinal: number; index: number; kind: "case" | "ddt"; name: string };
type Branch = {
  name: string;
  path: string;
  kind: "case" | "ddt";
  caseCount: number;
  children: Map<string, Branch>;
  entries: Entry[];
};

/** Retains small references, never full case definitions, while the worker streams the catalog. */
export class DirectorySnapshotIndex {
  private readonly root: Branch = {
    name: "",
    path: "",
    kind: "case",
    caseCount: 0,
    children: new Map(),
    entries: [],
  };

  add(segments: string[], entry: Entry): void {
    let branch = this.root;
    branch.caseCount++;
    for (const name of segments) {
      const key = `${entry.kind}:${name}`;
      let child = branch.children.get(key);
      if (!child) {
        child = {
          name,
          path: branch.path ? `${branch.path}/${name}` : name,
          kind: entry.kind,
          caseCount: 0,
          children: new Map(),
          entries: [],
        };
        branch.children.set(key, child);
      }
      child.caseCount++;
      branch = child;
    }
    branch.entries.push(entry);
  }

  async write(firstOrdinal: number, writePart: Parameters<ReadModelBuilder>[1]): Promise<number> {
    let ordinal = firstOrdinal;
    async function writeBranch(branch: Branch): Promise<number> {
      const directories: DirectoryNode[] = [];
      for (const child of [...branch.children.values()].sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        directories.push({
          name: child.name,
          path: child.path,
          kind: child.kind,
          caseCount: child.caseCount,
          ordinal: await writeBranch(child),
        });
      }
      branch.entries.sort((a, b) => a.name.localeCompare(b.name));
      const rootOrdinal = ordinal;
      const count = directories.length + branch.entries.length;
      for (let start = 0; start < Math.max(count, 1); start += 100) {
        const end = Math.min(count, start + 100);
        const payload = directoryBranchIndexSchema.parse({
          directories: directories.slice(start, end),
          entries: branch.entries.slice(
            Math.max(0, start - directories.length),
            Math.max(0, end - directories.length),
          ),
          nextOrdinal: end < count ? ordinal + 1 : null,
        });
        await writePart(ordinal++, payload);
      }
      return rootOrdinal;
    }
    return writeBranch(this.root);
  }
}
