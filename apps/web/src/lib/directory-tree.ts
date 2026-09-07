import { directoryBranchSchema, type DirectoryBranch } from "@autoforge/contracts";
import { browserCacheEpoch, readBrowserSnapshot, writeBrowserSnapshot } from "./browser-read-cache";
import { directoryResponseError, type DirectoryProjection } from "./directory-projection";

export type DirectorySource = { projection: DirectoryProjection; refresh(): void };
export async function readLazyDirectoryBranch(input: {
  projection: { status: Pick<DirectoryProjection["status"], "id" | "generation"> };
  ordinal: number;
  signal: AbortSignal;
  fetcher?: typeof fetch;
}): Promise<DirectoryBranch> {
  input.signal.throwIfAborted();
  const { status } = input.projection;
  const key = `directory-branch:v1:${status.id}:${status.generation}:${input.ordinal}`;
  const cached = readBrowserSnapshot(key);
  if (cached !== undefined) return directoryBranchSchema.parse(cached);
  const epoch = browserCacheEpoch();
  const response = await (input.fetcher ?? fetch)(
    `/api/v1/read-models/${status.id}/branches?generation=${status.generation}&ordinal=${input.ordinal}`,
    { signal: input.signal, cache: "no-store" },
  );
  if (!response.ok) {
    const error = new Error(await directoryResponseError(response));
    if (response.status === 409) error.name = "DirectoryGenerationConflict";
    throw error;
  }
  const branch = directoryBranchSchema.parse(await response.json());
  input.signal.throwIfAborted();
  writeBrowserSnapshot(key, branch, epoch);
  return branch;
}

export async function collectDirectoryMembers(
  source: DirectorySource,
  ordinal: number,
  signal: AbortSignal,
  kind?: "case" | "ddt",
) {
  const members: DirectoryBranch["members"] = { items: [], ddtItems: [] };
  const pending = [ordinal];
  const visited = new Set<number>();
  while (pending.length) {
    signal.throwIfAborted();
    const current = pending.pop()!;
    if (visited.has(current)) throw new Error("目录索引出现重复引用，请刷新重试。");
    visited.add(current);
    const branch = await readLazyDirectoryBranch({
      projection: source.projection,
      ordinal: current,
      signal,
    });
    members.items.push(...branch.members.items);
    members.ddtItems.push(...branch.members.ddtItems);
    pending.push(
      ...branch.directories
        .filter((item) => !kind || item.kind === kind)
        .map((item) => item.ordinal),
    );
    if (branch.nextOrdinal !== null) pending.push(branch.nextOrdinal);
  }
  return members;
}
